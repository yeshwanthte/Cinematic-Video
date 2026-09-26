// Cinematic AI Studio — application controller
import { CAMERA, SUBJECT, ENVIRONMENT, STYLES, PROTECTIONS, INTENSITY, CATEGORY, VARIATIONS, byId } from './js/motion-catalog.js';
import { buildPrompt, enhanceLocal, traitsFrom, compatibility, residualActions } from './js/prompt-engine.js';
import { loadImageFile, prepareForGeneration, makeJpegDataUri, cropRect, parseRatio, fmtBytes, ImageError, clearPreparedCache } from './js/image-tools.js';
import { analyzeOnDevice } from './js/analysis.js';
import { StudioApi, ApiError, ERROR_TITLES } from './js/api-client.js';
import { settingsStore, projectStore, imageStore, uid } from './js/storage.js';

// ====================================================================== state
const DEFAULT_SETTINGS = {
  apiBase: window.STUDIO_CONFIG?.apiBase || '',
  accessCode: '',
  provider: '', // '' → the backend's default (free Hugging Face)
  model: '',
  intensity: 'balanced',
  autoAnalyze: true,
  defaultProtect: true,
  timeoutMin: 15,
};
const DEFAULT_PROTECT = ['face', 'identity', 'flicker', 'unnatural'];

const state = {
  settings: settingsStore.load(DEFAULT_SETTINGS),
  health: null,
  healthError: null,
  catalog: null, // models config
  catalogSource: null, // 'backend' | 'offline'
  images: [], // session images
  activeId: null,
  controls: null,
  touched: false,
  prompt: { text: '', mode: 'auto', source: 'engine', dropped: [] },
  job: null, // main-stage generation currently shown
  jobs: new Map(), // genId -> running job (for background variations/story)
  viewGenId: null,
  story: { scenes: [] },
};
state.controls = {
  camera: 'push_in',
  subject: ['natural'],
  environment: ['ambient'],
  style: 'cinematic',
  intensity: state.settings.intensity,
  protections: state.settings.defaultProtect ? [...DEFAULT_PROTECT] : [],
  provider: state.settings.provider,
  model: state.settings.model,
  duration: 5,
  resolution: '720p',
  ratio: '1280:720',
  seed: '',
  audio: false,
};

const api = new StudioApi(() => state.settings);
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const sleep = (ms, signal) =>
  new Promise((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
  });
const fmtTime = (s) => (isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

// ====================================================================== helpers
function toast(title, msg = '', kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div><b>${esc(title)}</b>${msg ? `<p>${esc(msg)}</p>` : ''}</div>`;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 9000 : 4500);
}

function errInfo(e) {
  const code = e?.code || 'INTERNAL';
  return {
    code,
    title: ERROR_TITLES[code] || ERROR_TITLES.INTERNAL,
    message: e?.message || String(e),
    details: { code, httpStatus: e?.status, providerStatus: e?.providerStatus, retryable: e?.retryable, ...(e?.details ? { details: e.details } : {}) },
  };
}

function caps(provider = state.controls.provider, model = state.controls.model) {
  return state.catalog?.providers?.[provider]?.models?.[model] || null;
}
function providerInfo(provider = state.controls.provider) {
  return state.catalog?.providers?.[provider] || null;
}
function activeImage() {
  return state.images.find((i) => i.id === state.activeId) || null;
}
function ratioInfo(value, c = caps()) {
  return c?.ratios.find((r) => r.value === value) || null;
}

// ====================================================================== boot
async function init() {
  renderExamples();
  renderStaticControls();
  bindGlobal();
  bindStudio();
  bindPlayer();
  bindSettings();
  bindStory();
  await loadCatalog();
  syncModelControls();
  renderControls();
  updatePrompt();
  route();
  checkHealth();
  loadStory();
  window.addEventListener('hashchange', route);
}

async function loadCatalog() {
  try {
    state.catalog = await api.models();
    state.catalogSource = 'backend';
  } catch (e) {
    try {
      state.catalog = await (await fetch('models.json', { cache: 'no-cache' })).json();
      state.catalogSource = 'offline';
    } catch {
      state.catalog = null;
    }
  }
  if (!caps()) {
    state.controls.provider = state.catalog?.defaultProvider || 'huggingface';
    state.controls.model = state.catalog?.defaultModel || 'wan2.2-fast';
  }
  const c = caps();
  if (c) $('#heroModel').textContent = c.label;
  $('#heroModelSub').textContent = providerInfo()?.free ? 'Free · open-source model' : 'Image-to-video model';
}

async function checkHealth({ account = true } = {}) {
  const pill = $('#backendStatus');
  pill.dataset.state = '';
  pill.querySelector('.label').textContent = 'Checking backend…';
  try {
    state.health = await api.health({ account });
    state.healthError = null;
    const p = state.health.providers?.[state.controls.provider];
    if (!p?.configured) {
      pill.dataset.state = 'warn';
      pill.querySelector('.label').textContent = `${p?.label || 'Provider'} — ${state.controls.provider === 'huggingface' ? 'HF_TOKEN' : 'API key'} not set`;
    } else {
      pill.dataset.state = 'ok';
      const bal = p.account?.creditBalance;
      const acct = p.account?.user ? ` · @${p.account.user} · ${p.account.plan}` : bal != null ? ` · ${bal.toLocaleString()} credits` : '';
      pill.querySelector('.label').textContent = `${p.label.replace(' (free)', '')} connected${acct}`;
      if (p.accountError?.code === 'AUTH_FAILED') {
        pill.dataset.state = 'err';
        pill.querySelector('.label').textContent = `${p.label} token rejected`;
      }
      if (p.accountError?.code === 'FORBIDDEN') {
        pill.dataset.state = 'warn';
        pill.querySelector('.label').textContent = 'Access code required';
      }
    }
    if (state.catalogSource !== 'backend') {
      await loadCatalog();
      syncModelControls();
    }
  } catch (e) {
    state.health = null;
    state.healthError = e;
    pill.dataset.state = 'err';
    pill.querySelector('.label').textContent = 'Backend offline';
  }
  renderCost();
  renderAnalysisBadge();
  return state.health;
}

// ====================================================================== routing
function route() {
  const v = (location.hash || '#home').slice(1).split('/')[0];
  setView(['home', 'studio', 'story', 'projects', 'settings'].includes(v) ? v : 'home', false);
}
function setView(name, push = true) {
  $$('.view').forEach((s) => (s.hidden = s.dataset.view !== name));
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
  if (push && location.hash !== `#${name}`) history.pushState(null, '', `#${name}`);
  if (name === 'projects') renderProjects();
  if (name === 'settings') renderSettings();
  if (name === 'story') renderStory();
  if (name === 'studio') requestAnimationFrame(renderFrame);
  window.scrollTo({ top: 0 });
}

function bindGlobal() {
  document.addEventListener('click', (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      e.preventDefault();
      setView(nav.dataset.nav);
    }
  });
  // window-level drag & drop
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    depth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    const onStory = !$('[data-view="story"]').hidden;
    if (onStory) addStoryFiles(files);
    else {
      if ($('[data-view="studio"]').hidden) setView('studio');
      handleFiles(files);
    }
  });
  window.addEventListener('resize', () => requestAnimationFrame(renderFrame));
}

// ====================================================================== home
const EXAMPLE_ART = {
  portrait: `<svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice"><defs><radialGradient id="pa" cx="70%" cy="30%" r="80%"><stop offset="0" stop-color="#3a2f7a"/><stop offset=".6" stop-color="#15121f"/><stop offset="1" stop-color="#08080b"/></radialGradient><linearGradient id="pb" x1="0" x2="1"><stop offset="0" stop-color="#1c1a26"/><stop offset="1" stop-color="#7c6cff"/></linearGradient></defs><rect width="320" height="200" fill="url(#pa)"/><ellipse cx="170" cy="92" rx="34" ry="42" fill="#0b0b10" stroke="url(#pb)" stroke-width="2.5"/><path d="M92 210c6-52 40-74 78-74s72 22 78 74z" fill="#0b0b10" stroke="url(#pb)" stroke-width="2.5"/><circle cx="250" cy="40" r="2" fill="#c8f55a"/></svg>`,
  travel: `<svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="ta" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b1535"/><stop offset=".55" stop-color="#7a3d5c"/><stop offset="1" stop-color="#e59a5c"/></linearGradient></defs><rect width="320" height="200" fill="url(#ta)"/><circle cx="210" cy="120" r="26" fill="#ffd28a" opacity=".9"/><path d="M0 150l60-50 40 30 50-60 60 55 40-25 70 50v60H0z" fill="#241a33"/><path d="M0 170l80-35 60 25 70-30 110 40v30H0z" fill="#0d0b14"/></svg>`,
  architecture: `<svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="aa" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f1b2b"/><stop offset="1" stop-color="#060709"/></linearGradient></defs><rect width="320" height="200" fill="url(#aa)"/><g fill="#131a24" stroke="#2a3950"><path d="M40 200V70h60v130z"/><path d="M120 200V30h70v170z"/><path d="M210 200V90h70v110z"/></g><g fill="#c8f55a" opacity=".55">${Array.from({ length: 18 }, (_, i) => `<rect x="${132 + (i % 3) * 18}" y="${44 + Math.floor(i / 3) * 24}" width="8" height="12"/>`).join('')}</g><g fill="#7c6cff" opacity=".45">${Array.from({ length: 8 }, (_, i) => `<rect x="${52 + (i % 2) * 24}" y="${84 + Math.floor(i / 2) * 26}" width="10" height="12"/>`).join('')}</g></svg>`,
  wedding: `<svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice"><defs><radialGradient id="wa" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#4a3a38"/><stop offset="1" stop-color="#0d0b0c"/></radialGradient></defs><rect width="320" height="200" fill="url(#wa)"/>${[[40, 40, 18], [270, 60, 26], [220, 30, 10], [80, 150, 22], [290, 160, 14], [150, 24, 8]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffe3c4" opacity=".14"/>`).join('')}<path d="M110 200V120a50 50 0 0 1 100 0v80" fill="none" stroke="#f3d9b8" stroke-width="2" opacity=".6"/><path d="M130 200V128a30 30 0 0 1 60 0v72" fill="none" stroke="#f3d9b8" stroke-width="1.5" opacity=".35"/></svg>`,
  product: `<svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice"><rect width="320" height="200" fill="#0a0a0d"/><path d="M130 0h60l50 200H80z" fill="#c8f55a" opacity=".06"/><ellipse cx="160" cy="168" rx="70" ry="12" fill="#16181e"/><path d="M146 70h28v14c10 6 14 14 14 26v50c0 5-4 8-8 8h-40c-4 0-8-3-8-8v-50c0-12 4-20 14-26z" fill="#1d212b" stroke="#c8f55a" stroke-opacity=".5"/><rect x="150" y="58" width="20" height="12" rx="2" fill="#2a2f3b"/></svg>`,
  landscape: `<svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice"><defs><linearGradient id="la" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0c1422"/><stop offset=".6" stop-color="#1f2d45"/><stop offset="1" stop-color="#0a0f18"/></linearGradient></defs><rect width="320" height="200" fill="url(#la)"/><circle cx="240" cy="50" r="16" fill="#e8ecf5" opacity=".85"/><ellipse cx="90" cy="60" rx="60" ry="10" fill="#fff" opacity=".06"/><ellipse cx="200" cy="85" rx="80" ry="8" fill="#fff" opacity=".05"/><rect y="128" width="320" height="72" fill="#0a1220"/><path d="M0 128h320" stroke="#7c6cff" stroke-opacity=".4"/>${Array.from({ length: 6 }, (_, i) => `<path d="M${200 + i * 6} ${138 + i * 9}h${50 - i * 6}" stroke="#e8ecf5" stroke-opacity="${0.35 - i * 0.05}"/>`).join('')}</svg>`,
};
const EXAMPLES = [
  { id: 'portrait', label: 'Portrait', motion: 'Push-in · blink · hair', style: 'portrait' },
  { id: 'travel', label: 'Travel', motion: 'Crane up · wind · clouds', style: 'travel' },
  { id: 'architecture', label: 'Architecture', motion: 'Dolly · parallax · light', style: 'realestate' },
  { id: 'wedding', label: 'Wedding', motion: 'Slow push-in · soft fabric', style: 'wedding' },
  { id: 'product', label: 'Product', motion: 'Orbit · light sweep', style: 'luxury' },
  { id: 'landscape', label: 'Landscape', motion: 'Pan · drifting clouds', style: 'cinematic' },
];
function renderExamples() {
  $('#examples').innerHTML = EXAMPLES.map(
    (x) => `<button class="example" data-example="${x.id}"><div class="art">${EXAMPLE_ART[x.id]}</div><div class="shade"></div>
      <div class="cap"><div><h3>${x.label}</h3><p>${x.motion}</p></div><span class="go">Use recipe →</span></div></button>`
  ).join('');
  $('#examples').addEventListener('click', (e) => {
    const b = e.target.closest('[data-example]');
    if (!b) return;
    applyCategoryRecipe(b.dataset.example, { styleOverride: EXAMPLES.find((x) => x.id === b.dataset.example).style });
    state.touched = true;
    setView('studio');
    toast(`${b.querySelector('h3').textContent} recipe loaded`, activeImage() ? 'Motion controls updated.' : 'Upload a photo to bring it to life.', 'ok');
  });
}

