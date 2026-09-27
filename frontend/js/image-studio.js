// Image Studio — edit a photo from an instruction (identity-preserving) or create from text.
// Runs on free Hugging Face ZeroGPU Spaces through your backend (/api/image).
import { StudioApi, ERROR_TITLES } from './api-client.js';
import { settingsStore, imageStore, uid } from './storage.js';
import { loadImageFile, makeJpegDataUri, fmtBytes, ImageError } from './image-tools.js';
import { parseQuotaError, explainQuota, quotaLine, lastQuota } from './quota.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const api = new StudioApi(() => settingsStore.load({ apiBase: window.STUDIO_CONFIG?.apiBase || '', accessCode: '' }));
const LS_KEY = 'cas.images.v1';

// ------------------------------------------------------------------ vocabulary
const EDIT_PRESETS = [
  { id: 'bg', label: 'Change background', blurb: 'Same person, new place', text: 'Change the background to [a sunlit beach at golden hour]. Match the lighting on the person to the new background.', unlock: ['background', 'lighting'] },
  { id: 'outfit', label: 'Change outfit', blurb: 'Swap clothing only', text: 'Change the outfit to [an elegant navy blue suit with a white shirt]. Keep the fit natural for the same body and pose.', unlock: ['clothing'] },
  { id: 'headshot', label: 'Professional headshot', blurb: 'Studio, clean backdrop', text: 'Turn this into a professional studio headshot with a soft grey backdrop, flattering soft-box lighting and sharp focus on the eyes.', unlock: ['background', 'lighting'] },
  { id: 'relight', label: 'Golden-hour relight', blurb: 'Warm cinematic light', text: 'Relight the scene with warm golden-hour sunlight from the left, soft natural shadows and a gentle rim light.', unlock: ['lighting'] },
  { id: 'night', label: 'Day → night', blurb: 'Evening city glow', text: 'Change the time of day to night with warm street lights and a deep blue sky, keeping the scene layout identical.', unlock: ['lighting', 'background'] },
  { id: 'remove', label: 'Remove an object', blurb: 'Clean it up', text: 'Remove [the person in the background on the left] and fill the area naturally with the surrounding scene.', unlock: [] },
  { id: 'restore', label: 'Restore old photo', blurb: 'Fix, sharpen, colorize', text: 'Restore this photo: remove scratches, dust and noise, sharpen details and add natural, realistic colour.', unlock: ['lighting'] },
  { id: 'wedding', label: 'Wedding portrait', blurb: 'Romantic, elegant', text: 'Make this an elegant wedding portrait with a softly blurred floral venue background and warm romantic lighting.', unlock: ['background', 'lighting'] },
  { id: 'season', label: 'Change season', blurb: 'Snow, spring, autumn', text: 'Change the season to [a snowy winter day with light snowfall], keeping everything else in place.', unlock: ['background', 'lighting'] },
  { id: 'cinematic', label: 'Cinematic film still', blurb: 'Movie colour grade', text: 'Give this a cinematic film look: teal-and-orange colour grade, subtle film grain and gentle vignette.', unlock: ['lighting'] },
  { id: 'realestate', label: 'Property photo polish', blurb: 'Bright, straight, clean', text: 'Enhance this property photo: brighten and balance exposure, make vertical lines straight, replace the sky with a clear blue sky, and tidy clutter.', unlock: ['background', 'lighting'] },
  { id: 'style', label: 'Illustration style', blurb: 'Same person, art style', text: 'Redraw this image as a [watercolour illustration] while keeping the same person recognisable.', unlock: ['lighting'] },
];
const CREATE_PRESETS = [
  { id: 'c-portrait', label: 'Portrait', blurb: 'Natural, 85 mm', text: 'A natural portrait of [a smiling young woman in a cream sweater], soft window light, 85mm lens, shallow depth of field.' },
  { id: 'c-product', label: 'Product shot', blurb: 'Studio, premium', text: 'A premium studio product photo of [a matte black perfume bottle] on a stone pedestal, soft gradient backdrop, crisp reflections.' },
  { id: 'c-arch', label: 'Architecture', blurb: 'Luxury exterior', text: 'A photorealistic exterior of [a modern luxury villa with warm wood and glass] at dusk, interior lights glowing, landscaped garden.' },
  { id: 'c-interior', label: 'Interior', blurb: 'Magazine style', text: 'A bright, magazine-style interior of [a minimalist living room with oak floors and linen sofa], large windows, natural light.' },
  { id: 'c-travel', label: 'Travel scene', blurb: 'Epic landscape', text: 'A breathtaking travel photo of [misty tea hills in Munnar at sunrise], layered mountains, golden light, cinematic.' },
  { id: 'c-food', label: 'Food', blurb: 'Close-up, appetising', text: 'A close-up food photo of [a steaming South Indian thali on a banana leaf], soft side light, shallow depth of field.' },
];
const LOCKS = [
  { id: 'face', label: 'Face & identity', text: "the person's face, facial features and identity", on: true },
  { id: 'skin', label: 'Skin tone', text: 'skin tone and complexion', on: true },
  { id: 'hair', label: 'Hairstyle', text: 'hairstyle and hair colour', on: true },
  { id: 'expression', label: 'Expression', text: 'facial expression', on: true },
  { id: 'pose', label: 'Pose & body', text: 'pose, body shape and proportions', on: true },
  { id: 'clothing', label: 'Clothing', text: 'clothing and accessories', on: false },
  { id: 'background', label: 'Background', text: 'background and surroundings', on: false },
  { id: 'camera', label: 'Framing & angle', text: 'camera angle, framing and composition', on: true },
  { id: 'lighting', label: 'Lighting', text: 'lighting and colours', on: false },
];
const STYLES = [
  { id: 'photo', label: 'Photorealistic', text: 'photorealistic, natural colours, high detail' },
  { id: 'cinema', label: 'Cinematic', text: 'cinematic still, dramatic lighting, anamorphic look, film grain' },
  { id: 'studio', label: 'Studio', text: 'professional studio photography, soft-box lighting, clean backdrop' },
  { id: 'luxury', label: 'Luxury', text: 'luxury editorial photography, elegant, refined lighting' },
  { id: 'render', label: '3D render', text: 'high-end 3D architectural render, physically based lighting' },
  { id: 'illus', label: 'Illustration', text: 'detailed digital illustration, clean lines' },
  { id: 'water', label: 'Watercolour', text: 'soft watercolour painting' },
  { id: 'anime', label: 'Anime', text: 'anime style, vibrant colours, clean cel shading' },
];

