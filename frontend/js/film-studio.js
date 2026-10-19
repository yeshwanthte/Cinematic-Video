// Film Studio — plan a 10–30 s film, generate it shot by shot on free models, assemble in the browser.
//
// Honest-by-design:
//  • every shot is ONE real AI clip, never longer than the model's native maximum;
//  • a "continue" shot starts from the previous clip's real last frame (extracted here);
//  • the final film is assembled (cuts / crossfades / music) by ffmpeg.wasm and labelled as such.
import { StudioApi, ERROR_TITLES } from './api-client.js';
import { settingsStore, imageStore, uid } from './storage.js';
import { loadImageFile, prepareForGeneration, fmtBytes, ImageError } from './image-tools.js';
import { parseQuotaError, explainQuota, lastQuota } from './quota.js';
import { CAMERA, PROTECTIONS, INTENSITY, byId } from './motion-catalog.js';
import { FILM_PRESETS, planShots, shotPrompt } from './shot-planner.js';
import { gpuSeconds, gpuTally } from './gpu-estimate.js';
import { assembleFilm, extractLastFrame } from './assembler.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const api = new StudioApi(() => settingsStore.load({ apiBase: window.STUDIO_CONFIG?.apiBase || '', accessCode: '', timeoutMin: 15 }));
const LS = 'cas.films.v1';
const LENGTHS = [0, 10, 15, 20, 30]; // 0 = single shot
const TRANSITIONS = [
  { id: 'crossfade', label: 'Crossfade' },
  { id: 'dip', label: 'Dip to black' },
  { id: 'cut', label: 'Hard cut' },
];
const NEG_IDS = ['face', 'identity', 'limbs', 'flicker', 'distortion', 'unnatural'];
const MAX_MUSIC = 25 * 1024 * 1024;

const st = {
  catalog: null,
  films: [],
  film: null,
  busy: false, // a shot is generating
  stop: false,
  abort: null,
  exporting: null, // AbortController
  urls: new Map(),
  bound: false,
};

// ------------------------------------------------------------------ persistence
function loadFilms() {
  try {
    st.films = JSON.parse(localStorage.getItem(LS) || '[]');
  } catch {
    st.films = [];
  }
  // A reload interrupts a running shot — say so instead of showing it as still running.
  // v2: continued shots join with a seamless cut — a crossfade overlays two frames (ghosting).
  for (const f of st.films) {
    if ((f.v || 1) < 2) for (const s of f.shots || []) if (s.continuity === 'continue' && (!s.transition || s.transition === 'crossfade')) s.transition = 'cut';
    f.v = 2;
  }
  for (const f of st.films) for (const s of f.shots || []) if (['queued', 'running'].includes(s.status)) Object.assign(s, { status: 'failed', error: { title: 'Interrupted', message: 'The page was reloaded while this shot was generating. Generate it again.' } });
}
function save() {
  if (st.film) st.film.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(LS, JSON.stringify(st.films));
  } catch (e) {
    toast('Could not save the film', String(e.message || e));
  }
}
function newFilm() {
  const f = {
    id: uid('film'),
    v: 2,
    title: 'Untitled film',
    createdAt: new Date().toISOString(),
    source: 'photo',
    hasPhoto: false,
    idea: '',
    preset: 'travel',
    targetSeconds: 15,
    intensity: 'balanced',
    model: 'wan2.2-long',
    ratio: '832:480',
    quality: 'balanced',
    bible: { subject: '', wardrobe: '', setting: '', lighting: '', look: '', intensity: 'balanced' },
    shots: [],
    export: { transition: 'crossfade', transitionSeconds: 0.5, outSize: 'native', outFps: 'native', interpolate: false, fadeEdges: true, keepOrig: true, origVol: 1, music: null, last: null },
  };
  st.films.unshift(f);
  return f;
}

