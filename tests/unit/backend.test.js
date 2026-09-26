import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../../server/core/router.js';
import { RunwayProvider } from '../../server/providers/RunwayProvider.js';
import { validateJob } from '../../server/core/validate.js';
import { buildPrompt, enhanceLocal } from '../../frontend/js/prompt-engine.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const post = (route, body, env = {}, headers = {}) =>
  handle(new Request(`http://t/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), env, route);

test('health reports provider configuration without leaking secrets', async () => {
  const r = await handle(new Request('http://t/api/health'), { RUNWAY_API_KEY: 'key_secret_123' }, 'health');
  const text = await r.text();
  assert.equal(r.status, 200);
  assert.ok(!text.includes('key_secret_123'));
  assert.equal(JSON.parse(text).providers.runway.configured, true);
});

test('missing key → NOT_CONFIGURED (503), not a fake success', async () => {
  const r = await post('generate', { provider: 'runway', model: 'gen4.5', image: PNG, prompt: 'x', duration: 5, ratio: '1280:720' });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, 'NOT_CONFIGURED');
});

test('validation: formats, durations, ratios, prompt length, magic bytes', () => {
  assert.throws(() => validateJob({ provider: 'runway', model: 'gen4.5', image: 'data:image/gif;base64,R0lGOD', prompt: 'x', duration: 5, ratio: '1280:720' }), /Unsupported image format/);
  assert.throws(() => validateJob({ provider: 'runway', model: 'gen4.5', image: PNG, prompt: 'x', duration: 15, ratio: '1280:720' }), /2–10 seconds/);
  assert.throws(() => validateJob({ provider: 'runway', model: 'gen4.5', image: PNG, prompt: 'x', duration: 5, ratio: '1920:1080' }), /does not support output ratio/);
  assert.throws(() => validateJob({ provider: 'runway', model: 'gen4.5', image: PNG, prompt: 'x'.repeat(1001), duration: 5, ratio: '1280:720' }), /accepts up to 1000/);
  assert.throws(() => validateJob({ provider: 'runway', model: 'gen4.5', image: 'data:image/jpeg;base64,' + btoa('not a jpeg at all'), prompt: 'x', duration: 5, ratio: '1280:720' }), /does not match/);
  assert.throws(() => validateJob({ provider: 'runway', model: 'veo3.1_fast', image: PNG, prompt: 'x', duration: 5, ratio: '1280:720' }), /4, 6, 8/);
  const ok = validateJob({ provider: 'runway', model: 'veo3.1_fast', image: PNG, prompt: 'x', negativePrompt: 'blur', duration: 8, ratio: '1920:1080', audio: true });
  assert.equal(ok.job.negativePrompt, 'blur');
  const gen = validateJob({ provider: 'runway', model: 'gen4.5', image: PNG, prompt: 'x', negativePrompt: 'blur', duration: 7, ratio: '1280:720' });
  assert.equal(gen.job.negativePrompt, '', 'gen4.5 has no negative prompt input');
});

test('access code is enforced', async () => {
  const env = { RUNWAY_API_KEY: 'k', STUDIO_ACCESS_CODE: 'open-sesame' };
  const r = await post('generate', { provider: 'runway', model: 'gen4.5', image: PNG, prompt: 'x', duration: 5, ratio: '1280:720' }, env);
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, 'FORBIDDEN');
});

test('CORS: disallowed origin is rejected, allowed origin echoed', async () => {
  const env = { ALLOWED_ORIGINS: 'https://me.github.io', NODE_ENV: 'production' };
  const bad = await handle(new Request('http://t/api/health', { headers: { origin: 'https://evil.example' } }), env, 'health');
  assert.equal(bad.status, 403);
  const good = await handle(new Request('http://t/api/health', { headers: { origin: 'https://me.github.io' } }), env, 'health');
  assert.equal(good.headers.get('access-control-allow-origin'), 'https://me.github.io');
});

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = routes.shift();
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status, headers: r.headers || {} });
  };
  fn.calls = calls;
  return fn;
}

test('RunwayProvider sends the documented request and normalises status', async () => {
  const f = fakeFetch([
    { status: 200, body: { id: 'task_abc123', estimatedCost: { credits: 60 } } },
    { status: 200, body: { id: 'task_abc123', status: 'RUNNING', progress: 0.42, createdAt: 'x', estimatedCost: { credits: 60 } } },
    { status: 200, body: { id: 'task_abc123', status: 'SUCCEEDED', output: ['https://cdn/x.mp4'], cost: { credits: 60 } } },
  ]);
  const p = new RunwayProvider({ apiKey: 'k', fetchImpl: f });
  const g = await p.generate({ model: 'gen4.5', image: PNG, prompt: 'push in', duration: 5, ratio: '1280:720', seed: 7 }, { seed: true });
  assert.equal(g.taskId, 'task_abc123');
  assert.equal(g.estimatedCredits, 60);
  const req = f.calls[0];
  assert.equal(req.url, 'https://api.dev.runwayml.com/v1/image_to_video');
  assert.equal(req.init.headers.Authorization, 'Bearer k');
  assert.equal(req.init.headers['X-Runway-Version'], '2024-11-06');
  assert.deepEqual(JSON.parse(req.init.body), { model: 'gen4.5', promptImage: PNG, ratio: '1280:720', duration: 5, promptText: 'push in', seed: 7 });
  const s = await p.getStatus('task_abc123');
  assert.equal(s.state, 'running');
  assert.equal(s.progress, 0.42);
  const res = await p.getResult('task_abc123');
  assert.equal(res.videoUrl, 'https://cdn/x.mp4');
});

test('RunwayProvider maps provider errors honestly', async () => {
  const cases = [
    [{ status: 401, body: { error: 'The provided API key is not valid.' } }, 'AUTH_FAILED'],
    [{ status: 400, body: { error: 'You do not have enough credits to run this task.' } }, 'INSUFFICIENT_CREDITS'],
    [{ status: 400, body: { error: 'Invalid ratio' } }, 'INVALID_REQUEST'],
    [{ status: 504, body: {} }, 'TIMEOUT'],
  ];
  for (const [resp, code] of cases) {
    const p = new RunwayProvider({ apiKey: 'k', fetchImpl: fakeFetch([resp]) });
    await assert.rejects(p.getStatus('task_abcdef'), (e) => e.code === code);
  }
  const p = new RunwayProvider({ apiKey: 'k', fetchImpl: fakeFetch([{ status: 503 }, { status: 503 }, { status: 503 }]) });
  await assert.rejects(p.getStatus('task_abcdef'), (e) => e.code === 'PROVIDER_UNAVAILABLE');
});

test('prompt engine: motion-only prompt, incompatible motion dropped, limit respected', () => {
  const caps = { promptMaxChars: 1000, negativePrompt: false };
  const out = buildPrompt({ camera: 'push_in', subject: ['blink'], environment: ['clouds'], style: 'cinematic', intensity: 'subtle', protections: ['face', 'flicker'], duration: 8, caps, analysis: { category: 'landscape', people: 0, hasSky: true } });
  assert.match(out.prompt, /push-in/);
  assert.match(out.prompt, /clouds drift/i);
  assert.doesNotMatch(out.prompt, /blinks/);
  assert.doesNotMatch(out.prompt, /Facial features/);
  assert.match(out.prompt, /8 seconds/);
  assert.equal(out.dropped.length, 1);
  const e = enhanceLocal('Make this photo cinematic.', { camera: 'static', subject: [], environment: [], style: 'luxury', intensity: 'dynamic', protections: [], duration: 5, caps, analysis: null });
  assert.equal(e.applied.style, 'cinematic');
  assert.doesNotMatch(e.prompt, /Make this photo/);
  assert.ok(e.prompt.length <= 1000);
});

test('free Hugging Face model is the default and validates its own limits', async () => {
  const d = validateJob({ image: PNG, prompt: 'x', duration: 5, ratio: '832:480' });
  assert.equal(d.providerId, 'huggingface');
  assert.equal(d.job.model, 'wan2.2-fast');
  assert.throws(() => validateJob({ image: PNG, prompt: 'x', duration: 8, ratio: '832:480' }), /1–5 seconds/);
  assert.throws(() => validateJob({ image: PNG, prompt: 'x', duration: 5, ratio: '1280:720' }), /does not support output ratio/);
  const r = await post('generate', { image: PNG, prompt: 'x', duration: 5, ratio: '832:480' });
  assert.equal(r.status, 200, 'streams');
  const text = await r.text();
  assert.match(text, /NOT_CONFIGURED/);
  assert.match(text, /HF_TOKEN/);
});

test('HF download proxy refuses non-Space URLs (no SSRF)', async () => {
  const r = await handle(new Request('http://t/api/download?provider=huggingface&url=' + encodeURIComponent('https://169.254.169.254/file=/x')), { HF_TOKEN: 'hf_x' }, 'download');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error.code, 'FORBIDDEN');
});