// ------------------------------------------------------------------ state
const st = {
  mode: 'edit',
  refs: [], // { id, name, bitmap, url, dataUri, width, height, size }
  locks: new Set(LOCKS.filter((l) => l.on).map((l) => l.id)),
  style: 'photo',
  model: 'qwen-edit-fast',
  aspect: '1:1',
  catalog: null,
  health: null,
  job: null,
  current: null, // result record
  history: [],
  promptSource: 'user',
};

function toast(title, msg = '', kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div><b>${esc(title)}</b>${msg ? `<p>${esc(msg)}</p>` : ''}</div>`;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 9000 : 4500);
}
const errInfo = (e) => {
  const code = e?.code || 'INTERNAL';
  let message = e?.message || String(e);
  if (code === 'QUOTA_EXCEEDED') message = `${message}\n\n${explainQuota(parseQuotaError(message))}`.trim();
  return { code, title: ERROR_TITLES[code] || ERROR_TITLES.INTERNAL, message };
};
const models = () => st.catalog?.imageProviders?.huggingface?.models || {};
const caps = () => models()[st.model];

// ------------------------------------------------------------------ boot
async function init() {
  try {
    st.catalog = await api.models();
  } catch {
    st.catalog = await fetch('models.json').then((r) => r.json()).catch(() => null);
  }
  api.health().then((h) => {
    st.health = h;
    renderModels();
  }).catch(() => {});
  loadHistory();
  bind();
  renderAll();
}

function renderAll() {
  $('#istage').dataset.mode = st.mode;
  $$('[data-imode]').forEach((b) => b.classList.toggle('on', b.dataset.imode === st.mode));
  const presets = st.mode === 'edit' ? EDIT_PRESETS : CREATE_PRESETS;
  $('#iPresetTitle').textContent = st.mode === 'edit' ? 'Quick edits' : 'Starting ideas';
  $('#iPresets').innerHTML = presets.map((p) => `<button class="style-card" data-ipreset="${p.id}"><b>${p.label}</b><span>${p.blurb}</span></button>`).join('');
  $('#iPromptTitle').textContent = st.mode === 'edit' ? 'What should change?' : 'Describe the image';
  $('#iPrompt').placeholder = st.mode === 'edit' ? 'e.g. Change the background to a sunlit beach at golden hour.' : 'e.g. A modern luxury villa at dusk with warm interior lights, photorealistic.';
  $('#iLockPanel').hidden = st.mode !== 'edit';
  $('#iStylePanel').hidden = st.mode !== 'create';
  $('#iLocks').innerHTML = LOCKS.map((l) => `<button class="chip ${st.locks.has(l.id) ? 'on' : ''}" data-ilock="${l.id}">${l.label}</button>`).join('');
  $('#iLockNote').textContent = 'Locked items are added to your prompt as explicit “keep exactly the same” instructions. Unlock anything you want the edit to change.';
  $('#iStyles').innerHTML = STYLES.map((x) => `<button class="chip ${st.style === x.id ? 'on' : ''}" data-istyle="${x.id}">${x.label}</button>`).join('');
  if (!caps()?.modes.includes(st.mode)) st.model = Object.entries(models()).find(([, m]) => m.modes.includes(st.mode))?.[0] || st.model;
  renderModels();
  renderRefs();
  renderStage();
  updateCount();
  updateGenerateBtn();
}

function renderModels() {
  const list = Object.entries(models()).filter(([, m]) => m.modes.includes(st.mode));
  const configured = st.health?.providers?.huggingface?.configured;
  $('#iModels').innerHTML =
    `<div class="model-group"><span>Hugging Face (free)</span><span class="badge live">Free</span>${configured === false ? '<span class="badge warn">HF_TOKEN not set</span>' : ''}</div>` +
    list
      .map(
        ([id, m]) => `<button class="model ${id === st.model ? 'on' : ''}" data-imodel="${id}"><div class="top"><b>${esc(m.label)}</b><span class="q">${esc(m.quality)}</span></div>
      <div class="specs"><span>${m.modes.map((x) => (x === 'edit' ? 'edit' : 'text→image')).join(' · ')}</span>${m.maxImages ? `<span>≤${m.maxImages} photo${m.maxImages > 1 ? 's' : ''}</span>` : ''}<span>GPU: ${m.gpu}</span><span>free</span></div></button>`
      )
      .join('');
  const c = caps();
  $('#iAspectWrap').hidden = !(st.mode === 'create' && c?.sizes);
  if (c?.sizes) {
    if (!c.sizes.some((z) => z.aspect === st.aspect)) st.aspect = c.sizes[0].aspect;
    $('#iAspects').innerHTML = c.sizes.map((z) => `<button data-iaspect="${z.aspect}" class="${z.aspect === st.aspect ? 'on' : ''}">${z.aspect}<small>${z.width}×${z.height}</small></button>`).join('');
  }
  $('#iModelNote').textContent = c
    ? `${c.description}${st.mode === 'create' && !c.sizes ? ' Output is about 1024 px; aspect ratio is chosen by the model.' : ''}${st.mode === 'edit' ? ' Output keeps roughly the input’s aspect ratio.' : ''}`
    : '';
  const q = lastQuota();
  const short = c?.reserveSeconds && q?.left != null && q.left < c.reserveSeconds;
  $('#iCost').innerHTML = c
    ? `<span><b>Free</b> · needs ${c.reserveSeconds || 60}s of free GPU to start; you're charged only the time actually used${c.gpu === 'heavy' ? ' (this model uses more)' : ''}</span>` +
      (q ? `<span class="${short ? 'warn' : 'muted'}">${esc(quotaLine())}${short ? ' — not enough to start an image until it resets' : ''}</span>` : '')
    : '';
}