// ====================================================================== controls rendering
function renderStaticControls() {
  $('#styleCards').innerHTML = STYLES.map((s) => `<button class="style-card" data-style="${s.id}"><b>${s.label}</b><span>${s.blurb}</span></button>`).join('');
  $('#cameraCards').innerHTML = CAMERA.map((c) => `<button class="cam g-${c.id}" data-camera="${c.id}" title="${esc(c.hint)}"><span class="glyph"><i></i></span><b>${c.label}</b></button>`).join('');
  $('#subjectChips').innerHTML = SUBJECT.map((s) => `<button class="chip" data-subject="${s.id}">${s.label}</button>`).join('');
  $('#envChips').innerHTML = ENVIRONMENT.map((s) => `<button class="chip" data-env="${s.id}">${s.label}</button>`).join('');
  $('#protectChips').innerHTML = PROTECTIONS.map((s) => `<button class="chip" data-protect="${s.id}">${s.label}</button>`).join('');
  $('#intensitySeg').innerHTML = Object.entries(INTENSITY).map(([id, v]) => `<button data-intensity="${id}" role="radio">${v.label}</button>`).join('');
  $('#categoryChips').innerHTML = Object.entries(CATEGORY).map(([id, v]) => `<button class="chip" data-category="${id}">${v.label}</button>`).join('');
}

function renderControls() {
  const c = state.controls;
  const img = activeImage();
  const traits = traitsFrom(img?.analysis);
  $$('[data-style]').forEach((b) => b.classList.toggle('on', b.dataset.style === c.style));
  $$('[data-camera]').forEach((b) => {
    const fit = compatibility(byId(CAMERA, b.dataset.camera), traits);
    b.classList.toggle('on', b.dataset.camera === c.camera);
    b.classList.toggle('off-fit', !fit.ok);
    b.title = fit.ok ? byId(CAMERA, b.dataset.camera).hint : `Not suited: ${fit.reason}`;
  });
  const chipState = (sel, list, arr) =>
    $$(sel).forEach((b) => {
      const id = b.dataset[sel.includes('subject') ? 'subject' : sel.includes('env') ? 'env' : 'protect'];
      const item = byId(list, id);
      const fit = compatibility(item, traits);
      b.classList.toggle('on', arr.includes(id));
      b.classList.toggle('off-fit', !fit.ok);
      b.title = fit.ok ? '' : `Doesn't fit this photo: ${fit.reason}`;
    });
  chipState('[data-subject]', SUBJECT, c.subject);
  chipState('[data-env]', ENVIRONMENT, c.environment);
  chipState('[data-protect]', PROTECTIONS, c.protections);
  $$('[data-intensity]').forEach((b) => b.classList.toggle('on', b.dataset.intensity === c.intensity));
  $$('[data-category]').forEach((b) => b.classList.toggle('on', img?.analysis?.category === b.dataset.category));
  renderModelSettings();
  renderNegNote();
}

function syncModelControls() {
  const c = caps();
  if (!c) return;
  const c2 = state.controls;
  const d = c.durations;
  const valid = (v) => (d.exact ? d.exact.includes(v) : v >= d.min && v <= d.max);
  if (!valid(c2.duration) || !d.presets.includes(c2.duration)) c2.duration = d.presets.reduce((a, b) => (Math.abs(b - c2.duration) < Math.abs(a - c2.duration) ? b : a));
  const resolutions = [...new Set(c.ratios.map((r) => r.resolution))];
  if (!resolutions.includes(c2.resolution)) c2.resolution = resolutions[0];
  const current = ratioInfo(c2.ratio, c);
  if (!current || current.resolution !== c2.resolution) {
    const want = current?.aspect || ratioInfo(c2.ratio, { ratios: allRatios() })?.aspect || '16:9';
    const pick = c.ratios.find((r) => r.resolution === c2.resolution && r.aspect === want) || c.ratios.find((r) => r.resolution === c2.resolution);
    c2.ratio = pick.value;
  }
  if (!c.audio) c2.audio = false;
}
function allRatios() {
  return Object.values(state.catalog?.providers || {}).flatMap((p) => Object.values(p.models).flatMap((m) => m.ratios));
}

function renderModelSettings() {
  const pinfo = providerInfo();
  const c = caps();
  if (!pinfo || !c) {
    $('#modelCards').innerHTML = `<p class="warn">Model configuration unavailable — the backend could not be reached and no offline copy was found.</p>`;
    return;
  }
  const c2 = state.controls;
  $('#modelCards').innerHTML = Object.entries(state.catalog.providers)
    .map(([pid, prov]) => {
      const configured = state.health ? state.health.providers?.[pid]?.configured : prov.configured;
      const head = `<div class="model-group"><span>${esc(prov.label)}</span>${prov.free ? '<span class="badge live">Free</span>' : '<span class="badge">Paid</span>'}${configured === false ? `<span class="badge warn">${pid === 'huggingface' ? 'HF_TOKEN not set' : 'key not set'}</span>` : ''}</div>`;
      const cards = Object.entries(prov.models)
        .map(([id, m]) => {
          const durs = m.durations.exact ? m.durations.exact.join('/') + 's' : `${m.durations.min}–${m.durations.max}s`;
          const res = [...new Set(m.ratios.map((r) => r.resolution))].join(' · ');
          const aspects = [...new Set(m.ratios.map((r) => r.aspect))].join(' ');
          const price = m.free ? 'free' : m.creditsPerSecond ? `${m.creditsPerSecond} cr/s` : 'cost from API';
          const on = pid === c2.provider && id === c2.model;
          return `<button class="model ${on ? 'on' : ''}" data-model="${id}" data-provider="${pid}"><div class="top"><b>${esc(m.label)}</b><span class="q">${esc(m.quality)}</span></div>
          <div class="specs"><span>${durs}</span><span>${res}</span><span>${aspects}</span><span>${price}</span>${m.negativePrompt ? '<span>neg. prompt</span>' : ''}${m.audio ? '<span>audio</span>' : ''}</div></button>`;
        })
        .join('');
      return head + cards;
    })
    .join('');
  $('#durationSeg').innerHTML = c.durations.presets.map((d) => `<button data-duration="${d}" class="${d === c2.duration ? 'on' : ''}">${d} sec</button>`).join('');
  const resolutions = [...new Set(c.ratios.map((r) => r.resolution))];
  $('#resolutionSeg').innerHTML = resolutions.map((r) => `<button data-resolution="${r}" class="${r === c2.resolution ? 'on' : ''}">${r}</button>`).join('');
  $('#ratioSeg').innerHTML = c.ratios
    .filter((r) => r.resolution === c2.resolution)
    .map((r) => `<button data-ratio="${r.value}" class="${r.value === c2.ratio ? 'on' : ''}">${r.aspect}<small>${r.value.replace(':', '×')}</small></button>`)
    .join('');
  const notes = [];
  if (!c.durations.exact && c.durations.max < 15) notes.push(`15 sec isn't supported — ${c.label} generates ${c.durations.min}–${c.durations.max} s.`);
  if (c.durations.exact) notes.push(`${c.label} supports exactly ${c.durations.exact.join(', ')} s.`);
  if (resolutions.length === 1) notes.push(`Outputs ${resolutions[0]} only.`);
  notes.push('4K is not offered by any configured model.');
  if (!c.ratios.some((r) => r.aspect === '4:5')) {
    if (c.ratios.some((r) => r.aspect === '3:4')) notes.push('4:5 isn’t available; 3:4 is the closest supported portrait ratio.');
    else notes.push('1:1 and 4:5 aren’t available on this model.');
  }
  if (c.fps) notes.push(`${c.fps} fps output.`);
  $('#ratioNote').textContent = notes.join(' ');
  $('#audioToggleWrap').hidden = !c.audio;
  $('#audioToggle').checked = Boolean(c2.audio);
  $('#seedInput').value = c2.seed;
  $('#promptInput').maxLength = c.promptMaxChars;
  renderCost();
  updateCount();
}

function renderCost() {
  const c = caps();
  const line = $('#costLine');
  if (!c) return (line.textContent = '—');
  const p = providerInfo();
  const bal = state.health?.providers?.[state.controls.provider]?.account?.creditBalance;
  let est;
  const quota = p?.quota;
  if (c.free) {
    const g = gpuSeconds(c, state.controls);
    const acct = state.health?.providers?.[state.controls.provider]?.account;
    const daily = acct?.plan === 'PRO' ? quota?.proSecondsPerDay : quota?.freeSecondsPerDay;
    est = g
      ? `<b>Free</b> · reserves ≈ <b>${g}s</b> of your ≈${daily || 300}s daily GPU <span title="${esc(quota?.note || '')}">(ZeroGPU)</span>`
      : `<b>Free</b> · <span title="${esc(c.creditsNote || '')}">uses your daily ZeroGPU allowance (longer clips use more)</span>`;
    line.innerHTML = `<span>${est}</span>`;
    return;
  }
  if (c.creditsPerSecond) {
    const credits = c.creditsPerSecond * state.controls.duration;
    est = `≈ <b>${credits} credits</b>${p?.creditUsd ? ` (~$${(credits * p.creditUsd).toFixed(2)})` : ''} <span title="${esc(c.creditsNote || 'From the provider’s published per-second pricing. The exact estimate is returned when the task is created.')}">· published pricing</span>`;
  } else est = `<span>Exact cost is returned by ${esc(p?.label || 'the provider')} when the task is created</span>`;
  line.innerHTML = `<span>${est}</span>${bal != null ? `<span>Balance <b>${bal.toLocaleString()}</b></span>` : ''}`;
}

// GPU-time estimate using the formula published in the Space's own code.
function gpuSeconds(c, controls) {
  const g = c.gpuEstimate;
  if (!g) return null;
  const [w, h] = controls.ratio.split(':').map(Number);
  const frames = 1 + Math.min(g.maxFrames, Math.max(g.minFrames, Math.round(controls.duration * g.fps)));
  const factor = (frames * w * h) / g.baseVolume;
  return Math.round(g.base + g.steps * g.stepSeconds * factor ** 1.5);
}

function renderNegNote() {
  const c = caps();
  if (!c) return;
  const { negativePrompt } = currentPromptBuild();
  $('#negNote').textContent = c.negativePrompt
    ? negativePrompt
      ? `${c.label} also receives a negative prompt: “${negativePrompt}”.`
      : `${c.label} supports a negative prompt — select protections to build one.`
    : `${c.label} has no negative-prompt input, so protections are written into the prompt as positive constraints (the phrasing Runway recommends).`;
}

// ====================================================================== prompt
function promptState(overrides = {}) {
  const img = activeImage();
  return { ...state.controls, analysis: img?.analysis || null, caps: caps(), ...overrides };
}
function currentPromptBuild() {
  return buildPrompt(promptState());
}
function updatePrompt(force = false) {
  const out = currentPromptBuild();
  state.prompt.dropped = out.dropped;
  if (state.prompt.mode === 'auto' || force) {
    state.prompt.mode = 'auto';
    state.prompt.source = 'engine';
    state.prompt.text = out.prompt;
    $('#promptInput').value = out.prompt;
  }
  renderPromptMeta();
  renderNegNote();
}
function renderPromptMeta() {
  const badge = $('#promptMode');
  const m = state.prompt;
  const label = m.mode === 'auto' ? 'Auto · from controls' : m.source === 'ai' ? 'AI-enhanced' : m.source === 'local' ? 'Enhanced' : 'Custom';
  badge.textContent = label;
  badge.className = `badge ${m.mode === 'auto' ? 'live' : m.source === 'ai' ? 'ai' : ''}`;
  const warn = $('#promptWarn');
  warn.hidden = !m.dropped.length;
  warn.textContent = m.dropped.length ? `Skipped for this photo: ${m.dropped.join('; ')}.` : '';
  $('#promptNote').textContent =
    m.mode === 'auto'
      ? 'Written from your selections. Edit freely — once you type, the controls stop overwriting your text. “Rebuild” re-syncs.'
      : m.source === 'ai'
        ? `Rewritten by the backend AI assistant (${state.health?.assistant ? 'Claude' : 'AI'}). Review before generating.`
        : m.source === 'local'
          ? 'Rewritten by the built-in prompt engine (no AI assistant configured on the backend). Detected intents were applied to the controls.'
          : 'Your custom prompt is sent as-is.';
  updateCount();
}
function updateCount() {
  const max = caps()?.promptMaxChars || 1000;
  const n = $('#promptInput').value.length;
  const el = $('#promptCount');
  el.textContent = `${n} / ${max}`;
  el.classList.toggle('over', n > max);
}