// ------------------------------------------------------------------ helpers
function toast(title, msg = '', kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<b>${esc(title)}</b>${msg ? `<span>${esc(msg)}</span>` : ''}`;
  $('#toasts')?.appendChild(el);
  setTimeout(() => el.remove(), 6500);
}
// Every FREE provider's models (Hugging Face Spaces + your own Modal app). Paid providers are never used here.
function freeProviders() {
  return Object.entries(st.catalog?.providers || {}).filter(([, p]) => p.free);
}
function streamModels() {
  return freeProviders().flatMap(([pid, p]) => Object.entries(p.models).map(([id, m]) => ({ id, provider: pid, providerLabel: p.label, configured: p.configured, ...m })));
}
const providerOf = (modelId) => freeProviders().find(([, p]) => p.models[modelId])?.[0] || null;
const capsOf = (id) => {
  const pid = providerOf(id);
  return pid ? st.catalog.providers[pid].models[id] : null;
};
function shotModel(shot) {
  return capsOf(shot.model) ? shot.model : st.film.model;
}
function ratioFor(caps, filmRatio) {
  if (caps.ratios.some((r) => r.value === filmRatio)) return filmRatio;
  const want = filmCaps()?.ratios.find((r) => r.value === filmRatio)?.aspect || '16:9';
  return (caps.ratios.find((r) => r.aspect === want) || caps.ratios[0]).value;
}
const filmCaps = () => capsOf(st.film?.model);
function shotGpu(shot) {
  const c = capsOf(shotModel(shot));
  return c ? gpuSeconds(c, { ratio: ratioFor(c, st.film.ratio), duration: shot.duration, quality: st.film.quality }) || 0 : 0;
}
function errInfo(e) {
  const code = e?.code || 'INTERNAL';
  const message = String(e?.message || e || 'Unknown error');
  const quota = code === 'QUOTA_EXCEEDED' ? parseQuotaError(message) : null;
  return { code, title: ERROR_TITLES[code] || 'Generation failed.', message, hint: quota ? explainQuota(quota) : '' };
}
async function blobUrl(key) {
  if (st.urls.has(key)) return st.urls.get(key);
  const b = await imageStore.get(key);
  if (!b) return null;
  const u = URL.createObjectURL(b);
  st.urls.set(key, u);
  return u;
}
function dropUrl(key) {
  const u = st.urls.get(key);
  if (u) URL.revokeObjectURL(u);
  st.urls.delete(key);
}
const fmtS = (n) => `${Number(n || 0).toFixed(Number.isInteger(Number(n)) ? 0 : 1)} s`;

// ------------------------------------------------------------------ catalog
async function loadCatalog() {
  try {
    st.catalog = await api.models();
  } catch {
    try {
      st.catalog = await (await fetch('models.json')).json();
    } catch {
      st.catalog = null;
    }
  }
}

// ------------------------------------------------------------------ render: idea panel
function renderIdea() {
  const f = st.film;
  $('#fsFilmSelect').innerHTML = st.films.map((x) => `<option value="${x.id}" ${x.id === f.id ? 'selected' : ''}>${esc(x.title || 'Untitled film')}</option>`).join('');
  $('#fsTitle').value = f.title;
  $$('#fsSource [data-src]').forEach((b) => b.classList.toggle('on', b.dataset.src === f.source));
  $('#fsPhotoBox').hidden = f.source !== 'photo';
  $('#fsIdea').value = f.idea;
  $('#fsPresets').innerHTML = Object.entries(FILM_PRESETS)
    .map(([id, p]) => `<button class="chip ${id === f.preset ? 'on' : ''}" data-preset="${id}">${esc(p.label)}</button>`)
    .join('');
  const c = filmCaps();
  const max = c?.durations.max || 5;
  $('#fsLength').innerHTML = LENGTHS.map((L) => {
    const secs = L || max;
    const clips = Math.ceil(secs / max);
    const label = L ? `${L} s` : `Single shot`;
    return `<button data-len="${L}" class="${(f.targetSeconds || 0) === L ? 'on' : ''}">${label}<small>${clips} clip${clips > 1 ? 's' : ''}</small></button>`;
  }).join('');
  $('#fsIntensity').innerHTML = Object.entries(INTENSITY).map(([id, v]) => `<button data-fint="${id}" class="${id === f.intensity ? 'on' : ''}">${esc(v.label)}</button>`).join('');
  const needT2v = f.source === 'text';
  $('#fsModels').innerHTML = streamModels()
    .map((m) => {
      const ok = !needT2v || (m.modes || ['i2v']).includes('t2v');
      const tags = [`≤${m.durations.max} s/clip`, `${m.fps} fps`, [...new Set(m.ratios.map((r) => r.resolution))].join('/'), (m.modes || []).includes('t2v') ? 'text→video' : 'photo→video', m.nativeAudio ? 'AI audio' : 'silent', m.license || ''];
      if (m.configured === false && m.provider !== 'huggingface') tags.unshift('not set up');
      return `<button class="model ${m.id === f.model ? 'on' : ''} ${ok ? '' : 'off-fit'}" data-fmodel="${m.id}" ${ok ? '' : 'disabled title="This model needs a photo"'}><div class="top"><b>${esc(m.label)}</b><span class="q">${esc(m.quality)}</span></div><div class="specs">${tags.filter(Boolean).map((t) => `<span>${esc(t)}</span>`).join('')}</div></button>`;
    })
    .join('') || '<p class="warn">Model list unavailable — check Settings → Backend.</p>';
  if (c) {
    if (!c.ratios.some((r) => r.value === f.ratio)) f.ratio = c.ratios[0].value;
    $('#fsRatio').innerHTML = c.ratios.map((r) => `<button data-fratio="${r.value}" class="${r.value === f.ratio ? 'on' : ''}">${r.aspect}<small>${r.value.replace(':', '×')}</small></button>`).join('');
    const qs = c.qualityPresets || [];
    if (!qs.some((q) => q.id === f.quality)) f.quality = c.defaultQuality || qs[0]?.id;
    $('#fsQuality').innerHTML = qs.map((q) => `<button data-fq="${q.id}" class="${q.id === f.quality ? 'on' : ''}" title="${esc(q.note || '')}">${esc(q.label)}</button>`).join('');
    const notes = [];
    notes.push(`${c.label}: each clip is up to ${c.durations.max} s of native AI video at ${c.fps} fps.`);
    if (f.targetSeconds > c.durations.max) notes.push(`A ${f.targetSeconds} s film is assembled from ${Math.ceil(f.targetSeconds / c.durations.max)} clips.`);
    if (c.nativeAudio) notes.push('Generates its own audio with the video.');
    if (c.license && c.license !== 'Apache-2.0') notes.push(`License: ${c.license} — free under US$10M annual revenue; disclose output as AI-generated.`);
    if (f.source === 'photo' && (c.modes || []).includes('t2v') && !(c.modes || []).includes('i2v')) notes.push('This model ignores photos.');
    if (c.id === 'ltx-2.3' || f.model === 'ltx-2.3') notes.push('For the most faithful faces from a photo, Wan 2.2 is stronger.');
    $('#fsModelNote').textContent = notes.join(' ');
  }
  renderPhoto();
}
async function renderPhoto() {
  const f = st.film;
  const url = f.hasPhoto ? await blobUrl(`film_src_${f.id}`) : null;
  $('#fsPhoto').hidden = !url;
  if (url) $('#fsPhoto').src = url;
  $('#fsDropText').textContent = url ? 'Photo the film starts from (click to replace)' : 'Drop the photo the film starts from';
}

// ------------------------------------------------------------------ render: plan
const STATUS_LABEL = { idle: 'Not generated', queued: 'Queued', running: 'Generating', done: 'Ready', failed: 'Failed', cancelled: 'Cancelled' };
function shotStatus(s, i) {
  if (s.status === 'done' && s.outdated) return { cls: 'stale', text: 'Start frame changed' };
  return { cls: s.status || 'idle', text: STATUS_LABEL[s.status || 'idle'] };
}
function renderPlan() {
  const f = st.film;
  for (const el of $$('[data-bible]')) el.value = f.bible?.[el.dataset.bible] || '';
  $('#fsBible').hidden = !f.shots.length;
  const done = f.shots.filter((s) => s.status === 'done').length;
  $('#fsPlanBadge').textContent = f.shots.length ? `${done}/${f.shots.length} shots ready` : 'No plan yet';
  $('#fsPlanBadge').className = `badge ${done && done === f.shots.length ? 'live' : ''}`;
  renderTimeline();
  $('#fsShots').innerHTML = f.shots.map((s, i) => shotCard(s, i)).join('');
  for (const s of f.shots) if (s.status === 'done') attachShotMedia(s);
  $('#fsAddShot').hidden = !f.shots.length;
  $('#fsGenerateAll').disabled = !f.shots.length || st.busy;
  $('#fsGenerateAll').textContent = done ? (done === f.shots.length ? 'Regenerate all shots' : 'Generate remaining shots') : 'Approve plan & generate shots';
  $('#fsStop').hidden = !st.busy;
  renderExportState();
}
function renderTimeline() {
  const f = st.film;
  const total = f.shots.reduce((a, s) => a + Number(s.duration || 0), 0);
  $('#fsTimeline').hidden = !f.shots.length;
  $('#fsTimeline').innerHTML = f.shots
    .map((s, i) => {
      const ss = shotStatus(s, i);
      return `<button class="fs-seg ${ss.cls}" style="flex:${s.duration}" data-seg="${i}" title="Shot ${i + 1}: ${esc(s.title)} · ${s.duration} s · ${ss.text}"><b>${i + 1}</b><span>${esc(s.title)}</span><small>${s.duration}s</small>${s.status === 'running' ? `<i style="width:${Math.round((s.progress || 0) * 100)}%"></i>` : ''}</button>`;
    })
    .join('');
  if (!f.shots.length) return ($('#fsTimelineNote').textContent = '');
  const maxNative = Math.max(...f.shots.map((s) => capsOf(shotModel(s))?.durations.max || 0));
  const pending = f.shots.filter((s) => s.status !== 'done' || s.outdated);
  const gpu = pending.filter((s) => providerOf(shotModel(s)) === 'huggingface').reduce((a, s) => a + shotGpu(s), 0);
  const modalShots = pending.filter((s) => providerOf(shotModel(s)) === 'modal').length;
  const daily = st.catalog?.providers?.huggingface?.quota?.freeSecondsPerDay || 300;
  const q = lastQuota();
  const parts = [
    `${f.shots.length} AI clip${f.shots.length > 1 ? 's' : ''} · ${fmtS(total)} of native AI video${f.shots.length > 1 ? ` → about ${fmtS(Math.max(0, total - (f.shots.length - 1) * (f.export.transitionSeconds || 0.5)))} assembled with crossfades` : ''}. Longest single clip: ${maxNative} s (model limit).`,
    gpu ? `Remaining shots reserve ≈${gpu} s of ZeroGPU time (free accounts: ${daily} s/day${q?.left != null ? `; Hugging Face last reported ${q.left} s left` : ''}).` : '',
    modalShots ? `${modalShots} shot${modalShots > 1 ? 's' : ''} on your Modal GPU: roughly US$${(0.1 * modalShots + 0.3).toFixed(2)} of your US$30 monthly credits (estimate; consecutive shots reuse the warm GPU).` : '',
  ];
  $('#fsTimelineNote').textContent = parts.filter(Boolean).join(' ');
  const warn = gpu > daily ? `This plan needs more GPU time than a free account gets in one day (${gpu} s vs ${daily} s). Generate part today and the rest tomorrow, use shorter shots or Fast quality, or a PRO account (40 min/day).` : '';
  $('#fsPlanWarn').hidden = !warn;
  $('#fsPlanWarn').textContent = warn;
}
function shotCard(s, i) {
  const f = st.film;
  const mId = shotModel(s);
  const c = capsOf(mId);
  const ss = shotStatus(s, i);
  const durs = c ? Array.from({ length: c.durations.max - c.durations.min + 1 }, (_, k) => c.durations.min + k) : [s.duration];
  const t2vOk = (c?.modes || []).includes('t2v');
  const i2vOk = (c?.modes || ['i2v']).includes('i2v');
  const cont = [
    i > 0 && i2vOk ? ['continue', 'Continue from previous shot’s last frame'] : null,
    f.hasPhoto && i2vOk ? ['photo', 'Start from my photo'] : null,
    t2vOk ? ['text', 'New shot from text'] : null,
  ].filter(Boolean);
  if (!cont.some(([v]) => v === s.continuity) && cont.length) s.continuity = cont[0][0];
  const models = streamModels()
    .map((m) => `<option value="${m.id}" ${m.id === s.model ? 'selected' : ''}>${esc(m.label)}</option>`)
    .join('');
  const prompt = shotPrompt(s, f.bible, { isFirst: i === 0 });
  const err = s.status === 'failed' && s.error ? `<div class="fs-err"><b>${esc(s.error.title)}</b><span>${esc(s.error.message)}</span>${s.error.hint ? `<span class="muted">${esc(s.error.hint)}</span>` : ''}</div>` : '';
  const stale = s.status === 'done' && s.outdated ? '<p class="warn">The previous shot was regenerated, so this shot no longer starts on its exact last frame. Regenerate it for a seamless join, or keep it and use a crossfade.</p>' : '';
  return `<li class="fs-shot ${ss.cls}" data-shot="${s.id}">
    <div class="fs-media">
      <span class="num">${i + 1}</span>
      <video muted loop playsinline preload="metadata" data-clip="${s.id}" ${s.status === 'done' ? '' : 'hidden'}></video>
      <div class="fs-ph" ${s.status === 'done' ? 'hidden' : ''}>${s.status === 'running' ? `<span class="spin"></span><small>${esc(s.note || 'Generating…')}</small>${s.progress != null ? `<div class="bar"><span style="width:${Math.round(s.progress * 100)}%"></span></div>` : ''}` : `<small>${esc(ss.text)}</small>`}</div>
      <span class="fs-state ${ss.cls}">${esc(ss.text)}</span>
    </div>
    <div class="fs-fields">
      <label class="wide">Title<input class="input" data-f="title" value="${esc(s.title)}" maxlength="60" /></label>
      <label class="wide">Action<textarea data-f="action" rows="2" maxlength="400">${esc(s.action)}</textarea></label>
      <label>Camera<select class="input" data-f="camera">${CAMERA.map((cm) => `<option value="${cm.id}" ${cm.id === s.camera ? 'selected' : ''}>${esc(cm.label)}</option>`).join('')}</select></label>
      <label>Length<select class="input" data-f="duration">${durs.map((d) => `<option value="${d}" ${d === Number(s.duration) ? 'selected' : ''}>${d} s</option>`).join('')}</select></label>
      <label>Model<select class="input" data-f="model"><option value="" ${!s.model ? 'selected' : ''}>Film default</option>${models}</select></label>
      <label class="wide">Starts from<select class="input" data-f="continuity">${cont.map(([v, l]) => `<option value="${v}" ${v === s.continuity ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${i > 0 ? `<label>Transition in<select class="input" data-f="transition">${TRANSITIONS.map((t) => `<option value="${t.id}" ${t.id === (s.transition || (s.continuity === 'continue' ? 'cut' : 'crossfade')) ? 'selected' : ''}>${t.id === 'cut' && s.continuity === 'continue' ? 'Seamless cut (recommended)' : t.label}</option>`).join('')}</select></label>` : ''}
      <details class="wide fs-prompt"><summary>Exact prompt sent (${prompt.length} chars)</summary><p>${esc(prompt)}</p></details>
      ${err}${stale}
      <div class="wide row gap-s wrap fs-actions">
        <button class="btn btn-ghost btn-s" data-act="gen" ${st.busy ? 'disabled' : ''}>${s.status === 'done' ? 'Regenerate shot' : 'Generate shot'}</button>
        <span class="muted small">≈${shotGpu(s)} s GPU · ${c ? `${c.fps} fps` : ''}${s.status === 'done' && s.clipDuration ? ` · clip ${s.clipDuration.toFixed(2)} s${s.hasAudio ? ' · AI audio' : ''}${s.seedUsed != null ? ` · seed ${s.seedUsed}` : ''}` : ''}</span>
        <span class="grow"></span>
        <button class="btn btn-ghost btn-s" data-act="up" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button class="btn btn-ghost btn-s" data-act="down" ${i === f.shots.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button class="btn btn-ghost btn-s" data-act="del" ${st.busy ? 'disabled' : ''}>Remove</button>
      </div>
    </div>
  </li>`;
}
async function attachShotMedia(s) {
  const v = $(`video[data-clip="${s.id}"]`);
  if (!v) return;
  const url = await blobUrl(`film_clip_${s.id}`);
  if (url) {
    v.src = url;
    v.hidden = false;
  }
}

// ------------------------------------------------------------------ render: export
function outSizes() {
  const r = st.film.ratio.split(':').map(Number);
  const ar = r[0] / r[1];
  const size = (short) => (ar >= 1 ? [even(short * ar), short] : [short, even(short / ar)]);
  return [
    { id: 'native', label: 'Native', note: 'as generated' },
    { id: '720', label: '720p', wh: size(720), note: 'resize · no new detail' },
    { id: '1080', label: '1080p', wh: size(1080), note: 'resize · no new detail' },
  ];
}
const even = (n) => Math.round(n / 2) * 2;
function renderExportState() {
  const f = st.film;
  const e = f.export;
  const done = f.shots.filter((s) => s.status === 'done');
  $('#fsTransition').innerHTML = TRANSITIONS.map((t) => `<button data-ftrans="${t.id}" class="${t.id === e.transition ? 'on' : ''}">${t.label}</button>`).join('');
  $('#fsTransSec').value = e.transitionSeconds;
  $('#fsTransSecVal').textContent = `${Number(e.transitionSeconds).toFixed(1)} s`;
  $('#fsOutSize').innerHTML = outSizes().map((o) => `<button data-fsize="${o.id}" class="${o.id === e.outSize ? 'on' : ''}" title="${esc(o.note)}">${o.label}${o.wh ? `<small>${o.wh.join('×')}</small>` : ''}</button>`).join('');
  $('#fsOutFps').innerHTML = ['native', 24, 30].map((v) => `<button data-ffps="${v}" class="${String(v) === String(e.outFps) ? 'on' : ''}">${v === 'native' ? 'Native' : `${v} fps`}</button>`).join('');
  $('#fsInterp').checked = Boolean(e.interpolate);
  $('#fsInterp').disabled = e.outFps === 'native';
  $('#fsFadeEdges').checked = e.fadeEdges !== false;
  const anyAudio = done.some((s) => s.hasAudio);
  $('#fsOrigAudio').checked = e.keepOrig !== false;
  $('#fsOrigAudio').disabled = !anyAudio;
  $('#fsOrigNote').textContent = anyAudio ? '(LTX-2.3 shots carry audio the model generated)' : '(none of the clips has audio — Wan 2.2 is silent)';
  $('#fsMusicName').textContent = e.music ? `${e.music.name} · ${fmtBytes(e.music.bytes)} — your track (not AI)` : 'No music — your own track, MP3/M4A/WAV/OGG, max 25 MB';
  $('#fsMusicRemove').hidden = !e.music;
  $('#fsMix').hidden = !e.music && !anyAudio;
  $('#fsMusVol').value = e.music?.volume ?? 0.7;
  $('#fsMusIn').value = e.music?.fadeIn ?? 1;
  $('#fsMusOut').value = e.music?.fadeOut ?? 2;
  $('#fsOrigVol').value = e.origVol ?? 1;
  $('#fsMusVolVal').textContent = `${Math.round(($('#fsMusVol').value || 0) * 100)}%`;
  $('#fsMusInVal').textContent = `${$('#fsMusIn').value} s`;
  $('#fsMusOutVal').textContent = `${$('#fsMusOut').value} s`;
  $('#fsOrigVolVal').textContent = `${Math.round(($('#fsOrigVol').value || 0) * 100)}%`;
  $$('#fsMix label').forEach((l) => (l.hidden = !e.music && !l.contains($('#fsOrigVol'))));
  $('#fsExport').disabled = !done.length || Boolean(st.exporting);
  $('#fsExport').textContent = done.length && done.length < f.shots.length ? `Export ${done.length} finished shot${done.length > 1 ? 's' : ''}` : 'Export MP4';
  $('#fsExportBadge').textContent = st.exporting ? 'Exporting…' : e.last ? `Exported ${fmtS(e.last.seconds)}` : done.length ? `${done.length} clip${done.length > 1 ? 's' : ''} ready` : 'Waiting for shots';
  $('#fsExportBadge').className = `badge ${e.last && !st.exporting ? 'live' : ''}`;
  renderFinal();
}
async function renderFinal() {
  const e = st.film.export;
  const url = e.last ? await blobUrl(`film_out_${st.film.id}`) : null;
  $('#fsFinal').hidden = !url;
  if (!url) return;
  if ($('#fsFinalVideo').src !== url) $('#fsFinalVideo').src = url;
  $('#fsFinalSummary').innerHTML = (e.last.summary || []).map((l) => `<li>${esc(l)}</li>`).join('') + `<li>MP4 · H.264${e.last.hasAudio ? ' + AAC' : ', no audio track'} · ${e.last.width}×${e.last.height} · ${e.last.fps} fps · ${fmtBytes(e.last.bytes)}</li>`;
}
function renderUsage() {
  const t = gpuTally.get();
  const q = lastQuota();
  const daily = st.catalog?.providers?.huggingface?.quota?.freeSecondsPerDay || 300;
  const pct = Math.min(100, Math.round((t.reserved / daily) * 100));
  $('#fsUsage').innerHTML = `<div class="fs-meter"><span style="width:${pct}%"></span></div>
    <span><b>Free GPU today</b> · this browser has reserved ≈${t.reserved} s in ${t.runs} run${t.runs === 1 ? '' : 's'} (of ${daily} s on a free account; Hugging Face charges only what was actually used).</span>
    ${q ? `<span class="muted">Hugging Face last reported <b>${q.left != null ? `${q.left} s left` : 'no time left'}</b>${q.resetAt ? ` · resets ≈ ${new Date(q.resetAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''}.</span>` : '<span class="muted">Exact remaining time is only known when Hugging Face reports it.</span>'}`;
}
function renderAll() {
  if (!st.film) return;
  renderIdea();
  renderPlan();
  renderUsage();
}

// ------------------------------------------------------------------ planning
function plan() {
  const f = st.film;
  const c = filmCaps();
  if (!c) return toast('No model available', 'Check Settings → Backend.');
  if (f.source === 'photo' && !f.hasPhoto) return toast('Add a photo first', 'Or switch the source to “Text only” with a text-to-video model.');
  if (f.source === 'text' && !(c.modes || []).includes('t2v')) return toast(`${c.label} needs a photo`, 'Choose LTX-2.3 for text-only films.');
  if (f.shots.some((s) => s.status === 'done') && !confirm('Replace the current shot plan? Generated clips of this film will be removed.')) return;
  for (const s of f.shots) removeShotMedia(s);
  const target = f.targetSeconds || c.durations.max;
  const p = planShots({ idea: f.idea, preset: f.preset, targetSeconds: target, maxClip: c.durations.max, minClip: c.durations.min, source: f.source, intensity: f.intensity });
  f.bible = p.bible;
  f.shots = p.shots.map((s) => ({ ...s, model: '', status: 'idle' }));
  f.export.last = null;
  imageStore.remove(`film_out_${f.id}`);
  dropUrl(`film_out_${f.id}`);
  save();
  renderPlan();
  toast('Shot plan ready', 'Edit any shot, then press “Approve plan & generate shots”.', 'ok');
  $('#fsPlanPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function removeShotMedia(s) {
  for (const k of [`film_clip_${s.id}`, `film_frame_${s.id}`]) {
    imageStore.remove(k);
    dropUrl(k);
  }
}

// ------------------------------------------------------------------ generation
async function bitmapFromBlob(blob) {
  return createImageBitmap(blob);
}
async function inputImageFor(shot, i, caps, ratio) {
  const f = st.film;
  if (shot.continuity === 'text') return null;
  if (shot.continuity === 'continue') {
    const prev = f.shots[i - 1];
    const frame = prev && prev.status === 'done' ? await imageStore.get(`film_frame_${prev.id}`) : null;
    if (!frame) throw Object.assign(new Error(`Shot ${i} must be generated first — this shot starts from its last frame.`), { code: 'INVALID_REQUEST' });
    return (await prepareForGeneration(`frame_${prev.id}_${prev.completedAt}`, await bitmapFromBlob(frame), ratio, { x: 0.5, y: 0.5 }, { maxDataUriBytes: 3_600_000 })).dataUri;
  }
  const photo = await imageStore.get(`film_src_${f.id}`);
  if (!photo) throw Object.assign(new Error('The film’s photo is missing. Add it again in step 01.'), { code: 'INVALID_IMAGE' });
  return (await prepareForGeneration(`film_${f.id}_${f.photoVersion || 0}`, await bitmapFromBlob(photo), ratio, { x: 0.5, y: 0.5 }, { maxDataUriBytes: 3_600_000 })).dataUri;
}

// Polled providers (your Modal app): submit, then read status until the clip is ready.
async function pollJob(provider, body, set) {
  const { taskId } = await api.generate(body, { timeoutMs: 90_000 });
  set({ note: 'Submitted to your Modal app', taskId });
  const signal = st.abort.signal;
  const onAbort = () => api.cancel(provider, taskId).catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  const started = Date.now();
  let hiccups = 0;
  try {
    for (;;) {
      if (signal.aborted) throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
      if (Date.now() - started > 15 * 60_000) throw Object.assign(new Error('No result after 15 minutes.'), { code: 'TIMEOUT' });
      let s;
      try {
        s = await api.status(provider, taskId);
        hiccups = 0;
      } catch (e) {
        if (e.retryable && ++hiccups < 4) {
          await new Promise((res) => setTimeout(res, 4000));
          continue;
        }
        throw e;
      }
      if (s.state === 'succeeded') return { taskId, seed: s.seed ?? null };
      if (s.state === 'failed') throw Object.assign(new Error(s.failure || 'The job failed without a reason.'), { code: 'GENERATION_FAILED' });
      if (s.state === 'cancelled') throw Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });
      if (s.state === 'running') set({ progress: s.progress, note: s.step != null ? `Step ${s.step} of ${s.steps} (reported by your Modal app)` : 'Generating on your Modal GPU' });
      else set({ note: s.note || 'Waiting for your Modal GPU' });
      await new Promise((res) => setTimeout(res, st.catalog.providers[provider]?.pollIntervalMs || 4000));
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function generateShot(shot) {
  const f = st.film;
  const i = f.shots.indexOf(shot);
  const modelId = shotModel(shot);
  const caps = capsOf(modelId);
  const ratio = ratioFor(caps, f.ratio);
  const set = (patch) => {
    Object.assign(shot, patch);
    save();
    renderPlanLight(shot);
  };
  st.abort = new AbortController();
  const wasDone = Boolean(shot.completedAt); // regenerating a shot that already had a clip
  set({ status: 'running', progress: null, note: 'Preparing…', error: null });
  try {
    const image = await inputImageFor(shot, i, caps, ratio);
    const prompt = shotPrompt(shot, f.bible, { isFirst: i === 0 });
    const neg = caps.negativePrompt ? NEG_IDS.map((id) => byId(PROTECTIONS, id)?.neg).filter(Boolean).join(', ') : undefined;
    const provider = providerOf(modelId);
    const prov = st.catalog.providers[provider];
    const body = {
      provider,
      model: modelId,
      mode: image ? 'i2v' : 't2v',
      image: image || undefined,
      prompt,
      negativePrompt: neg,
      duration: Number(shot.duration),
      ratio,
      quality: (caps.qualityPresets || []).some((q) => q.id === f.quality) ? f.quality : undefined,
    };
    const est = gpuSeconds(caps, { ratio, duration: shot.duration, quality: f.quality });
    let r;
    let blob;
    if (prov.mode === 'stream') {
      r = await api.generate(body, {
        signal: st.abort.signal,
        timeoutMs: 6 * 60_000,
        onEvent: (ev) => {
          if (ev.type === 'queued') set({ note: `In the Space queue${ev.size ? ` · ${ev.position + 1} of ${ev.size}` : ''}` });
          else if (ev.type === 'started') set({ note: 'GPU allocated — generating' });
          else if (ev.type === 'retrying') set({ note: 'The Space crashed — retrying once…' });
          else if (ev.type === 'progress') set({ progress: ev.progress, note: `Step ${Math.min(ev.step + 1, ev.steps)} of ${ev.steps} (reported by the Space)` });
          else if (ev.type === 'saving') set({ note: 'Receiving the clip…', progress: 1 });
        },
      });
      blob = r.blob;
      if (!blob && r.outputs?.[0]) blob = await api.downloadBlob(provider, null, `shot-${shot.id}`, r.outputs[0]);
      if (est) gpuTally.add(est);
    } else {
      r = await pollJob(provider, body, set);
      blob = await api.downloadBlob(provider, r.taskId, `shot-${shot.id}`);
    }
    if (!blob) throw Object.assign(new Error('The model finished but the clip could not be saved.'), { code: 'PROVIDER_ERROR' });
    set({ note: 'Reading the last frame for the next shot…' });
    const last = await extractLastFrame(blob);
    dropUrl(`film_clip_${shot.id}`);
    await imageStore.put(`film_clip_${shot.id}`, blob);
    await imageStore.put(`film_frame_${shot.id}`, last.blob);
    const hasAudio = Boolean(caps.nativeAudio);
    set({ status: 'done', progress: 1, note: '', outdated: false, clipDuration: last.duration, clipBytes: blob.size, hasAudio, seedUsed: r.seed ?? null, prompt, modelUsed: modelId, completedAt: new Date().toISOString() });
    // Shots that continue from this one no longer start on its exact last frame.
    if (wasDone) for (let k = i + 1; k < f.shots.length && f.shots[k].continuity === 'continue'; k++) if (f.shots[k].status === 'done') f.shots[k].outdated = true;
    if (f.export.last) f.export.last.stale = true;
    save();
    return true;
  } catch (e) {
    const aborted = st.abort?.signal.aborted || e?.code === 'CANCELLED';
    set({ status: aborted ? 'cancelled' : 'failed', note: '', error: aborted ? null : errInfo(e) });
    return false;
  } finally {
    st.abort = null;
    renderUsage();
  }
}

async function runQueue(list, { force = false } = {}) {
  if (st.busy) return;
  st.busy = true;
  st.stop = false;
  for (const s of list) if (force || s.status !== 'done' || s.outdated) s.status = 'queued';
  save();
  renderPlan();
  let failed = 0;
  try {
    for (const s of list) {
      if (st.stop) {
        if (s.status === 'queued') s.status = 'idle';
        continue;
      }
      if (s.status !== 'queued') continue;
      const ok = await generateShot(s);
      if (!ok) {
        failed++;
        // Later "continue" shots depend on this one; stop instead of wasting GPU time.
        for (const rest of list.slice(list.indexOf(s) + 1)) if (rest.status === 'queued') rest.status = 'idle';
        break;
      }
    }
  } finally {
    st.busy = false;
    save();
    renderPlan();
  }
  const done = st.film.shots.filter((s) => s.status === 'done').length;
  if (!failed && done === st.film.shots.length) toast('All shots generated', 'Step 03: assemble and export your film.', 'ok');
}
function renderPlanLight(shot) {
  // Re-render only the changed shot + timeline (keeps typing focus elsewhere intact).
  const li = $(`.fs-shot[data-shot="${shot.id}"]`);
  const i = st.film.shots.indexOf(shot);
  if (li && i >= 0) {
    const tmp = document.createElement('div');
    tmp.innerHTML = shotCard(shot, i);
    li.replaceWith(tmp.firstElementChild);
    if (shot.status === 'done') attachShotMedia(shot);
  }
  renderTimeline();
  const done = st.film.shots.filter((s) => s.status === 'done').length;
  $('#fsPlanBadge').textContent = `${done}/${st.film.shots.length} shots ready`;
  $('#fsStop').hidden = !st.busy;
  $('#fsGenerateAll').disabled = st.busy;
}

// ------------------------------------------------------------------ export
async function exportFilm() {
  const f = st.film;
  const e = f.export;
  const done = f.shots.filter((s) => s.status === 'done');
  if (!done.length || st.exporting) return;
  st.exporting = new AbortController();
  $('#fsExportError').hidden = true;
  $('#fsExportProgress').hidden = false;
  $('#fsExportCancel').hidden = false;
  renderExportState();
  const bar = $('#fsExportBar');
  const text = $('#fsExportText');
  try {
    const clips = [];
    for (const s of done) {
      const blob = await imageStore.get(`film_clip_${s.id}`);
      if (!blob) throw new Error(`The clip for “${s.title}” is missing from this browser. Regenerate that shot.`);
      const idx = f.shots.indexOf(s);
      const prevDone = idx > 0 && f.shots[idx - 1].status === 'done';
      clips.push({ blob, duration: s.clipDuration, trimStart: s.continuity === 'continue' && prevDone && !s.outdated ? 'auto' : 0, transition: clips.length ? s.transition || e.transition : 'none' });
    }
    // The global choice applies unless a shot sets its own.
    for (const c of clips) if (!c.transition || c.transition === 'none') c.transition = e.transition;
    const music = e.music ? { blob: await imageStore.get(`film_music_${f.id}`), volume: e.music.volume ?? 0.7, fadeIn: e.music.fadeIn ?? 1, fadeOut: e.music.fadeOut ?? 2 } : null;
    const size = outSizes().find((o) => o.id === e.outSize);
    const result = await assembleFilm({
      clips,
      music: music?.blob ? music : null,
      settings: {
        transition: e.transition,
        transitionSeconds: Number(e.transitionSeconds) || 0.5,
        width: size?.wh ? size.wh[0] : 'native',
        height: size?.wh ? size.wh[1] : 'native',
        fps: e.outFps === 'native' ? 'native' : Number(e.outFps),
        interpolate: e.outFps !== 'native' && Boolean(e.interpolate),
        keepOriginalAudio: e.keepOrig !== false,
        originalVolume: Number(e.origVol ?? 1),
        fadeEdges: e.fadeEdges !== false,
      },
      signal: st.exporting.signal,
      onProgress: (p) => {
        text.textContent = p.text;
        bar.style.width = p.fraction == null ? '100%' : `${Math.round(p.fraction * 100)}%`;
        bar.classList.toggle('indeterminate', p.fraction == null);
      },
    });
    dropUrl(`film_out_${f.id}`);
    await imageStore.put(`film_out_${f.id}`, result.blob);
    if (done.length < f.shots.length) result.summary.unshift(`Partial export: ${done.length} of ${f.shots.length} planned shots.`);
    e.last = { seconds: result.seconds, summary: result.summary, hasAudio: result.hasAudio, width: result.width, height: result.height, fps: result.fps, bytes: result.blob.size, at: new Date().toISOString() };
    save();
    toast('Film exported', `${fmtS(result.seconds)} MP4 is ready to download.`, 'ok');
  } catch (err) {
    if (err?.code !== 'CANCELLED') {
      $('#fsExportError').hidden = false;
      $('#fsExportError').textContent = `Export failed: ${err?.message || err}. Your shots are safe — try again, or choose Native size and no interpolation for a lighter export.`;
    } else toast('Export cancelled');
  } finally {
    st.exporting = null;
    $('#fsExportProgress').hidden = true;
    $('#fsExportCancel').hidden = true;
    renderExportState();
  }
}
async function downloadFinal() {
  const b = await imageStore.get(`film_out_${st.film.id}`);
  if (!b) return toast('No exported film yet');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b);
  a.download = `${(st.film.title || 'film').replace(/[^\w.-]+/g, '-').slice(0, 60)}.mp4`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1500);
}

// ------------------------------------------------------------------ events
async function setPhoto(file) {
  try {
    const { bitmap } = await loadImageFile(file);
    const thumb = file;
    await imageStore.put(`film_src_${st.film.id}`, thumb);
    dropUrl(`film_src_${st.film.id}`);
    st.film.hasPhoto = true;
    st.film.photoVersion = Date.now();
    st.film.photoW = bitmap.width;
    st.film.photoH = bitmap.height;
    st.film.source = 'photo';
    // Auto-pick the ratio closest to the photo.
    const c = filmCaps();
    if (c) {
      const ar = bitmap.width / bitmap.height;
      st.film.ratio = c.ratios.reduce((best, r) => {
        const [w, h] = r.value.split(':').map(Number);
        const [bw, bh] = best.value.split(':').map(Number);
        return Math.abs(Math.log(w / h / ar)) < Math.abs(Math.log(bw / bh / ar)) ? r : best;
      }, c.ratios[0]).value;
    }
    save();
    renderAll();
  } catch (e) {
    toast(e instanceof ImageError ? 'This image can’t be used' : 'Could not read the photo', e.message);
  }
}
function bind() {
  if (st.bound) return;
  st.bound = true;
  $('#fsNew').addEventListener('click', () => {
    st.film = newFilm();
    save();
    renderAll();
  });
  $('#fsDelete').addEventListener('click', () => {
    if (!confirm(`Delete “${st.film.title}” and its clips from this browser?`)) return;
    for (const s of st.film.shots) removeShotMedia(s);
    for (const k of [`film_src_${st.film.id}`, `film_music_${st.film.id}`, `film_out_${st.film.id}`]) imageStore.remove(k);
    st.films = st.films.filter((x) => x.id !== st.film.id);
    st.film = st.films[0] || newFilm();
    save();
    renderAll();
  });
  $('#fsFilmSelect').addEventListener('change', (e) => {
    if (st.busy) return toast('A shot is generating', 'Wait for it to finish before switching films.');
    st.film = st.films.find((x) => x.id === e.target.value) || st.film;
    renderAll();
  });
  $('#fsTitle').addEventListener('input', (e) => {
    st.film.title = e.target.value.slice(0, 80);
    save();
    const o = $(`#fsFilmSelect option[value="${st.film.id}"]`);
    if (o) o.textContent = st.film.title || 'Untitled film';
  });
  $('#fsIdea').addEventListener('input', (e) => {
    st.film.idea = e.target.value;
    save();
  });
  $('#fsPhotoInput').addEventListener('change', (e) => {
    if (e.target.files[0]) setPhoto(e.target.files[0]);
    e.target.value = '';
  });
  window.addEventListener('cas:film-files', (e) => e.detail.files[0] && setPhoto(e.detail.files[0]));
  $('[data-view="film"]').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const f = st.film;
    if (t.dataset.src) {
      f.source = t.dataset.src;
      if (f.source === 'text' && !(filmCaps()?.modes || []).includes('t2v')) f.model = streamModels().find((m) => (m.modes || []).includes('t2v'))?.id || f.model;
      save();
      renderIdea();
    } else if (t.dataset.preset) {
      f.preset = t.dataset.preset;
      save();
      renderIdea();
    } else if (t.dataset.len !== undefined) {
      f.targetSeconds = Number(t.dataset.len);
      save();
      renderIdea();
    } else if (t.dataset.fint) {
      f.intensity = t.dataset.fint;
      if (f.bible) f.bible.intensity = f.intensity;
      save();
      renderIdea();
    } else if (t.dataset.fmodel) {
      f.model = t.dataset.fmodel;
      save();
      renderAll();
    } else if (t.dataset.fratio) {
      f.ratio = t.dataset.fratio;
      save();
      renderAll();
    } else if (t.dataset.fq) {
      f.quality = t.dataset.fq;
      save();
      renderAll();
    } else if (t.dataset.ftrans) {
      f.export.transition = t.dataset.ftrans;
      save();
      renderExportState();
    } else if (t.dataset.fsize) {
      f.export.outSize = t.dataset.fsize;
      save();
      renderExportState();
    } else if (t.dataset.ffps) {
      f.export.outFps = t.dataset.ffps === 'native' ? 'native' : Number(t.dataset.ffps);
      save();
      renderExportState();
    } else if (t.dataset.seg !== undefined) {
      const s = f.shots[Number(t.dataset.seg)];
      const li = s && $(`.fs-shot[data-shot="${s.id}"]`);
      li?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      li?.querySelector('video:not([hidden])')?.play().catch(() => {});
    } else if (t.dataset.act) {
      const li = t.closest('[data-shot]');
      const idx = f.shots.findIndex((s) => s.id === li.dataset.shot);
      const s = f.shots[idx];
      if (t.dataset.act === 'gen') runQueue([s], { force: true });
      else if (t.dataset.act === 'del') {
        removeShotMedia(s);
        f.shots.splice(idx, 1);
        if (f.shots[0] && f.shots[0].continuity === 'continue') f.shots[0].continuity = f.hasPhoto ? 'photo' : 'text';
        save();
        renderPlan();
      } else if (t.dataset.act === 'up' || t.dataset.act === 'down') {
        const j = t.dataset.act === 'up' ? idx - 1 : idx + 1;
        [f.shots[idx], f.shots[j]] = [f.shots[j], f.shots[idx]];
        for (const x of [f.shots[idx], f.shots[j]]) if (x.status === 'done' && x.continuity === 'continue') x.outdated = true;
        save();
        renderPlan();
      }
    }
  });
  $('#fsShots').addEventListener('change', (e) => {
    const el = e.target.closest('[data-f]');
    const li = e.target.closest('[data-shot]');
    if (!el || !li) return;
    const s = st.film.shots.find((x) => x.id === li.dataset.shot);
    const k = el.dataset.f;
    if (el.tagName !== 'SELECT') return;
    if (k === 'continuity' && el.value === 'continue' && (!s.transition || s.transition === 'crossfade')) s.transition = 'cut'; // text fields are saved on input; re-rendering on blur would swallow clicks
    s[k] = k === 'duration' ? Number(el.value) : el.value;
    save();
    renderPlanLight(s);
  });
  $('#fsShots').addEventListener('input', (e) => {
    const el = e.target.closest('[data-f="action"],[data-f="title"]');
    const li = e.target.closest('[data-shot]');
    if (!el || !li) return;
    const s = st.film.shots.find((x) => x.id === li.dataset.shot);
    s[el.dataset.f] = el.value;
    save();
    const p = li.querySelector('.fs-prompt p');
    if (p) p.textContent = shotPrompt(s, st.film.bible, { isFirst: st.film.shots.indexOf(s) === 0 });
  });
  $('#fsShots').addEventListener('mouseover', (e) => e.target.closest('video:not([hidden])')?.play().catch(() => {}));
  $('#fsShots').addEventListener('mouseout', (e) => e.target.closest('video')?.pause());
  for (const el of $$('[data-bible]')) {
    el.addEventListener('input', () => {
      st.film.bible[el.dataset.bible] = el.value;
      save();
      for (const [i, s] of st.film.shots.entries()) {
        const p = $(`.fs-shot[data-shot="${s.id}"] .fs-prompt p`);
        if (p) p.textContent = shotPrompt(s, st.film.bible, { isFirst: i === 0 });
      }
    });
  }
  $('#fsPlan').addEventListener('click', plan);
  $('#fsAddShot').addEventListener('click', () => {
    const f = st.film;
    const c = filmCaps();
    f.shots.push({ id: uid('shot'), title: `Shot ${f.shots.length + 1}`, action: `${f.bible?.subject || 'the subject'} continue naturally`, camera: 'push_in', duration: c?.durations.presets?.[0] || 5, continuity: f.shots.length ? 'continue' : f.hasPhoto ? 'photo' : 'text', transition: f.shots.length ? 'cut' : 'none', model: '', status: 'idle' });
    save();
    renderPlan();
  });
  $('#fsGenerateAll').addEventListener('click', () => {
    const f = st.film;
    const allDone = f.shots.every((s) => s.status === 'done' && !s.outdated);
    if (allDone) {
      if (!confirm('Regenerate every shot? This spends GPU time again.')) return;
      for (const s of f.shots) s.status = 'idle';
    }
    runQueue([...f.shots]);
  });
  $('#fsStop').addEventListener('click', () => {
    st.stop = true;
    toast('Stopping after the current shot', 'The shot in progress keeps running so its GPU time isn’t wasted.');
  });
  // export controls
  const ex = () => st.film.export;
  $('#fsTransSec').addEventListener('input', (e) => {
    ex().transitionSeconds = Number(e.target.value);
    $('#fsTransSecVal').textContent = `${Number(e.target.value).toFixed(1)} s`;
    save();
    renderTimeline();
  });
  $('#fsInterp').addEventListener('change', (e) => ((ex().interpolate = e.target.checked), save()));
  $('#fsFadeEdges').addEventListener('change', (e) => ((ex().fadeEdges = e.target.checked), save()));
  $('#fsOrigAudio').addEventListener('change', (e) => ((ex().keepOrig = e.target.checked), save()));
  const slider = (id, key, fmt, target = () => ex().music) => {
    $(id).addEventListener('input', (e) => {
      const o = target();
      if (!o) return;
      o[key] = Number(e.target.value);
      $(`${id}Val`).textContent = fmt(Number(e.target.value));
      save();
    });
  };
  slider('#fsMusVol', 'volume', (v) => `${Math.round(v * 100)}%`);
  slider('#fsMusIn', 'fadeIn', (v) => `${v} s`);
  slider('#fsMusOut', 'fadeOut', (v) => `${v} s`);
  slider('#fsOrigVol', 'origVol', (v) => `${Math.round(v * 100)}%`, () => ex());
  $('#fsMusicInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!/^audio\//.test(file.type) && !/\.(mp3|m4a|aac|wav|ogg)$/i.test(file.name)) return toast('Not an audio file', 'Use MP3, M4A, AAC, WAV or OGG.');
    if (file.size > MAX_MUSIC) return toast('Music file too large', `${fmtBytes(file.size)} — the limit is 25 MB.`);
    await imageStore.put(`film_music_${st.film.id}`, file);
    ex().music = { name: file.name.slice(0, 80), bytes: file.size, volume: 0.7, fadeIn: 1, fadeOut: 2 };
    save();
    renderExportState();
  });
  $('#fsMusicRemove').addEventListener('click', () => {
    imageStore.remove(`film_music_${st.film.id}`);
    ex().music = null;
    save();
    renderExportState();
  });
  $('#fsExport').addEventListener('click', exportFilm);
  $('#fsExportCancel').addEventListener('click', () => st.exporting?.abort());
  $('#fsDownload').addEventListener('click', downloadFinal);
  window.addEventListener('beforeunload', (e) => {
    if (st.busy || st.exporting) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

async function open() {
  if (!st.catalog) await loadCatalog();
  if (!st.films.length) loadFilms();
  if (!st.film) st.film = st.films[0] || newFilm();
  if (!capsOf(st.film.model)) st.film.model = st.catalog?.defaultModel && capsOf('wan2.2-long') ? 'wan2.2-long' : streamModels()[0]?.id;
  bind();
  renderAll();
}

window.addEventListener('cas:film-open', open);
if ((location.hash || '').startsWith('#film')) open();