function renderRefs() {
  const c = caps();
  const box = $('#irefs');
  box.hidden = st.mode !== 'edit' || !st.refs.length;
  const max = c?.maxImages || 1;
  box.innerHTML =
    st.refs
      .map((r, i) => `<div class="iref"><img src="${r.url}" alt=""><span class="tag ${i ? 'ref' : ''}">${i ? `Ref ${i}` : 'Main'}</span><button data-irm="${r.id}" title="Remove">×</button></div>`)
      .join('') + (st.refs.length < max ? `<label class="iref add" for="iFileInput">+ ${st.refs.length ? 'Reference' : 'Photo'}</label>` : '');
  if (st.refs.length > max) toast(`${c.label} uses ${max} photo${max > 1 ? 's' : ''}`, 'Extra photos are ignored for this model.');
}

function renderStage() {
  const stage = $('#istage');
  const cmp = $('#icompare');
  if (st.job) return; // generating overlay stays
  const main = st.refs[0];
  if (st.current) {
    stage.dataset.state = 'result';
    $('#iAfter').src = st.current.url;
    const before = st.current.beforeUrl;
    cmp.classList.add('has-result');
    cmp.classList.toggle('no-before', !before);
    if (before) $('#iBefore').src = before;
    setSplit(50);
  } else if (st.mode === 'edit' && main) {
    stage.dataset.state = 'preview';
    cmp.classList.remove('has-result', 'no-before');
    $('#iAfter').src = main.url;
    $('#iBefore').removeAttribute('src');
    cmp.classList.add('no-before');
  } else {
    stage.dataset.state = 'empty';
  }
  $('#iResultPanel').hidden = !st.current;
  if (st.current) renderResultPanel();
}