async function enhance() {
  const btn = $('#enhancePrompt');
  const text = $('#promptInput').value.trim();
  const base = promptState();
  btn.classList.add('loading');
  try {
    if (state.health?.assistant) {
      try {
        const img = activeImage();
        const context = {
          photo: img?.analysis ? { category: img.analysis.category, summary: img.analysis.summary, people: img.analysis.people, faceVisible: img.analysis.faceVisible } : null,
          camera: byId(CAMERA, base.camera)?.label,
          subject: base.subject.map((id) => byId(SUBJECT, id)?.label),
          environment: base.environment.map((id) => byId(ENVIRONMENT, id)?.label),
          style: byId(STYLES, base.style)?.label,
          intensity: base.intensity,
          duration: base.duration,
          preserve: base.protections.map((id) => byId(PROTECTIONS, id)?.label),
          skippedAsIncompatible: state.prompt.dropped,
        };
        const r = await api.enhance({ text, context, provider: base.provider, model: base.model });
        setPrompt(r.prompt, 'ai');
        toast('Prompt enhanced', 'Rewritten by the backend AI assistant.', 'ok');
        return;
      } catch (e) {
        toast('AI assistant unavailable', `${errInfo(e).message} — used the built-in prompt engine instead.`, 'err');
      }
    }
    const r = enhanceLocal(text, base);
    // Apply detected intents to the controls so UI and prompt agree.
    Object.assign(state.controls, { camera: r.applied.camera, subject: r.applied.subject, environment: r.applied.environment, style: r.applied.style, intensity: r.applied.intensity });
    state.touched = true;
    renderControls();
    setPrompt(r.prompt, 'local');
    const found = [r.intents.camera && byId(CAMERA, r.intents.camera).label, ...r.intents.subject.map((i) => byId(SUBJECT, i).label), ...r.intents.environment.map((i) => byId(ENVIRONMENT, i).label), r.intents.style && byId(STYLES, r.intents.style).label].filter(Boolean);
    toast('Prompt enhanced', found.length ? `Detected: ${found.join(', ')}.` : 'Built from your controls.', 'ok');
  } finally {
    btn.classList.remove('loading');
  }
}
function setPrompt(text, source) {
  state.prompt = { ...state.prompt, text, mode: 'custom', source };
  $('#promptInput').value = text;
  renderPromptMeta();
}

// ====================================================================== studio bindings
function bindStudio() {
  $('#fileInput').addEventListener('change', (e) => {
    handleFiles([...e.target.files]);
    e.target.value = '';
  });
  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, () => dz.classList.add('over')));
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, () => dz.classList.remove('over')));

  $('#inspector').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const c = state.controls;
    const d = t.dataset;
    const img = activeImage();
    const traits = traitsFrom(img?.analysis);
    const reject = (item) => {
      const fit = compatibility(item, traits);
      if (!fit.ok) {
        toast(`${item.label} doesn't fit this photo`, `${cap1(fit.reason)}. If the analysis is wrong, pick the right photo type in step 01.`, 'err');
        return true;
      }
      return false;
    };
    if (d.style) {
      const s = byId(STYLES, d.style);
      c.style = s.id;
      c.intensity = s.intensity;
      if (compatibility(byId(CAMERA, s.camera), traits).ok) c.camera = s.camera;
      if (s.subject) c.subject = s.subject.filter((id) => compatibility(byId(SUBJECT, id), traits).ok);
      if (s.env) c.environment = s.env.filter((id) => compatibility(byId(ENVIRONMENT, id), traits).ok);
    } else if (d.camera) {
      if (reject(byId(CAMERA, d.camera))) return;
      c.camera = d.camera;
    } else if (d.subject) {
      if (!c.subject.includes(d.subject) && reject(byId(SUBJECT, d.subject))) return;
      toggleIn(c.subject, d.subject, 3, 'subject movements');
    } else if (d.env) {
      if (!c.environment.includes(d.env) && reject(byId(ENVIRONMENT, d.env))) return;
      toggleIn(c.environment, d.env, 3, 'environment effects');
    } else if (d.protect) {
      toggleIn(c.protections, d.protect, 10);
    } else if (d.intensity) c.intensity = d.intensity;
    else if (d.category) {
      if (!img) return toast('Upload a photo first');
      img.analysis = { ...(img.analysis || {}), category: d.category, source: img.analysis?.source === 'ai' ? 'ai-corrected' : 'user', people: undefined, faceVisible: ['portrait', 'group', 'wedding'].includes(d.category) ? true : undefined, hasSky: undefined, hasFoliage: undefined, hasWater: undefined, hasHair: undefined, hasFabric: undefined };
      saveImageProject(img);
      renderAnalysis();
      pruneIncompatible();
    } else if (d.model) {
      c.provider = d.provider || c.provider;
      c.model = d.model;
      syncModelControls();
      state.settings.provider = c.provider;
      state.settings.model = d.model;
      settingsStore.save(state.settings);
      renderFrame();
    } else if (d.duration) c.duration = Number(d.duration);
    else if (d.resolution) {
      c.resolution = d.resolution;
      syncModelControls();
      renderFrame();
    } else if (d.ratio) {
      c.ratio = d.ratio;
      renderFrame();
    } else return;
    if (!d.category) state.touched = true;
    renderControls();
    updatePrompt();
  });

  $('#promptInput').addEventListener('input', () => {
    state.prompt.mode = 'custom';
    state.prompt.source = 'user';
    state.prompt.text = $('#promptInput').value;
    renderPromptMeta();
  });
  $('#rebuildPrompt').addEventListener('click', () => updatePrompt(true));
  $('#enhancePrompt').addEventListener('click', enhance);
  $('#audioToggle').addEventListener('change', (e) => (state.controls.audio = e.target.checked));
  $('#seedInput').addEventListener('input', (e) => (state.controls.seed = e.target.value.replace(/\D/g, '')));
  $('#applyRecommend').addEventListener('click', () => {
    const img = activeImage();
    if (!img?.analysis) return;
    applyAnalysisRecommendation(img.analysis);
    toast('Recommendation applied', $('#recommendText').textContent, 'ok');
  });
  $('#generateBtn').addEventListener('click', () => startMainGeneration());
  $('#removeImage').addEventListener('click', removeActiveImage);
  $('#genCancel').addEventListener('click', cancelMain);
  $('#genRetry').addEventListener('click', () => startMainGeneration(state.job?.retryOverrides));
  $('#genBack').addEventListener('click', () => {
    setStage('preview');
  });
  $('#btnAgain').addEventListener('click', () => {
    const g = viewedGen();
    if (g) startMainGeneration({ fromGen: g, label: 'Generate again' });
  });
  $('#btnEdit').addEventListener('click', () => {
    const g = viewedGen();
    if (g?.controls) {
      Object.assign(state.controls, g.controls);
      syncModelControls();
      renderControls();
      if (g.promptSource === 'engine') updatePrompt(true);
      else setPrompt(g.prompt, g.promptSource || 'user');
    }
    setStage('preview');
    document.querySelector('.insp-scroll').scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#btnVariation').addEventListener('click', () => {
    $('#variations').hidden = false;
    renderVariations();
    $('#variations').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('#btnDownload').addEventListener('click', () => downloadGen(viewedGen()));
  bindFrameDrag();
}
const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function toggleIn(arr, id, max, what) {
  const i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1);
  else if (arr.length >= max) toast(`Up to ${max} ${what}`, 'Fewer, well-chosen motions look more natural.');
  else arr.push(id);
}

function pruneIncompatible() {
  const traits = traitsFrom(activeImage()?.analysis);
  const c = state.controls;
  c.subject = c.subject.filter((id) => compatibility(byId(SUBJECT, id), traits).ok);
  c.environment = c.environment.filter((id) => compatibility(byId(ENVIRONMENT, id), traits).ok);
  if (!compatibility(byId(CAMERA, c.camera), traits).ok) c.camera = 'push_in';
  renderControls();
  updatePrompt();
}

function applyCategoryRecipe(category, { styleOverride } = {}) {
  const rec = CATEGORY[category] || CATEGORY.other;
  const c = state.controls;
  c.camera = rec.camera;
  c.subject = [...rec.subject];
  c.environment = [...rec.env];
  c.style = styleOverride || rec.style;
  c.intensity = rec.intensity;
  if (['architecture', 'interior', 'exterior'].includes(category) && !c.protections.includes('architecture')) c.protections.push('architecture');
  renderControls();
  updatePrompt();
}

function applyAnalysisRecommendation(a) {
  const traits = traitsFrom(a);
  const c = state.controls;
  const rec = CATEGORY[a.category] || CATEGORY.other;
  const camera = a.camera && byId(CAMERA, a.camera) ? a.camera : rec.camera;
  c.camera = compatibility(byId(CAMERA, camera), traits).ok ? camera : 'push_in';
  c.subject = (a.subject?.length ? a.subject : rec.subject).filter((id) => byId(SUBJECT, id) && compatibility(byId(SUBJECT, id), traits).ok).slice(0, 3);
  c.environment = (a.environment?.length ? a.environment : rec.env).filter((id) => byId(ENVIRONMENT, id) && compatibility(byId(ENVIRONMENT, id), traits).ok).slice(0, 3);
  c.style = byId(STYLES, a.style) ? a.style : rec.style;
  c.intensity = INTENSITY[a.intensity] ? a.intensity : rec.intensity;
  if (['architecture', 'interior', 'exterior'].includes(a.category) && !c.protections.includes('architecture')) c.protections.push('architecture');
  renderControls();
  updatePrompt();
}

// ====================================================================== images
async function handleFiles(files) {
  if (!files.length) return;
  let firstId = null;
  const stage = $('#stage');
  stage.dataset.busy = '1';
  $('#generateBtn').disabled = true;
  $('.drop-title').textContent = `Importing ${files.length > 1 ? `${files.length} photos` : 'photo'}…`;
  try {
  for (const file of files) {
    try {
      const img = await addImage(file);
      firstId ||= img.id;
    } catch (e) {
      const info = e instanceof ImageError ? { title: ERROR_TITLES[e.code] || 'Invalid image', message: e.message } : errInfo(e);
      toast(info.title, info.message, 'err');
    }
  }
  } finally {
    delete stage.dataset.busy;
    $('.drop-title').textContent = 'Drop your photo here';
    $('#generateBtn').disabled = !activeImage();
  }
  if (firstId) setActive(firstId);
  if (files.length > 1 && firstId) toast(`${state.images.length} photos loaded`, 'Single-image generation uses the selected photo. Use Story Mode to turn several photos into scenes.');
}

async function addImage(file, { projectId, name } = {}) {
  const { bitmap, width, height, mime } = await loadImageFile(file);
  const id = uid('img');
  const thumb = await makeJpegDataUri(bitmap, 360, 0.78);
  const img = {
    id,
    projectId: projectId || uid('prj'),
    bitmap,
    width,
    height,
    mime,
    name: name || file.name || 'photo',
    size: file.size,
    url: URL.createObjectURL(file),
    thumb,
    focus: { x: 0.5, y: 0.5 },
    analysis: null,
    blobKey: null,
  };
  state.images.push(img);
  let project = projectStore.get(img.projectId);
  if (!project) {
    img.blobKey = `blob_${img.projectId}`;
    await imageStore.put(img.blobKey, file);
    project = {
      id: img.projectId,
      name: img.name.replace(/\.[a-z0-9]+$/i, ''),
      createdAt: new Date().toISOString(),
      thumb,
      blobKey: img.blobKey,
      image: { name: img.name, width, height, size: file.size, mime },
      analysis: null,
      focus: img.focus,
      controls: { ...state.controls },
      generations: [],
      audio: null, // reserved for future audio track
    };
    projectStore.save(project);
  } else {
    img.blobKey = project.blobKey;
    img.analysis = project.analysis;
    img.focus = project.focus || img.focus;
  }
  return img;
}

function saveImageProject(img) {
  const p = projectStore.get(img.projectId);
  if (!p) return;
  p.analysis = img.analysis;
  p.focus = img.focus;
  p.controls = { ...state.controls };
  projectStore.save(p);
}

function setActive(id) {
  if (state.job && !isTerminal(state.job.gen.status) && state.activeId !== id) {
    toast('Generation in progress', 'It keeps running — reopen this photo’s project to see it.');
  }
  state.activeId = id;
  state.viewGenId = null;
  const img = activeImage();
  $('#previewImg').src = img.url;
  $('#compareImg').src = img.thumb;
  renderFileMeta();
  renderFilmstrip();
  $('#stageBar').hidden = false;
  $('#generateBtn').disabled = false;
  $('#resultPanel').hidden = true;
  const running = state.job && !isTerminal(state.job.gen.status) && state.job.gen.projectId === img.projectId;
  setStage(running ? 'generating' : 'preview');
  $('#previewImg').onload = () => renderFrame();
  renderHistory();
  if (img.analysis) {
    renderAnalysis();
    pruneIncompatible();
  } else if (state.settings.autoAnalyze) runAnalysis(img);
  else renderAnalysis();
  updatePrompt();
  // Resume any in-flight generations for this project (e.g. after a reload)
  const p = projectStore.get(img.projectId);
  const pending = p?.generations?.find((g) => g.taskId && ['queued', 'throttled', 'running', 'submitted'].includes(g.status) && !state.jobs.has(g.id));
  if (running) return;
  if (pending && providerInfo(pending.provider)?.mode === 'stream') {
    Object.assign(pending, {
      status: 'failed',
      error: { code: 'NETWORK', title: 'Generation interrupted.', message: 'The page was closed or reloaded while the free Space was generating. Hugging Face jobs stop when the connection closes — please generate again.', details: { taskId: pending.taskId } },
    });
    persistGen(pending);
    renderHistory();
  } else if (pending) resumeGeneration(pending, img);
  else {
    const last = p?.generations?.filter((g) => g.status === 'succeeded').at(-1);
    if (last) showResult(last);
  }
}

function removeActiveImage() {
  const img = activeImage();
  if (!img) return;
  if (state.job && !isTerminal(state.job.gen.status) && state.job.img.id === img.id) return toast('Generation in progress', 'Cancel it before removing the photo.');
  state.images = state.images.filter((i) => i !== img);
  URL.revokeObjectURL(img.url);
  clearPreparedCache(img.id);
  img.bitmap.close?.();
  if (state.images.length) setActive(state.images.at(-1).id);
  else {
    state.activeId = null;
    setStage('empty');
    $('#stageBar').hidden = true;
    $('#filmstrip').hidden = true;
    $('#resultPanel').hidden = true;
    $('#history').hidden = true;
    $('#generateBtn').disabled = true;
    renderAnalysis();
    renderControls();
    updatePrompt();
  }
  toast('Photo removed from the studio', 'The project stays in Projects until you delete it there.');
}

function renderFileMeta() {
  const img = activeImage();
  if (!img) return;
  $('#fileMeta').innerHTML = `<span class="name" title="${esc(img.name)}">${esc(img.name)}</span><span><b>${img.width}×${img.height}</b> px</span><span><b>${fmtBytes(img.size)}</b></span><span>${img.mime.replace('image/', '').toUpperCase()}</span>`;
}
function renderFilmstrip() {
  const fs = $('#filmstrip');
  fs.hidden = state.images.length < 2;
  fs.innerHTML = state.images
    .map((i) => {
      const n = projectStore.get(i.projectId)?.generations?.filter((g) => g.status === 'succeeded').length || 0;
      return `<button class="film ${i.id === state.activeId ? 'active' : ''}" data-img="${i.id}" title="${esc(i.name)}"><img src="${i.thumb}" alt="">${n ? `<span class="gcount">${n}▶</span>` : ''}</button>`;
    })
    .join('');
  fs.onclick = (e) => {
    const b = e.target.closest('[data-img]');
    if (b && b.dataset.img !== state.activeId) setActive(b.dataset.img);
  };
}