function setSplit(pct) {
  pct = Math.max(0, Math.min(100, pct));
  $('#iHandle').style.left = `${pct}%`;
  $('#iBefore').style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
}

function updateCount() {
  const n = $('#iPrompt').value.length;
  $('#iCount').textContent = `${n} / 1000`;
  $('#iCount').classList.toggle('over', n > 1000);
}
function updateGenerateBtn() {
  const ok = $('#iPrompt').value.trim().length > 0 && (st.mode === 'create' || st.refs.length > 0) && !st.job;
  $('#iGenerate').disabled = !ok;
}

// ------------------------------------------------------------------ prompt building
function lockSentence() {
  if (st.mode !== 'edit' || !st.locks.size) return '';
  const items = LOCKS.filter((l) => st.locks.has(l.id)).map((l) => l.text);
  const list = items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0];
  return `Keep ${list} exactly the same as in the original photo. Do not add, remove or replace any people. Photorealistic result with consistent lighting.`;
}
function finalPrompt() {
  const base = $('#iPrompt').value.trim().replace(/\[|\]/g, '');
  if (st.mode === 'create') {
    const style = STYLES.find((x) => x.id === st.style);
    return [base.replace(/[.\s]+$/, ''), style?.text].filter(Boolean).join(', ') + '.';
  }
  const lock = lockSentence();
  return [base.replace(/\s+$/, ''), /keep .* exactly the same/i.test(base) ? '' : lock].filter(Boolean).join(' ').slice(0, 1000);
}

async function enhance() {
  const text = $('#iPrompt').value.trim();
  if (!text) return toast('Write what you want first', 'Enhance improves your own words.');
  const btn = $('#iEnhance');
  btn.classList.add('loading');
  try {
    let out = null;
    if (st.health?.assistant) {
      try {
        const r = await api.enhance({
          text,
          kind: st.mode === 'edit' ? 'image-edit' : 'image-create',
          context: { keepSame: LOCKS.filter((l) => st.locks.has(l.id)).map((l) => l.label), style: STYLES.find((x) => x.id === st.style)?.label, references: st.refs.length },
        });
        out = r.prompt;
        st.promptSource = 'ai';
      } catch (e) {
        toast('AI assistant unavailable — used the built-in rewrite', errInfo(e).message);
      }
    }
    if (!out) {
      out = localEnhance(text);
      st.promptSource = 'local';
    }
    $('#iPrompt').value = out.slice(0, 1000);
    $('#iPromptBadge').textContent = st.promptSource === 'ai' ? 'AI-enhanced' : 'Enhanced';
    $('#iPromptBadge').className = `badge ${st.promptSource === 'ai' ? 'ai' : ''}`;
    updateCount();
    updateGenerateBtn();
  } finally {
    btn.classList.remove('loading');
  }
}
function localEnhance(text) {
  let t = text.trim().replace(/[.\s]+$/, '');
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (st.mode === 'create') return `${t}. Sharp focus, well-composed, natural lighting, rich detail.`;
  if (!/^(change|replace|remove|add|make|turn|give|relight|restore|put|convert|redraw|enhance)/i.test(t)) t = `Edit the photo: ${t}`;
  return `${t}. Apply only this change; everything not mentioned stays as it is.`;
}