// ---------------------------------------------------------------- crop frame
function renderFrame() {
  const img = activeImage();
  const el = $('#previewImg');
  const win = $('#frameWindow');
  if (!img || !el.clientWidth) return;
  const c = caps();
  const ratio = parseRatio(state.controls.ratio).r;
  const rect = cropRect(img.width, img.height, ratio, img.focus);
  const s = el.clientWidth / img.width;
  Object.assign(win.style, { left: `${rect.x * s}px`, top: `${rect.y * s}px`, width: `${rect.w * s}px`, height: `${rect.h * s}px` });
  $('#frameTag').textContent = `${ratioInfo(state.controls.ratio)?.aspect || ''} · ${state.controls.resolution}${c ? '' : ''}`;
}
function bindFrameDrag() {
  const win = $('#frameWindow');
  let start = null;
  win.addEventListener('pointerdown', (e) => {
    const img = activeImage();
    if (!img || $('#stage').dataset.state !== 'preview') return;
    start = { x: e.clientX, y: e.clientY, focus: { ...img.focus } };
    win.setPointerCapture(e.pointerId);
    win.classList.add('dragging');
  });
  win.addEventListener('pointermove', (e) => {
    if (!start) return;
    const img = activeImage();
    const el = $('#previewImg');
    const nx = start.focus.x + (e.clientX - start.x) / el.clientWidth;
    const ny = start.focus.y + (e.clientY - start.y) / el.clientHeight;
    const rect = cropRect(img.width, img.height, parseRatio(state.controls.ratio).r, { x: nx, y: ny });
    img.focus = { x: (rect.x + rect.w / 2) / img.width, y: (rect.y + rect.h / 2) / img.height };
    renderFrame();
  });
  const end = () => {
    if (!start) return;
    start = null;
    win.classList.remove('dragging');
    saveImageProject(activeImage());
  };
  win.addEventListener('pointerup', end);
  win.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------- analysis
async function runAnalysis(img) {
  renderAnalysis('running');
  let result = null;
  if (state.health?.assistant) {
    try {
      const preview = await makeJpegDataUri(img.bitmap, 768, 0.82);
      result = await api.analyze(preview);
    } catch (e) {
      toast('AI photo analysis unavailable — used the on-device scan instead', errInfo(e).message);
    }
  }
  if (!result) result = await analyzeOnDevice(img.bitmap);
  img.analysis = result;
  saveImageProject(img);
  if (img.id !== state.activeId) return;
  renderAnalysis();
  if (!state.touched) applyAnalysisRecommendation(result);
  else pruneIncompatible();
}

function renderAnalysisBadge() {
  const img = activeImage();
  const b = $('#analysisSource');
  if (!img) {
    b.textContent = state.health?.assistant ? 'AI assistant ready' : 'Waiting for photo';
    b.className = 'badge';
    return;
  }
  const src = img.analysis?.source;
  b.textContent = !img.analysis ? 'Analysing…' : src === 'ai' ? 'AI analysis' : src === 'device' ? 'On-device scan' : 'Set by you';
  b.className = `badge ${src === 'ai' ? 'ai' : ''}`;
}

function renderAnalysis(mode) {
  const img = activeImage();
  renderAnalysisBadge();
  const sum = $('#analysisSummary');
  const rec = $('#recommend');
  if (!img) {
    sum.textContent = 'Upload a photo to analyse subject, scene and suitable motion.';
    rec.hidden = true;
    return;
  }
  if (mode === 'running' || !img.analysis) {
    sum.textContent = state.health?.assistant ? 'Analysing the photo with the AI assistant…' : 'Scanning the photo on this device…';
    rec.hidden = true;
    $$('[data-category]').forEach((b) => b.classList.remove('on'));
    return;
  }
  const a = img.analysis;
  const cat = CATEGORY[a.category] || CATEGORY.other;
  const conf = a.confidence ? ` · ${Math.round(a.confidence * 100)}% confidence` : '';
  const bits = [];
  if (a.summary) bits.push(a.summary);
  else bits.push(`Looks like ${/^[aeiou]/i.test(cat.label) ? 'an' : 'a'} ${cat.label.toLowerCase()} photo${conf}.`);
  if (a.source === 'device') bits.push('Heuristic scan (no AI assistant configured) — correct the type if needed.');
  if (a.people != null && a.source === 'ai') bits.push(`${a.people} ${a.people === 1 ? 'person' : 'people'} visible.`);
  if (a.avoid?.length) bits.push(`Avoid: ${a.avoid.slice(0, 2).join('; ')}.`);
  sum.textContent = bits.join(' ');
  $('#recommendText').textContent = cat.recommend;
  rec.hidden = false;
  $$('[data-category]').forEach((b) => b.classList.toggle('on', b.dataset.category === a.category));
}

// ====================================================================== generation
const STEPS = [
  { id: 'prepare', label: 'Preparing image', sub: 'Crop to output ratio · encode once' },
  { id: 'prompt', label: 'Building motion prompt', sub: 'Camera · subject · environment · timing' },
  { id: 'send', label: 'Sending to AI model', sub: 'Your backend → provider API' },
  { id: 'queue', label: 'Queued at provider', sub: 'Waiting for a GPU' },
  { id: 'render', label: 'Generating frames & motion', sub: 'Model running' },
  { id: 'final', label: 'Finalizing video', sub: 'Finished · loading output' },
];
const isTerminal = (s) => ['succeeded', 'failed', 'cancelled', 'timeout'].includes(s);

function setStage(s) {
  $('#stage').dataset.state = s;
  if (s === 'preview') requestAnimationFrame(renderFrame);
  if (s !== 'result') {
    const v = $('#video');
    v.pause();
  }
}

function stepsUI() {
  const ol = $('#genSteps');
  ol.innerHTML = STEPS.map((s, i) => `<li data-step="${s.id}"><span class="n">0${i + 1}</span><span class="t">${s.label}<small>${s.sub}</small></span><span class="s">—</span></li>`).join('');
  return {
    set(id, status, note) {
      const li = ol.querySelector(`[data-step="${id}"]`);
      if (!li) return;
      const idx = STEPS.findIndex((s) => s.id === id);
      if (status === 'active' || status === 'done') {
        // Any earlier step that's still pending is complete by definition.
        STEPS.slice(0, idx).forEach((s) => {
          const prev = ol.querySelector(`[data-step="${s.id}"]`);
          if (!prev.classList.contains('done') && !prev.classList.contains('failed')) {
            prev.className = 'done';
            prev.querySelector('.s').textContent = 'Done';
          }
        });
      }
      li.className = status;
      li.querySelector('.s').textContent = { active: 'Now', done: 'Done', failed: 'Failed', skipped: 'Skipped' }[status] || '—';
      if (note) li.querySelector('small').textContent = note;
    },
    failCurrent(note) {
      const active = ol.querySelector('li.active') || ol.querySelector('li:not(.done)');
      if (active) this.set(active.dataset.step, 'failed', note);
    },
  };
}

function snapshotControls() {
  return JSON.parse(JSON.stringify(state.controls));
}

function newGeneration(img, overrides = {}) {
  const c = overrides.controls || snapshotControls();
  const m = caps(c.provider, c.model);
  const prompt = overrides.prompt ?? (state.prompt.text || '').trim();
  const negativePrompt = overrides.negativePrompt ?? buildPrompt({ ...c, analysis: img.analysis, caps: m }).negativePrompt;
  const seedRaw = overrides.seed ?? c.seed;
  const r = ratioInfo(c.ratio, m);
  return {
    id: uid('gen'),
    projectId: img.projectId,
    label: overrides.label || 'Original',
    provider: c.provider,
    model: c.model,
    modelLabel: m?.label || c.model,
    prompt,
    promptSource: overrides.promptSource || state.prompt.source,
    negativePrompt,
    duration: c.duration,
    ratio: c.ratio,
    aspect: r?.aspect,
    resolution: r?.resolution,
    seed: seedRaw === '' || seedRaw == null ? undefined : Number(seedRaw),
    audio: m?.audio ? Boolean(c.audio) : undefined,
    focus: { ...img.focus },
    controls: c,
    status: 'preparing',
    progress: null,
    createdAt: new Date().toISOString(),
  };
}

function persistGen(gen) {
  const p = projectStore.get(gen.projectId);
  if (!p) return;
  const clean = { ...gen };
  delete clean._abort;
  const i = p.generations.findIndex((g) => g.id === gen.id);
  if (i >= 0) p.generations[i] = clean;
  else p.generations.push(clean);
  if (gen.status === 'succeeded') p.lastGeneratedAt = gen.completedAt;
  projectStore.save(p);
}

/**
 * Real generation pipeline. hooks: { step(id,status,note), update(gen), success(gen), error(gen, info) }
 */
async function runGeneration(gen, img, hooks = {}) {
  const job = { gen, img, abort: new AbortController() };
  state.jobs.set(gen.id, job);
  const step = hooks.step || (() => {});
  const set = (patch) => {
    Object.assign(gen, patch);
    persistGen(gen);
    hooks.update?.(gen);
  };
  try {
    // 01 — prepare
    step('prepare', 'active');
    const m = caps(gen.provider, gen.model);
    if (!m) throw new ApiError({ code: 'UNSUPPORTED_OPTION', message: `Model ${gen.model} is not in the configuration.` });
    const maxBytes = Math.min(state.catalog?.limits?.maxImageDataUriBytes || 4e6, 3_600_000);
    const prepared = await prepareForGeneration(img.id, img.bitmap, gen.ratio, gen.focus, { maxDataUriBytes: maxBytes });
    job.prepared = prepared;
    step('prepare', 'done', `${prepared.width}×${prepared.height} JPEG · ${fmtBytes(prepared.bytes)} encoded`);

    // 02 — prompt
    step('prompt', 'active');
    if (!gen.prompt && m.promptRequired) throw new ApiError({ code: 'INVALID_REQUEST', message: `${m.label} needs a motion prompt. Use Rebuild or Enhance Prompt.` });
    if (gen.prompt.length > m.promptMaxChars) throw new ApiError({ code: 'PROMPT_TOO_LONG', message: `Prompt is ${gen.prompt.length} characters; ${m.label} accepts ${m.promptMaxChars}.` });
    step('prompt', 'done', `${gen.prompt.length} characters${gen.negativePrompt ? ' + negative prompt' : ''}`);

    // 03 — submit
    step('send', 'active', `POST ${api.base || ''}/api/generate → ${providerInfo(gen.provider)?.label || gen.provider}`);
    set({ status: 'submitting' });
    const streamed = providerInfo(gen.provider)?.mode === 'stream';
    const onEvent = (ev) => {
      if (ev.type === 'accepted') {
        set({ taskId: ev.taskId, status: 'queued', submittedAt: new Date().toISOString(), space: ev.space });
        step('send', 'done', `Accepted by ${ev.space}`);
      } else if (ev.type === 'queued') {
        set({ status: 'queued' });
        step('queue', 'active', `In the Space queue${ev.size ? ` · position ${ev.position + 1} of ${ev.size}` : ''}${ev.eta ? ` · ETA ~${Math.round(ev.eta)}s` : ''}`);
      } else if (ev.type === 'started') {
        set({ status: 'running' });
        step('render', 'active', 'GPU allocated — the model is running');
      } else if (ev.type === 'progress') {
        set({ status: 'running', progress: ev.progress });
        step('render', 'active', `${ev.desc} step ${Math.min(ev.step + 1, ev.steps)} of ${ev.steps} — reported by the Space`);
      }
    };
    const r = await api.generate(
      {
        provider: gen.provider,
        model: gen.model,
        image: prepared.dataUri,
        prompt: gen.prompt,
        negativePrompt: gen.negativePrompt || undefined,
        duration: gen.duration,
        ratio: gen.ratio,
        seed: gen.seed,
        audio: gen.audio,
      },
      streamed ? { onEvent, signal: job.abort.signal, timeoutMs: Math.max(3, Number(state.settings.timeoutMin) || 15) * 60_000 } : {}
    );
    if (r.stream) {
      // 06 — finalize: copy the temporary Space file into this browser so it never expires.
      hooks.progressDone?.();
      step('final', 'active', 'Saving the video from the Space to this browser');
      let blob = null;
      let saveError = null;
      for (let attempt = 0; attempt < 2 && !blob; attempt++) {
        try {
          blob = await api.downloadBlob(gen.provider, null, `gen-${gen.id}`, r.outputs[0]);
        } catch (err) {
          saveError = err;
        }
      }
      if (blob) {
        await imageStore.put(`video_${gen.id}`, blob);
        set({ status: 'succeeded', progress: 1, videoUrl: r.outputs[0], localVideo: true, videoBytes: blob.size, seedUsed: r.seed, completedAt: new Date().toISOString() });
      } else {
        // Couldn't copy it — still show the real result straight from the Space.
        set({ status: 'succeeded', progress: 1, videoUrl: r.outputs[0], localVideo: false, remoteOnly: true, seedUsed: r.seed, completedAt: new Date().toISOString(), saveError: errInfo(saveError).message });
        toast('Video ready, but not saved to this browser', 'Playing it directly from the Space. Download it soon — Space files are temporary.');
      }
      hooks.success?.(gen);
    } else {
      set({ taskId: r.taskId, status: 'queued', estimatedCredits: r.estimatedCredits, submittedAt: r.submittedAt, pollIntervalMs: r.pollIntervalMs });
      step('send', 'done', `Task accepted · ${r.taskId.slice(0, 13)}…`);
      await pollGeneration(job, hooks);
    }
  } catch (e) {
    if (job.abort.signal.aborted || e?.code === 'CANCELLED') {
      set({ status: 'cancelled', completedAt: new Date().toISOString() });
      hooks.cancelled?.(gen);
    } else {
      const info = errInfo(e);
      set({ status: 'failed', error: info, completedAt: new Date().toISOString() });
      hooks.error?.(gen, info);
    }
  } finally {
    state.jobs.delete(gen.id);
  }
  return gen;
}

async function pollGeneration(job, hooks = {}) {
  const { gen } = job;
  const step = hooks.step || (() => {});
  const set = (patch) => {
    Object.assign(gen, patch);
    persistGen(gen);
    hooks.update?.(gen);
  };
  const started = Date.parse(gen.submittedAt || gen.createdAt) || Date.now();
  const timeoutMs = Math.max(3, Number(state.settings.timeoutMin) || 15) * 60_000;
  const interval = Math.max(5000, gen.pollIntervalMs || providerInfo(gen.provider)?.pollIntervalMs || 5000);
  let failures = 0;
  for (;;) {
    if (job.abort.signal.aborted) return;
    if (Date.now() - started > timeoutMs) {
      const info = { code: 'TIMEOUT', title: ERROR_TITLES.TIMEOUT, message: `No result after ${Math.round(timeoutMs / 60000)} minutes. The task may still finish at the provider — reopen this project later to check again.`, details: { taskId: gen.taskId } };
      set({ status: 'timeout', error: info });
      step('render', 'failed', 'Stopped waiting (timeout)');
      hooks.error?.(gen, info);
      return;
    }
    let s;
    try {
      s = await api.status(gen.provider, gen.taskId);
      failures = 0;
    } catch (e) {
      if (e.retryable && ++failures < 4) {
        hooks.note?.(`Connection hiccup (${e.code}); retrying…`);
        await sleep(interval, job.abort.signal);
        continue;
      }
      throw e;
    }
    const credits = s.credits || {};
    if (s.state === 'queued' || s.state === 'throttled') {
      set({ status: s.state, progress: null, estimatedCredits: credits.estimated ?? gen.estimatedCredits });
      step('queue', 'active', s.state === 'throttled' ? 'THROTTLED — waiting for a free slot on your provider tier' : 'PENDING — waiting for a GPU');
    } else if (s.state === 'running') {
      set({ status: 'running', progress: s.progress, estimatedCredits: credits.estimated ?? gen.estimatedCredits });
      step('render', 'active', s.progress != null ? `RUNNING — ${Math.round(s.progress * 100)}% reported by provider` : 'RUNNING — provider did not report a percentage');
    } else if (s.state === 'succeeded') {
      if (!s.outputs?.length) throw new ApiError({ code: 'PROVIDER_ERROR', message: 'Provider reported success but returned no video URL.' });
      set({ status: 'succeeded', progress: 1, videoUrl: s.outputs[0], videoUrlAt: new Date().toISOString(), chargedCredits: credits.charged, completedAt: new Date().toISOString() });
      step('final', 'active', 'SUCCEEDED — loading the video file');
      hooks.progressDone?.();
      hooks.success?.(gen);
      return;
    } else if (s.state === 'failed') {
      const fc = s.failureCode || '';
      const code = /SAFETY/.test(fc) ? 'CONTENT_MODERATION' : fc === 'ASSET.INVALID' ? 'INVALID_IMAGE' : fc.startsWith('THIRD_PARTY') ? 'PROVIDER_UNAVAILABLE' : 'GENERATION_FAILED';
      const info = { code, title: ERROR_TITLES[code], message: `${providerInfo(gen.provider)?.label || 'Provider'}: ${s.failure || 'The task failed without a reason.'}`, details: { failureCode: fc || null, taskId: gen.taskId, chargedCredits: credits.charged } };
      set({ status: 'failed', error: info, chargedCredits: credits.charged, completedAt: new Date().toISOString() });
      step(gen.progress != null ? 'render' : 'queue', 'failed', fc || 'FAILED');
      hooks.error?.(gen, info);
      return;
    } else if (s.state === 'cancelled') {
      set({ status: 'cancelled', completedAt: new Date().toISOString() });
      hooks.cancelled?.(gen);
      return;
    }
    await sleep(interval, job.abort.signal);
  }
}

// ---------------------------------------------------------------- main stage job
let elapsedTimer = null;
function mainHooks(gen, ui) {
  return {
    step: (id, st, note) => ui.set(id, st, note),
    note: (msg) => ($('#genCredits').textContent = msg),
    progressDone: () => {
      $('#genBar').style.width = '100%';
      $('#genPct').textContent = '100%';
    },
    update(g) {
      $('#genTask').textContent = g.taskId || '—';
      const wrap = $('#genProgressWrap');
      if (g.progress != null && g.status === 'running') {
        wrap.hidden = false;
        $('#genBar').style.width = `${Math.round(g.progress * 100)}%`;
        $('#genPct').textContent = `${Math.round(g.progress * 100)}%`;
      }
      const cr = g.chargedCredits ?? g.estimatedCredits;
      $('#genCredits').textContent = cr != null ? `${g.chargedCredits != null ? 'Charged' : 'Estimated by provider'}: ${cr} credits` : '';
      if (g.taskId) $('#genCancel').disabled = false;
    },
    success(g) {
      clearInterval(elapsedTimer);
      renderFilmstrip();
      if (activeImage()?.projectId === g.projectId) showResult(g, { fromJob: true, ui });
      else toast('Video ready', `“${projectStore.get(g.projectId)?.name || 'Project'}” finished — select its photo to watch it.`, 'ok');
    },
    error(g, info) {
      clearInterval(elapsedTimer);
      ui.failCurrent();
      showGenError(info);
      toast(info.title, info.message, 'err');
    },
    cancelled(g) {
      clearInterval(elapsedTimer);
      toast('Generation cancelled', 'The provider task was cancelled.');
      if (activeImage()?.projectId === g.projectId) setStage('preview');
    },
  };
}

function openGenOverlay(gen) {
  setStage('generating');
  $('#genEyebrow').textContent = `Generating with ${gen.modelLabel}`;
  $('#genError').hidden = true;
  $('#genActions').hidden = false;
  $('#genProgressWrap').hidden = true;
  $('#genBar').style.width = '0';
  $('#genTask').textContent = gen.taskId || '—';
  $('#genCredits').textContent = '';
  $('#genCancel').disabled = !gen.taskId && providerInfo(gen.provider)?.mode !== 'stream';
  const t0 = Date.parse(gen.createdAt) || Date.now();
  clearInterval(elapsedTimer);
  const tick = () => ($('#genElapsed').textContent = fmtTime((Date.now() - t0) / 1000));
  tick();
  elapsedTimer = setInterval(tick, 1000);
  $('#resultPanel').hidden = true;
  return stepsUI();
}

function showGenError(info) {
  $('#genError').hidden = false;
  $('#genActions').hidden = true;
  $('#genErrTitle').textContent = info.title;
  $('#genErrMsg').textContent = info.message;
  $('#genErrDetails').textContent = JSON.stringify(info.details || {}, null, 2);
}

async function startMainGeneration(opts = {}) {
  const img = activeImage();
  if (!img) return toast('Upload a photo first');
  if (state.job && !isTerminal(state.job.gen.status)) return toast('A generation is already running', 'Wait for it to finish or cancel it.');
  const overrides = {};
  if (opts.fromGen) {
    const g = opts.fromGen;
    Object.assign(overrides, { controls: { ...g.controls }, prompt: g.prompt, negativePrompt: g.negativePrompt, label: opts.label || g.label, promptSource: g.promptSource, seed: '' });
  } else if (opts.controls) Object.assign(overrides, opts);
  if (!overrides.prompt && !$('#promptInput').value.trim()) updatePrompt(true);
  const gen = newGeneration(img, overrides);
  if (gen.promptSource === 'engine' && !opts.fromGen) gen.prompt = currentPromptBuild().prompt;
  const ui = openGenOverlay(gen);
  state.job = { gen, img, retryOverrides: opts };
  await runGeneration(gen, img, mainHooks(gen, ui));
  renderHistory();
}

function resumeGeneration(gen, img) {
  const ui = openGenOverlay(gen);
  ['prepare', 'prompt', 'send'].forEach((s) => ui.set(s, 'done'));
  ui.set('send', 'done', `Resumed task ${gen.taskId.slice(0, 13)}…`);
  const job = { gen, img, abort: new AbortController() };
  state.jobs.set(gen.id, job);
  state.job = { gen, img };
  const hooks = mainHooks(gen, ui);
  pollGeneration(job, hooks)
    .catch((e) => {
      const info = errInfo(e);
      Object.assign(gen, { status: 'failed', error: info });
      persistGen(gen);
      hooks.error(gen, info);
    })
    .finally(() => state.jobs.delete(gen.id));
}

async function cancelMain() {
  const j = state.job;
  if (!j) return;
  if (providerInfo(j.gen.provider)?.mode === 'stream') {
    state.jobs.get(j.gen.id)?.abort.abort(); // closing the stream cancels the Space job
    return;
  }
  if (!j.gen.taskId) return;
  const btn = $('#genCancel');
  btn.classList.add('loading');
  try {
    await api.cancel(j.gen.provider, j.gen.taskId);
    state.jobs.get(j.gen.id)?.abort.abort();
    j.gen.status = 'cancelled';
    j.gen.completedAt = new Date().toISOString();
    persistGen(j.gen);
    clearInterval(elapsedTimer);
    setStage('preview');
    toast('Generation cancelled', 'The provider task was cancelled.');
  } catch (e) {
    const info = errInfo(e);
    toast('Could not cancel', info.message, 'err');
  } finally {
    btn.classList.remove('loading');
    renderHistory();
  }
}

// ---------------------------------------------------------------- result
function viewedGen() {
  const img = activeImage();
  const p = img && projectStore.get(img.projectId);
  return p?.generations.find((g) => g.id === state.viewGenId) || null;
}

async function refreshUrlIfStale(gen) {
  const age = Date.now() - Date.parse(gen.videoUrlAt || gen.completedAt || 0);
  if (gen.videoUrl && age < 12 * 3600_000) return gen.videoUrl;
  const s = await api.status(gen.provider, gen.taskId);
  if (s.state === 'succeeded' && s.outputs?.[0]) {
    gen.videoUrl = s.outputs[0];
    gen.videoUrlAt = new Date().toISOString();
    persistGen(gen);
    return gen.videoUrl;
  }
  throw new ApiError({ code: 'NOT_FOUND', message: `The provider no longer has this video (task ${s.state}).` });
}

const objectUrls = new Map();
async function localVideoUrl(genId) {
  if (objectUrls.has(genId)) return objectUrls.get(genId);
  const blob = await imageStore.get(`video_${genId}`);
  if (!blob) throw new ApiError({ code: 'NOT_FOUND', message: 'This video is no longer stored in this browser (site data was cleared).' });
  const u = URL.createObjectURL(blob);
  objectUrls.set(genId, u);
  return u;
}

async function showResult(gen, { fromJob = false, ui } = {}) {
  const img = activeImage();
  if (!img || gen.projectId !== img.projectId) return;
  state.viewGenId = gen.id;
  const video = $('#video');
  let url;
  try {
    url = gen.localVideo ? await localVideoUrl(gen.id) : fromJob || gen.remoteOnly ? gen.videoUrl : await refreshUrlIfStale(gen);
  } catch (e) {
    toast('Could not load the saved video', errInfo(e).message, 'err');
    return;
  }
  const loaded = new Promise((resolve, reject) => {
    video.onloadeddata = resolve;
    video.onerror = () => reject(new Error('The browser could not load the video file.'));
  });
  video.src = url;
  video.muted = true;
  let loadedOk = false;
  for (let attempt = 0; attempt < (gen.remoteOnly ? 6 : 1) && !loadedOk; attempt++) {
    try {
      if (attempt) {
        await sleep(800);
        const again = new Promise((resolve, reject) => {
          video.onloadeddata = resolve;
          video.onerror = () => reject(new Error('The browser could not load the video file.'));
        });
        video.src = `${url}${url.includes('?') ? '&' : '?'}r=${attempt}`;
        await again;
      } else await loaded;
      loadedOk = true;
    } catch (e) {
      if (gen.remoteOnly && attempt < 5) continue;
      loadedOk = e;
    }
  }
  try {
    if (loadedOk !== true) throw loadedOk;
  } catch (e) {
    if (fromJob) {
      ui?.set('final', 'failed', e.message);
      showGenError({ title: 'The video was generated but could not be loaded.', message: `${e.message} You can still try downloading it.`, details: { url } });
      return;
    }
    if (gen.localVideo) return toast('Could not play the saved video', e.message, 'err');
    if (gen.remoteOnly) return toast('This video is no longer on the Space', 'Space files are temporary and it was not saved to this browser. Generate it again.', 'err');
    // Stale URL? refresh once.
    try {
      gen.videoUrlAt = null;
      video.src = await refreshUrlIfStale(gen);
    } catch (err) {
      return toast('Could not load the saved video', errInfo(err).message, 'err');
    }
  }
  ui?.set('final', 'done', 'Video ready');
  gen.videoMeta = { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
  persistGen(gen);
  // Before/after uses exactly the frame that was sent.
  prepareForGeneration(img.id, img.bitmap, gen.ratio, gen.focus || img.focus)
    .then((p) => ($('#compareImg').src = p.dataUri))
    .catch(() => {});
  setStage('result');
  video.play().catch(() => {});
  renderResultPanel(gen);
  renderHistory();
  if (fromJob) toast('Video generated', `${gen.modelLabel} · ${gen.duration}s · ${gen.aspect}`, 'ok');
}

function renderResultPanel(gen) {
  $('#resultPanel').hidden = false;
  $('#resultTitle').textContent = gen.variationOf ? gen.label : `${gen.label} · ${byId(CAMERA, gen.controls?.camera)?.label || 'Custom motion'}`;
  const vm = gen.videoMeta || {};
  const credits = gen.chargedCredits ?? gen.estimatedCredits;
  const rows = [
    ['Resolution', vm.width ? `${vm.width}×${vm.height}` : gen.resolution],
    ['Duration', vm.duration ? `${vm.duration.toFixed(1)} s` : `${gen.duration} s`],
    ['Model', gen.modelLabel],
    ['Aspect', gen.aspect],
    ['Generated', fmtDate(gen.completedAt)],
    ['Credits', credits != null ? `${credits}${gen.chargedCredits != null ? ' charged' : ' est.'}` : '—'],
    ['Seed', gen.seed ?? 'random'],
    ['Task', `<code title="${esc(gen.taskId)}">${esc(gen.taskId?.slice(0, 10))}…</code>`],
  ];
  $('#resultMeta').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${typeof v === 'string' && v.startsWith('<code') ? v : esc(v)}</dd></div>`).join('');
  $('#resultPrompt').textContent = gen.prompt || '(no prompt)';
  $('#resultNeg').textContent = gen.negativePrompt ? `Negative prompt: ${gen.negativePrompt}` : '';
  if (!$('#variations').hidden) renderVariations();
}

function renderHistory() {
  const img = activeImage();
  const p = img && projectStore.get(img.projectId);
  const gens = (p?.generations || []).filter((g) => g.taskId || g.status === 'failed').slice().reverse();
  $('#history').hidden = !gens.length;
  $('#historyRow').innerHTML = gens
    .map((g) => {
      const st = { succeeded: '▶ ready', failed: 'failed', cancelled: 'cancelled', timeout: 'timed out', running: 'running', queued: 'queued', throttled: 'throttled' }[g.status] || g.status;
      return `<button class="hist ${g.id === state.viewGenId ? 'active' : ''}" data-gen="${g.id}"><div class="thumb" style="background-image:url('${p.thumb}')"><span class="st">${st}</span></div>
      <div class="info"><b>${esc(g.variationOf ? g.label : `${g.label} · ${byId(CAMERA, g.controls?.camera)?.label || ''}`)}</b>${esc(g.modelLabel)} · ${g.duration}s · ${fmtDate(g.createdAt)}</div></button>`;
    })
    .join('');
  $('#historyRow').onclick = (e) => {
    const b = e.target.closest('[data-gen]');
    if (!b) return;
    const g = p.generations.find((x) => x.id === b.dataset.gen);
    if (g.status === 'succeeded') showResult(g);
    else if (g.error) {
      setStage('generating');
      stepsUI().set('final', 'failed');
      $('#genEyebrow').textContent = `${g.modelLabel} · ${fmtDate(g.createdAt)}`;
      showGenError(g.error);
    } else toast(`This generation is ${g.status}`);
  };
}

// ---------------------------------------------------------------- variations
function variationPrompt(base, camera) {
  const img = activeImage();
  const m = caps(base.controls.provider, base.controls.model);
  const extra = base.promptSource === 'engine' ? '' : residualActions(base.prompt);
  return buildPrompt({ ...base.controls, camera, analysis: img?.analysis, caps: m, extra });
}

function renderVariations() {
  const base = viewedGen();
  if (!base) return;
  const p = projectStore.get(base.projectId);
  const traits = traitsFrom(activeImage()?.analysis);
  $('#varGrid').innerHTML = VARIATIONS.map((v) => {
    const existing = p.generations.filter((g) => g.variationOf === base.id && g.variationKey === v.id).at(-1);
    const fit = compatibility(byId(CAMERA, v.camera), traits);
    const st = existing ? existing.status : '';
    const stLabel = { succeeded: 'Ready ▶', failed: 'Failed', running: existing?.progress != null ? `Running ${Math.round(existing.progress * 100)}%` : 'Running', queued: 'Queued', throttled: 'Throttled', preparing: 'Preparing', submitting: 'Submitting', cancelled: 'Cancelled', timeout: 'Timed out' }[st] || '';
    const busy = existing && !isTerminal(st);
    return `<div class="var-card"><h5>${v.label}</h5><p>${esc(byId(CAMERA, v.camera).hint)}</p>
      ${stLabel ? `<span class="state ${st === 'succeeded' ? 'ok' : st === 'failed' ? 'err' : ''}">${stLabel}</span>` : ''}
      ${existing?.status === 'succeeded' ? `<button class="btn btn-ghost btn-s" data-view-gen="${existing.id}">View</button>` : ''}
      <button class="btn btn-accent btn-s" data-var="${v.id}" ${busy || !fit.ok ? 'disabled' : ''} title="${fit.ok ? '' : esc(fit.reason)}">${existing ? 'Regenerate' : 'Generate'}</button></div>`;
  }).join('');
  const c = caps(base.provider, base.model);
  const est = c?.creditsPerSecond ? ` (~${c.creditsPerSecond * base.duration} credits each)` : '';
  $('#variations .section-head p').textContent = `Same photo, different camera language. Each variation is a separate real generation${est}.`;
  $('#varGrid').onclick = (e) => {
    const vb = e.target.closest('[data-view-gen]');
    if (vb) return showResult(p.generations.find((g) => g.id === vb.dataset.viewGen));
    const b = e.target.closest('[data-var]');
    if (b) startVariation(base, VARIATIONS.find((v) => v.id === b.dataset.var));
  };
}

async function startVariation(base, v) {
  const img = activeImage();
  const built = variationPrompt(base, v.camera);
  const controls = { ...base.controls, camera: v.camera };
  const gen = newGeneration(img, { controls, prompt: built.prompt, negativePrompt: built.negativePrompt || base.negativePrompt, label: `Variation · ${v.label}`, promptSource: 'engine', seed: '' });
  gen.focus = base.focus || img.focus;
  gen.variationOf = base.id;
  gen.variationKey = v.id;
  persistGen(gen);
  renderVariations();
  toast(`Variation started: ${v.label}`, 'Runs in the background — you can keep watching the current video.');
  await runGeneration(gen, img, {
    update: () => renderVariations(),
    success: (g) => {
      renderVariations();
      renderHistory();
      toast(`Variation ready: ${v.label}`, 'Click “View” to play it.', 'ok');
    },
    error: (g, info) => {
      renderVariations();
      toast(`Variation failed: ${v.label}`, info.message, 'err');
    },
  });
  renderVariations();
  renderHistory();
}

// ---------------------------------------------------------------- download
async function downloadGen(gen) {
  if (!gen) return;
  const btn = $('#btnDownload');
  btn.classList.add('loading');
  const p = projectStore.get(gen.projectId);
  const name = `${(p?.name || 'cinematic').replace(/[^\w-]+/g, '-')}-${gen.label.replace(/[^\w-]+/g, '-')}-${gen.id.slice(-5)}`.toLowerCase();
  try {
    let blob = gen.localVideo ? await imageStore.get(`video_${gen.id}`) : null;
    if (!blob && gen.remoteOnly) blob = await api.downloadBlob(gen.provider, null, name, gen.videoUrl).catch(() => null);
    if (!blob && !gen.localVideo && !gen.remoteOnly) try {
      const url = await refreshUrlIfStale(gen);
      const r = await fetch(url, { mode: 'cors' });
      if (r.ok) blob = await r.blob();
    } catch {
      /* CDN without CORS → try backend proxy */
    }
    if (!blob && !gen.localVideo && !gen.remoteOnly) {
      try {
        blob = await api.downloadBlob(gen.provider, gen.taskId, name);
      } catch {
        /* proxy unavailable */
      }
    }
    if (blob) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${name}.${/webm/.test(blob.type) ? 'webm' : 'mp4'}`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
      toast('Download started', `${a.download} · ${fmtBytes(blob.size)}`, 'ok');
    } else if (gen.localVideo) {
      toast('Video not found in this browser', 'Site data may have been cleared — generate it again.', 'err');
    } else {
      window.open(gen.videoUrl, '_blank', 'noopener');
      toast('Opened the video in a new tab', 'Your browser blocked a direct download — use “Save video as…”.');
    }
  } catch (e) {
    toast('Download failed', errInfo(e).message, 'err');
  } finally {
    btn.classList.remove('loading');
  }
}