// ------------------------------------------------------------------ files
async function addFiles(files) {
  const c = caps();
  const max = c?.maxImages || 1;
  for (const file of files) {
    if (st.refs.length >= max) {
      toast(`${c?.label || 'This model'} accepts ${max} photo${max > 1 ? 's' : ''}`, max > 1 ? 'Remove one to add another.' : 'Pick Qwen Image Edit to use up to 3 reference photos.');
      break;
    }
    try {
      const { bitmap, width, height } = await loadImageFile(file);
      let dataUri = await makeJpegDataUri(bitmap, 1536, 0.9);
      if (dataUri.length > 1_300_000) dataUri = await makeJpegDataUri(bitmap, 1280, 0.85);
      st.refs.push({ id: uid('ref'), name: file.name, bitmap, width, height, size: file.size, dataUri, url: URL.createObjectURL(file) });
    } catch (e) {
      toast(e instanceof ImageError ? ERROR_TITLES[e.code] || 'Invalid image' : 'Invalid image', e.message, 'err');
    }
  }
  st.current = null;
  renderAll();
}

// ------------------------------------------------------------------ generation
const STEPS = [
  ['prepare', 'Preparing'],
  ['send', 'Sending to the Space'],
  ['queue', 'Waiting for a free GPU'],
  ['render', 'Generating'],
  ['final', 'Receiving the image'],
];
function stepSet(id, status, note) {
  const ol = $('#iGenSteps');
  const idx = STEPS.findIndex(([s]) => s === id);
  STEPS.slice(0, idx).forEach(([s]) => {
    const li = ol.querySelector(`[data-step="${s}"]`);
    if (!li.classList.contains('failed')) {
      li.className = 'done';
      li.querySelector('.s').textContent = 'Done';
    }
  });
  const li = ol.querySelector(`[data-step="${id}"]`);
  li.className = status;
  li.querySelector('.s').textContent = { active: 'Now', done: 'Done', failed: 'Failed' }[status];
  if (note) li.querySelector('small').textContent = note;
}