// ====================================================================== player
function bindPlayer() {
  const v = $('#video');
  const player = $('#player');
  const playIcon = () => ($('#vPlay use').setAttribute('href', v.paused ? '#i-play' : '#i-pause'), player.classList.toggle('paused', v.paused));
  $('#vPlay').onclick = () => (v.paused ? v.play() : v.pause());
  v.addEventListener('click', () => (v.paused ? v.play() : v.pause()));
  v.addEventListener('play', playIcon);
  v.addEventListener('pause', playIcon);
  $('#vRestart').onclick = () => {
    v.currentTime = 0;
    v.play();
  };
  $('#vMute').onclick = () => {
    v.muted = !v.muted;
    $('#vMute use').setAttribute('href', v.muted ? '#i-mute' : '#i-vol');
  };
  v.addEventListener('volumechange', () => $('#vMute use').setAttribute('href', v.muted ? '#i-mute' : '#i-vol'));
  $('#vFull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : (player.requestFullscreen || player.webkitRequestFullscreen)?.call(player));
  v.addEventListener('timeupdate', () => {
    $('#vTime').textContent = `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`;
    if (!seeking) $('#vSeek').value = v.duration ? (v.currentTime / v.duration) * 1000 : 0;
  });
  let seeking = false;
  $('#vSeek').addEventListener('input', (e) => {
    seeking = true;
    if (v.duration) v.currentTime = (e.target.value / 1000) * v.duration;
  });
  $('#vSeek').addEventListener('change', () => (seeking = false));
  document.addEventListener('keydown', (e) => {
    if ($('#stage').dataset.state !== 'result' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      v.paused ? v.play() : v.pause();
    }
  });
  // Before / after
  const cmp = $('#compare');
  $('#vCompare').onclick = () => {
    cmp.hidden = !cmp.hidden;
    setCompare(50);
  };
  const handle = $('#compareHandle');
  const setCompare = (pct) => {
    pct = Math.max(0, Math.min(100, pct));
    handle.style.left = `${pct}%`;
    $('#compareImg').style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
  };
  let drag = false;
  handle.addEventListener('pointerdown', (e) => {
    drag = true;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = cmp.getBoundingClientRect();
    setCompare(((e.clientX - r.left) / r.width) * 100);
  });
  handle.addEventListener('pointerup', () => (drag = false));
}

// ====================================================================== projects
function renderProjects() {
  const list = projectStore.all();
  $('#projectsEmpty').hidden = list.length > 0;
  $('#projectGrid').innerHTML = list
    .map((p) => {
      const ok = p.generations.filter((g) => g.status === 'succeeded');
      const last = ok.at(-1);
      return `<article class="project" data-project="${p.id}">
        <div class="thumb" data-open style="background-image:url('${p.thumb || ''}')"><span class="count">${ok.length} video${ok.length === 1 ? '' : 's'} · ${p.generations.length} run${p.generations.length === 1 ? '' : 's'}</span></div>
        <div class="body"><h4 title="${esc(p.name)}">${esc(p.name)}</h4>
        <span class="sub">Created ${fmtDate(p.createdAt)}</span>
        <span class="sub">${last ? `Last video ${fmtDate(last.completedAt)} · ${esc(last.modelLabel)}` : 'No videos yet'}</span>
        <div class="actions"><button class="btn btn-primary btn-s" data-open>Open</button><button class="btn btn-ghost btn-s" data-dup>Duplicate</button><button class="btn btn-danger btn-s" data-del>Delete</button></div></div></article>`;
    })
    .join('');
}
$('#projectGrid')?.addEventListener('click', async (e) => {
  const card = e.target.closest('[data-project]');
  if (!card) return;
  const id = card.dataset.project;
  if (e.target.closest('[data-open]')) return openProject(id);
  if (e.target.closest('[data-dup]')) return duplicateProject(id);
  const del = e.target.closest('[data-del]');
  if (del) {
    if (del.dataset.confirm !== '1') {
      del.dataset.confirm = '1';
      del.textContent = 'Confirm delete';
      setTimeout(() => {
        del.dataset.confirm = '';
        del.textContent = 'Delete';
      }, 3000);
      return;
    }
    const p = projectStore.get(id);
    projectStore.remove(id);
    if (p?.blobKey && !projectStore.all().some((x) => x.blobKey === p.blobKey)) imageStore.remove(p.blobKey);
    p?.generations?.filter((g) => g.localVideo).forEach((g) => imageStore.remove(`video_${g.id}`));
    state.images = state.images.filter((i) => i.projectId !== id);
    if (activeImage() == null) state.activeId = null;
    renderProjects();
    toast('Project deleted');
  }
});

async function openProject(id) {
  const existing = state.images.find((i) => i.projectId === id);
  if (existing) {
    setView('studio');
    return setActive(existing.id);
  }
  const p = projectStore.get(id);
  const blob = p && (await imageStore.get(p.blobKey));
  if (!blob) return toast('Source photo missing', 'This browser no longer has the original image for this project.', 'err');
  try {
    const file = new File([blob], p.image?.name || 'photo.jpg', { type: blob.type || p.image?.mime });
    const img = await addImage(file, { projectId: id, name: p.image?.name });
    if (p.controls) {
      Object.assign(state.controls, p.controls);
      syncModelControls();
      state.touched = true;
    }
    setView('studio');
    setActive(img.id);
    renderControls();
    updatePrompt(true);
  } catch (e) {
    toast('Could not open project', errInfo(e).message, 'err');
  }
}

async function duplicateProject(id) {
  const p = projectStore.get(id);
  if (!p) return;
  const copy = { ...JSON.parse(JSON.stringify(p)), id: uid('prj'), name: `${p.name} (copy)`, createdAt: new Date().toISOString(), generations: [] };
  const blob = await imageStore.get(p.blobKey);
  if (blob) {
    copy.blobKey = `blob_${copy.id}`;
    await imageStore.put(copy.blobKey, blob);
  }
  projectStore.save(copy);
  renderProjects();
  toast('Project duplicated', 'Settings and photo copied; generations start fresh.', 'ok');
}

// ====================================================================== settings
function renderSettings() {
  const s = state.settings;
  $('#apiBase').value = s.apiBase;
  $('#accessCode').value = s.accessCode;
  $('#prefAnalyze').checked = s.autoAnalyze;
  $('#prefProtect').checked = s.defaultProtect;
  $('#prefTimeout').value = s.timeoutMin;
  $('#prefIntensity').innerHTML = Object.entries(INTENSITY).map(([id, v]) => `<button data-pref-int="${id}" class="${s.intensity === id ? 'on' : ''}">${v.label}</button>`).join('');
  const providers = state.catalog?.providers || {};
  $('#providerSelect').innerHTML = Object.entries(providers).map(([id, p]) => `<option value="${id}" ${id === state.controls.provider ? 'selected' : ''}>${esc(p.label)}</option>`).join('') + '<option disabled>Veo direct · Kling · Luma · Seedance — add a provider module</option>';
  const models = providers[state.controls.provider]?.models || {};
  $('#modelSelect').innerHTML = Object.entries(models).map(([id, m]) => `<option value="${id}" ${id === state.controls.model ? 'selected' : ''}>${esc(m.label)}</option>`).join('');
  renderModelInfo();
  renderDiag();
}
function renderModelInfo() {
  const m = caps();
  const p = providerInfo();
  if (!m) return ($('#modelInfo').innerHTML = '');
  const d = m.durations.exact ? m.durations.exact.join(', ') : `${m.durations.min}–${m.durations.max}`;
  $('#modelInfo').innerHTML = `<span><b>${esc(m.label)}</b> — ${esc(m.description)}</span>
    <span>Durations: ${d} s · Resolutions: ${[...new Set(m.ratios.map((r) => r.resolution))].join(', ')} · Ratios: ${m.ratios.map((r) => `${r.aspect} (${r.value})`).join(', ')}</span>
    <span>Prompt ≤ ${m.promptMaxChars} chars · Negative prompt: ${m.negativePrompt ? 'yes' : 'no'} · Native audio: ${m.audio ? 'yes' : 'no'}</span>
    <span>Pricing: ${m.creditsPerSecond ? `${m.creditsPerSecond} credits/s` : 'see provider'}${m.creditsNote ? ` — ${esc(m.creditsNote)}` : ''} (<a href="${p.pricingSource}" target="_blank" rel="noopener">source</a>)</span>
    <span class="muted">Capabilities loaded from ${state.catalogSource === 'backend' ? 'your backend (/api/models)' : 'the bundled offline copy (backend unreachable)'}.</span>`;
}
function renderDiag() {
  const d = $('#diag');
  const lines = [];
  const h = state.health;
  if (!h) {
    lines.push(['Backend', `Unreachable — ${esc(state.healthError?.message || 'not checked')}`, 'bad']);
  } else {
    lines.push(['Backend', `Reachable (${esc(api.base || location.origin)})`, 'ok']);
    for (const [id, p] of Object.entries(h.providers || {})) {
      const envName = id === 'huggingface' ? 'HF_TOKEN' : 'RUNWAY_API_KEY';
      const optional = !state.catalog?.providers?.[id]?.free;
      lines.push([`${p.label} ${id === 'huggingface' ? 'token' : 'API key'}`, p.configured ? 'Configured on server' : optional ? `Not set (optional, paid) — ${envName}` : `Missing — set ${envName}`, p.configured ? 'ok' : optional ? 'mid' : 'bad']);
      if (p.account?.user) lines.push([`${p.label} account`, `@${esc(p.account.user)} · ${esc(p.account.plan)} (${esc(p.account.quotaNote)})`, 'ok']);
      else if (p.account) lines.push([`${p.label} credits`, `${p.account.creditBalance?.toLocaleString() ?? '—'}`, p.account.creditBalance > 0 ? 'ok' : 'mid']);
      if (p.accountError) lines.push([`${p.label} account`, esc(p.accountError.message), p.accountError.code === 'FORBIDDEN' ? 'mid' : 'bad']);
    }
    lines.push(['Access code', h.accessCodeRequired ? (state.settings.accessCode ? 'Required · code entered' : 'Required · enter it above') : 'Not required (set STUDIO_ACCESS_CODE for public deployments)', h.accessCodeRequired && !state.settings.accessCode ? 'mid' : 'ok']);
    lines.push(['AI assistant', h.assistant ? `Enabled via ${h.assistantProvider === 'huggingface' ? 'Hugging Face (free monthly credits)' : 'Claude'} — analysis + Enhance Prompt` : 'Off — built-in engine used', h.assistant ? 'ok' : 'mid']);
  }
  d.innerHTML = lines.map(([k, v, c]) => `<div class="line"><span>${k}</span><span class="${c}">${v}</span></div>`).join('');
}
function bindSettings() {
  $('#saveBackend').addEventListener('click', async () => {
    const btn = $('#saveBackend');
    let base = $('#apiBase').value.trim();
    if (base && !/^https?:\/\//.test(base)) base = `https://${base}`;
    if (base && location.protocol === 'https:' && base.startsWith('http://')) return toast('Use an https:// endpoint', 'Browsers block http API calls from an https page.', 'err');
    state.settings.apiBase = base.replace(/\/+$/, '');
    state.settings.accessCode = $('#accessCode').value.trim();
    settingsStore.save(state.settings);
    btn.classList.add('loading');
    await checkHealth();
    await loadCatalog();
    syncModelControls();
    renderControls();
    btn.classList.remove('loading');
    renderSettings();
    toast(state.health ? 'Backend connected' : 'Backend unreachable', state.health ? '' : state.healthError?.message, state.health ? 'ok' : 'err');
  });
  $('#providerSelect').addEventListener('change', (e) => {
    state.controls.provider = e.target.value;
    state.settings.provider = e.target.value;
    state.controls.model = Object.keys(providerInfo().models)[0];
    settingsStore.save(state.settings);
    syncModelControls();
    renderSettings();
    renderControls();
  });
  $('#modelSelect').addEventListener('change', (e) => {
    state.controls.model = e.target.value;
    state.settings.model = e.target.value;
    settingsStore.save(state.settings);
    syncModelControls();
    renderModelInfo();
    renderControls();
    updatePrompt();
  });
  $('#prefIntensity').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pref-int]');
    if (!b) return;
    state.settings.intensity = b.dataset.prefInt;
    state.controls.intensity = b.dataset.prefInt;
    settingsStore.save(state.settings);
    renderSettings();
    renderControls();
    updatePrompt();
  });
  $('#prefAnalyze').addEventListener('change', (e) => ((state.settings.autoAnalyze = e.target.checked), settingsStore.save(state.settings)));
  $('#prefProtect').addEventListener('change', (e) => ((state.settings.defaultProtect = e.target.checked), settingsStore.save(state.settings)));
  $('#prefTimeout').addEventListener('change', (e) => {
    state.settings.timeoutMin = Math.min(60, Math.max(3, Number(e.target.value) || 15));
    e.target.value = state.settings.timeoutMin;
    settingsStore.save(state.settings);
  });
  $('#clearData').addEventListener('click', async (e) => {
    const b = e.target;
    if (b.dataset.confirm !== '1') {
      b.dataset.confirm = '1';
      b.textContent = 'Click again to delete everything';
      return setTimeout(() => ((b.dataset.confirm = ''), (b.textContent = 'Delete all local projects')), 3500);
    }
    projectStore.clear();
    await imageStore.clear();
    localStorage.removeItem('cas.story.v1');
    state.story.scenes = [];
    b.dataset.confirm = '';
    b.textContent = 'Delete all local projects';
    toast('Local data deleted', 'Projects, photos and story scenes were removed from this browser.', 'ok');
  });
}