async function generate({ variation = false } = {}) {
  const c = caps();
  if (!c) return toast('Model configuration unavailable', 'The backend could not be reached.', 'err');
  const prompt = finalPrompt();
  const payload = {
    provider: 'huggingface',
    model: st.model,
    mode: st.mode,
    prompt,
    images: st.mode === 'edit' ? st.refs.slice(0, c.maxImages).map((r) => r.dataUri) : [],
    aspect: st.aspect,
    seed: variation ? '' : $('#iSeed').value.replace(/\D/g, ''),
  };
  const abort = new AbortController();
  st.job = { abort, started: Date.now() };
  const stage = $('#istage');
  stage.dataset.state = 'generating';
  $('#iGenEyebrow').textContent = `${st.mode === 'edit' ? 'Editing' : 'Creating'} with ${c.label}`;
  $('#iGenSteps').innerHTML = STEPS.map(([id, label], i) => `<li data-step="${id}"><span class="n">0${i + 1}</span><span class="t">${label}<small>—</small></span><span class="s">—</span></li>`).join('');
  $('#iGenError').hidden = true;
  $('#iGenActions').hidden = false;
  $('#iProgWrap').hidden = true;
  const tick = setInterval(() => {
    const s = Math.floor((Date.now() - st.job.started) / 1000);
    $('#iElapsed').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
  updateGenerateBtn();
  try {
    stepSet('prepare', 'done', payload.images.length ? `${payload.images.length} photo(s) · ${fmtBytes(payload.images.reduce((a, b) => a + b.length, 0))} encoded` : 'Text prompt only');
    stepSet('send', 'active', 'POST /api/image');
    const r = await api.image(payload, {
      signal: abort.signal,
      onEvent: (ev) => {
        if (ev.type === 'accepted') stepSet('send', 'done', `Accepted by ${ev.space}`);
        else if (ev.type === 'queued') stepSet('queue', 'active', `Position ${ev.position + 1}${ev.size ? ` of ${ev.size}` : ''}${ev.eta ? ` · ETA ~${Math.round(ev.eta)}s` : ''}`);
        else if (ev.type === 'started') stepSet('render', 'active', 'GPU allocated — model running');
        else if (ev.type === 'progress') {
          stepSet('render', 'active', `${ev.desc} step ${Math.min(ev.step + 1, ev.steps)} of ${ev.steps}`);
          $('#iProgWrap').hidden = false;
          $('#iBar').style.width = `${Math.round(ev.progress * 100)}%`;
          $('#iPct').textContent = `${Math.round(ev.progress * 100)}%`;
        } else if (ev.type === 'saving') stepSet('final', 'active', 'Receiving the image from the Space');
      },
    });
    let blob = r.blob;
    if (!blob) blob = await api.downloadBlob('huggingface', null, 'image', r.outputs[0]);
    const rec = {
      id: uid('im'),
      createdAt: new Date().toISOString(),
      mode: st.mode,
      model: st.model,
      modelLabel: c.label,
      prompt,
      userPrompt: $('#iPrompt').value.trim(),
      seed: r.seed,
      mime: blob.type,
      bytes: blob.size,
      hasBefore: st.mode === 'edit',
    };
    await imageStore.put(`gimg_${rec.id}`, blob);
    if (rec.hasBefore) await imageStore.put(`gimgsrc_${rec.id}`, await (await fetch(st.refs[0].dataUri)).blob());
    st.history.unshift(rec);
    saveHistory();
    clearInterval(tick);
    st.job = null;
    await showRecord(rec);
    toast('Image ready', `${c.label}${r.seed != null ? ` · seed ${r.seed}` : ''}`, 'ok');
  } catch (e) {
    clearInterval(tick);
    const aborted = abort.signal.aborted || e?.code === 'CANCELLED';
    st.job = null;
    if (aborted) {
      toast('Generation cancelled');
      renderStage();
    } else {
      const info = errInfo(e);
      stage.dataset.state = 'generating';
      const active = $('#iGenSteps li.active') || $('#iGenSteps li:not(.done)');
      if (active) stepSet(active.dataset.step, 'failed');
      $('#iGenError').hidden = false;
      $('#iGenActions').hidden = true;
      $('#iErrTitle').textContent = info.title;
      $('#iErrMsg').textContent = info.message;
      toast(info.title, info.message, 'err');
      renderModels();
    }
  }
  updateGenerateBtn();
}

const objectUrls = new Map();
async function urlFor(key) {
  if (objectUrls.has(key)) return objectUrls.get(key);
  const blob = await imageStore.get(key);
  if (!blob) return null;
  const u = URL.createObjectURL(blob);
  objectUrls.set(key, u);
  return u;
}

async function showRecord(rec) {
  const url = await urlFor(`gimg_${rec.id}`);
  if (!url) return toast('Image not found in this browser', 'Site data may have been cleared.', 'err');
  st.current = { ...rec, url, beforeUrl: rec.hasBefore ? await urlFor(`gimgsrc_${rec.id}`) : null };
  renderStage();
  renderHistory();
}

function renderResultPanel() {
  const r = st.current;
  $('#iResultTitle').textContent = r.mode === 'edit' ? 'Edited photo' : 'Created image';
  const img = $('#iAfter');
  const dims = img.naturalWidth ? `${img.naturalWidth}×${img.naturalHeight}` : '—';
  const rows = [
    ['Model', r.modelLabel],
    ['Size', dims],
    ['Seed', r.seed ?? '—'],
    ['Created', new Date(r.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })],
  ];
  $('#iMeta').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('');
  $('#iPromptUsed').textContent = r.prompt;
  if (!img.naturalWidth) img.onload = () => renderResultPanel();
}

function renderHistory() {
  $('#iHistory').hidden = !st.history.length;
  $('#iGrid').innerHTML = st.history.map((h) => `<button data-ihist="${h.id}" class="${st.current?.id === h.id ? 'active' : ''}" title="${esc(h.userPrompt)}"><img data-key="gimg_${h.id}" alt=""></button>`).join('');
  $$('#iGrid img').forEach(async (im) => {
    const u = await urlFor(im.dataset.key);
    if (u) im.src = u;
  });
}
function loadHistory() {
  try {
    st.history = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
  } catch {
    st.history = [];
  }
  renderHistory();
}
function saveHistory() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(st.history.slice(0, 200)));
  } catch {
    /* quota */
  }
}