// ====================================================================== story mode
const TRANSITIONS = ['Cut', 'Crossfade', 'Dip to black', 'Whip pan'];
function saveStory() {
  const scenes = state.story.scenes.map(({ bitmap, url, playUrl, ...rest }) => rest);
  try {
    localStorage.setItem('cas.story.v1', JSON.stringify(scenes));
  } catch {
    /* quota */
  }
}
async function loadStory() {
  try {
    const scenes = JSON.parse(localStorage.getItem('cas.story.v1') || '[]');
    state.story.scenes = scenes.map((s) => (['queued', 'running', 'submitting', 'preparing', 'throttled'].includes(s.status) ? { ...s, status: 'failed', error: { message: 'Interrupted by a page reload — generate again.' } } : s));
    for (const sc of state.story.scenes) {
      if (sc.videoKey) {
        imageStore.get(sc.videoKey).then((b) => {
          if (b) {
            sc.playUrl = URL.createObjectURL(b);
            renderStory();
          }
        });
      }
    }
  } catch {
    state.story.scenes = [];
  }
}
async function addStoryFiles(files) {
  for (const file of files) {
    try {
      const { bitmap, width, height } = await loadImageFile(file);
      const id = uid('scn');
      const thumb = await makeJpegDataUri(bitmap, 480, 0.8);
      await imageStore.put(`story_${id}`, file);
      state.story.scenes.push({ id, name: file.name, width, height, thumb, camera: 'push_in', duration: caps()?.durations.presets[0] || 5, transition: 'Crossfade', prompt: '', status: 'idle', bitmap });
    } catch (e) {
      toast(e instanceof ImageError ? ERROR_TITLES[e.code] : 'Invalid image', e.message, 'err');
    }
  }
  saveStory();
  renderStory();
}
function bindStory() {
  $('#storyInput').addEventListener('change', (e) => {
    addStoryFiles([...e.target.files]);
    e.target.value = '';
  });
  $('#storyGenerate').addEventListener('click', generateStory);
  $('#renderTry').addEventListener('click', async () => {
    try {
      const r = await fetch(api.url('render'), { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      toast(`Render endpoint: HTTP ${r.status}`, j?.error?.message || 'Unexpected response', r.ok ? 'ok' : 'err');
    } catch (e) {
      toast('Render endpoint unreachable', e.message, 'err');
    }
  });
  $('#scenes').addEventListener('change', (e) => {
    const li = e.target.closest('[data-scene]');
    if (!li) return;
    const sc = state.story.scenes.find((s) => s.id === li.dataset.scene);
    const f = e.target.dataset.field;
    sc[f] = f === 'duration' ? Number(e.target.value) : e.target.value;
    saveStory();
  });
  $('#scenes').addEventListener('click', (e) => {
    const li = e.target.closest('[data-scene]');
    if (!li) return;
    const idx = state.story.scenes.findIndex((s) => s.id === li.dataset.scene);
    const sc = state.story.scenes[idx];
    if (e.target.closest('[data-up]') && idx > 0) [state.story.scenes[idx - 1], state.story.scenes[idx]] = [sc, state.story.scenes[idx - 1]];
    else if (e.target.closest('[data-down]') && idx < state.story.scenes.length - 1) [state.story.scenes[idx + 1], state.story.scenes[idx]] = [sc, state.story.scenes[idx + 1]];
    else if (e.target.closest('[data-rm]')) {
      state.story.scenes.splice(idx, 1);
      imageStore.remove(`story_${sc.id}`);
    } else if (e.target.closest('[data-gen1]')) return generateScene(sc);
    else if (e.target.closest('[data-dl]')) return downloadScene(sc);
    else return;
    saveStory();
    renderStory();
  });
}
function renderStory() {
  const scenes = state.story.scenes;
  const c = caps();
  $('#storyEmpty').hidden = scenes.length > 0;
  $('#renderCard').hidden = scenes.length < 2;
  $('#storyGenerate').disabled = !scenes.length || scenes.some((s) => ['preparing', 'submitting', 'queued', 'running', 'throttled'].includes(s.status));
  const durOpts = c?.durations.presets || [5];
  $('#scenes').innerHTML = scenes
    .map((s, i) => {
      const st = { idle: 'Not generated', preparing: 'Preparing', submitting: 'Submitting', queued: 'Queued', throttled: 'Throttled', running: s.progress != null ? `Running ${Math.round(s.progress * 100)}%` : 'Running', succeeded: 'Clip ready', failed: 'Failed', timeout: 'Timed out', cancelled: 'Cancelled' }[s.status] || s.status;
      const cls = s.status === 'succeeded' ? 'ok' : s.status === 'failed' || s.status === 'timeout' ? 'err' : s.status === 'idle' ? '' : 'run';
      return `${i ? '<li class="scene-arrow" aria-hidden="true">↓</li>' : ''}<li class="scene" data-scene="${s.id}">
        <div class="media">${s.status === 'succeeded' && (s.playUrl || s.videoUrl) ? `<video src="${esc(s.playUrl || s.videoUrl)}" muted loop playsinline autoplay></video>` : `<img src="${s.thumb}" alt="">`}<span class="num">Scene ${i + 1}</span></div>
        <div class="fields">
          <label>Motion<select class="input" data-field="camera">${CAMERA.map((cm) => `<option value="${cm.id}" ${cm.id === s.camera ? 'selected' : ''}>${cm.label}</option>`).join('')}</select></label>
          <label>Duration<select class="input" data-field="duration">${durOpts.map((d) => `<option value="${d}" ${d === s.duration ? 'selected' : ''}>${d} sec</option>`).join('')}</select></label>
          <label>Transition out<select class="input" data-field="transition">${TRANSITIONS.map((t) => `<option ${t === s.transition ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
          <label class="wide">Prompt <span class="muted">(optional — blank = built from Studio controls + this motion)</span><textarea rows="2" data-field="prompt" maxlength="${c?.promptMaxChars || 1000}" placeholder="e.g. The couple turns toward each other as petals drift past.">${esc(s.prompt)}</textarea></label>
        </div>
        <div class="side">
          <span class="st ${cls}">${esc(st)}</span>
          ${s.error ? `<span class="err">${esc(s.error.message)}</span>` : ''}
          <div class="row gap-s wrap">
            <button class="btn btn-accent btn-s" data-gen1 ${cls === 'run' ? 'disabled' : ''}>${s.status === 'succeeded' ? 'Regenerate' : 'Generate'}</button>
            ${s.status === 'succeeded' ? '<button class="btn btn-ghost btn-s" data-dl>Download</button>' : ''}
            <button class="icon-btn" data-up title="Move up">↑</button><button class="icon-btn" data-down title="Move down">↓</button><button class="icon-btn" data-rm title="Remove"><svg><use href="#i-x"/></svg></button>
          </div>
        </div></li>`;
    })
    .join('');
  const m = caps();
  if (scenes.length) $('#storyGenerate').title = `Uses ${m?.label} · ${ratioInfo(state.controls.ratio)?.aspect} from Studio video settings`;
}
async function sceneImage(sc) {
  if (sc.bitmap) return sc.bitmap;
  const blob = await imageStore.get(`story_${sc.id}`);
  if (!blob) throw new ApiError({ code: 'INVALID_IMAGE', message: 'Scene photo is missing from this browser.' });
  sc.bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  return sc.bitmap;
}
async function generateScene(sc) {
  try {
    const bitmap = await sceneImage(sc);
    const img = { id: `story_${sc.id}`, projectId: null, bitmap, focus: { x: 0.5, y: 0.5 }, analysis: null };
    const controls = { ...snapshotControls(), camera: sc.camera, duration: sc.duration };
    const m = caps(controls.provider, controls.model);
    if (!m.durations.presets.includes(controls.duration) && !(m.durations.min <= controls.duration && controls.duration <= m.durations.max)) controls.duration = m.durations.presets[0];
    const built = buildPrompt({ ...controls, analysis: null, caps: m, extra: sc.prompt ? residualActions(sc.prompt) || sc.prompt : '' });
    const gen = newGeneration(img, { controls, prompt: built.prompt, negativePrompt: built.negativePrompt, label: 'Scene', promptSource: 'engine', seed: '' });
    Object.assign(sc, { status: 'preparing', error: null, progress: null });
    renderStory();
    await runGeneration(gen, img, {
      update: (g) => {
        Object.assign(sc, { status: g.status, progress: g.progress, taskId: g.taskId, provider: g.provider });
        saveStory();
        renderStory();
      },
      success: async (g) => {
        Object.assign(sc, { status: 'succeeded', videoUrl: g.videoUrl, videoUrlAt: g.videoUrlAt, taskId: g.taskId, provider: g.provider, completedAt: g.completedAt, videoKey: g.localVideo ? `video_${g.id}` : null });
        if (sc.videoKey) sc.playUrl = URL.createObjectURL(await imageStore.get(sc.videoKey));
        saveStory();
        renderStory();
      },
      error: (g, info) => {
        Object.assign(sc, { status: g.status === 'timeout' ? 'timeout' : 'failed', error: info });
        saveStory();
        renderStory();
      },
    });
  } catch (e) {
    Object.assign(sc, { status: 'failed', error: errInfo(e) });
    saveStory();
    renderStory();
  }
}
async function generateStory() {
  const btn = $('#storyGenerate');
  btn.classList.add('loading');
  for (const sc of state.story.scenes) {
    if (sc.status === 'succeeded') continue;
    await generateScene(sc);
    if (sc.status !== 'succeeded') {
      toast(`Scene stopped: ${sc.error?.title || sc.status}`, sc.error?.message || '', 'err');
      break;
    }
  }
  btn.classList.remove('loading');
  renderStory();
}
async function downloadScene(sc) {
  try {
    const blob = sc.videoKey ? await imageStore.get(sc.videoKey) : await api.downloadBlob(sc.provider || 'runway', sc.taskId, `scene-${sc.id}`).catch(async () => (await fetch(sc.videoUrl)).blob());
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `scene-${state.story.scenes.indexOf(sc) + 1}.mp4`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  } catch {
    window.open(sc.videoUrl, '_blank', 'noopener');
  }
}

// ====================================================================== go
init().catch((e) => {
  console.error(e);
  toast('Studio failed to start', e.message, 'err');
});

// Expose a tiny debug surface for testing in the console.
window.__studio = { state, api };