async function currentBlob() {
  return st.current ? imageStore.get(`gimg_${st.current.id}`) : null;
}
async function downloadPng() {
  const blob = await currentBlob();
  if (!blob) return;
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  const png = await new Promise((res) => c.toBlob(res, 'image/png'));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(png);
  a.download = `cinematic-image-${st.current.id.slice(-6)}.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 20_000);
  toast('Download started', `${a.download} · ${fmtBytes(png.size)}`, 'ok');
}
async function useAsInput() {
  const blob = await currentBlob();
  if (!blob) return;
  const file = new File([blob], 'edited.png', { type: blob.type || 'image/webp' });
  st.refs = [];
  st.mode = 'edit';
  st.current = null;
  await addFiles([file]);
  $('#iPrompt').value = '';
  updateCount();
  toast('Loaded as the new photo', 'Describe the next change.');
}
async function animate() {
  const blob = await currentBlob();
  if (!blob) return;
  window.dispatchEvent(new CustomEvent('cas:send-to-video', { detail: { file: new File([blob], `image-${st.current.id.slice(-6)}.png`, { type: blob.type || 'image/webp' }) } }));
}

// ------------------------------------------------------------------ bindings
function bind() {
  $('#iFileInput').addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  });
  window.addEventListener('cas:image-files', (e) => addFiles(e.detail.files));
  $('#iPrompt').addEventListener('input', () => {
    st.promptSource = 'user';
    $('#iPromptBadge').textContent = 'Your words';
    $('#iPromptBadge').className = 'badge';
    updateCount();
    updateGenerateBtn();
  });
  $('#iEnhance').addEventListener('click', enhance);
  $('#iGenerate').addEventListener('click', () => generate());
  $('#iRetry').addEventListener('click', () => generate());
  $('#iBack').addEventListener('click', () => renderStage());
  $('#iCancel').addEventListener('click', () => st.job?.abort.abort());
  $('#iDownload').addEventListener('click', downloadPng);
  $('#iVariation').addEventListener('click', () => {
    if (st.current && st.current.mode === 'edit' && !st.refs.length) return toast('Original photo not loaded', 'Use “Keep editing this” or upload the photo again.');
    generate({ variation: true });
  });
  $('#iUseAsInput').addEventListener('click', useAsInput);
  $('#iAnimate').addEventListener('click', animate);
  document.querySelector('.view-image .inspector').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.imode) {
      st.mode = d.imode;
      st.current = null;
    } else if (d.ipreset) {
      const p = [...EDIT_PRESETS, ...CREATE_PRESETS].find((x) => x.id === d.ipreset);
      $('#iPrompt').value = p.text;
      st.promptSource = 'user';
      (p.unlock || []).forEach((id) => st.locks.delete(id));
      toast(p.label, 'Edit the words in [brackets] to what you want.');
    } else if (d.ilock) {
      st.locks.has(d.ilock) ? st.locks.delete(d.ilock) : st.locks.add(d.ilock);
    } else if (d.istyle) st.style = d.istyle;
    else if (d.imodel) st.model = d.imodel;
    else if (d.iaspect) st.aspect = d.iaspect;
    else return;
    renderAll();
  });
  $('#irefs').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-irm]');
    if (!rm) return;
    st.refs = st.refs.filter((r) => r.id !== rm.dataset.irm);
    st.current = null;
    renderAll();
  });
  $('#iGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ihist]');
    if (b) showRecord(st.history.find((h) => h.id === b.dataset.ihist));
  });
  // before/after drag
  const handle = $('#iHandle');
  let drag = false;
  handle.addEventListener('pointerdown', (e) => {
    drag = true;
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = $('#icompare').getBoundingClientRect();
    setSplit(((e.clientX - r.left) / r.width) * 100);
  });
  handle.addEventListener('pointerup', () => (drag = false));
  const dz = $('#idropzone');
  ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, () => dz.classList.add('over')));
  ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, () => dz.classList.remove('over')));
}

init().catch((e) => console.error('Image Studio failed to start', e));
window.__imageStudio = { st };
