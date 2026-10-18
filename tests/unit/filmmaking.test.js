import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateJob } from '../../server/core/validate.js';
import { buildVideoParams } from '../../server/providers/HuggingFaceProvider.js';
import { acquireJobSlot, _resetRateLimits } from '../../server/core/ratelimit.js';
import { assistantConfigured } from '../../server/core/assistant.js';
import { planShots, shotPrompt } from '../../frontend/js/shot-planner.js';
import { buildAssemblyGraph } from '../../frontend/js/assembler-graph.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const req = (headers = {}) => new Request('http://t/api/generate', { method: 'POST', headers });

test('text-to-video only on models that support it', () => {
  assert.throws(() => validateJob({ model: 'wan2.2-fast', mode: 't2v', prompt: 'a beach', duration: 5, ratio: '832:480' }), /does not do text-to-video/);
  const ok = validateJob({ model: 'ltx-2.3', mode: 't2v', prompt: 'a beach at sunset', duration: 10, ratio: '768:512' });
  assert.equal(ok.job.mode, 't2v');
  assert.equal(ok.job.image, undefined);
  assert.throws(() => validateJob({ model: 'ltx-2.3', mode: 't2v', prompt: '', duration: 5, ratio: '768:512' }), /requires a prompt/);
  assert.throws(() => validateJob({ model: 'ltx-2.3', mode: 't2v', prompt: 'x', duration: 11, ratio: '768:512' }), /1–10 seconds/);
});

test('end frame, fps and quality are capability-checked', () => {
  assert.throws(() => validateJob({ model: 'wan2.2-fast', image: PNG, lastImage: PNG, prompt: 'x', duration: 5, ratio: '832:480' }), /does not support an end frame/);
  const ok = validateJob({ model: 'wan2.2-long', image: PNG, lastImage: PNG, prompt: 'x', duration: 10, ratio: '832:480', fps: 32, quality: 'max' });
  assert.equal(ok.job.lastImage, PNG);
  assert.equal(ok.job.frameMultiplier, 32);
  assert.equal(ok.job.steps, 8);
  assert.throws(() => validateJob({ model: 'wan2.2-fast', image: PNG, prompt: 'x', duration: 5, ratio: '832:480', fps: 32 }), /does not output 32 fps/);
  assert.throws(() => validateJob({ model: 'wan2.2-long', image: PNG, prompt: 'x', duration: 5, ratio: '832:480', quality: 'ultra' }), /no "ultra" quality/);
  assert.equal(validateJob({ model: 'wan2.2-long', image: PNG, prompt: 'x', duration: 5, ratio: '832:480' }).job.steps, 6, 'Space default');
});

test('Space parameters use each Space’s own names', async () => {
  const long = validateJob({ model: 'wan2.2-long', image: PNG, lastImage: PNG, prompt: 'walk', negativePrompt: 'blur', duration: 10, ratio: '832:480', fps: 32, seed: 7 });
  const p = buildVideoParams(long.job, long.caps);
  assert.ok(p.input_image instanceof Blob && p.last_image instanceof Blob);
  assert.equal(p.duration_seconds, 10);
  assert.equal(p.frame_multiplier, 32);
  assert.equal(p.seed, 7);
  assert.equal(p.randomize_seed, false);
  assert.match(p.negative_prompt, /blur$/);
  assert.equal(p.flow_shift, 3.0);

  const ltx = validateJob({ model: 'ltx-2.3', mode: 't2v', prompt: 'city at night', duration: 8, ratio: '1536:1024', enhance: true });
  const q = buildVideoParams(ltx.job, ltx.caps);
  assert.equal(q.input_image, null);
  assert.equal(q.duration, 8);
  assert.equal(q.width, 1536);
  assert.equal(q.height, 1024);
  assert.equal(q.enhance_prompt, true);
  assert.equal(q.negative_prompt, undefined, 'LTX Space has no negative prompt input');
  assert.equal(q.steps, undefined);

  const fast = validateJob({ model: 'wan2.2-fast', image: PNG, prompt: 'x', duration: 5, ratio: '832:480' });
  const f = buildVideoParams(fast.job, fast.caps);
  assert.equal(f.steps, 4);
  assert.equal(f.last_image, undefined);
});

test('duplicate request ids and runaway loops are rejected', () => {
  _resetRateLimits();
  const r1 = acquireJobSlot(req({ 'x-request-id': 'abcdefgh1234' }));
  assert.throws(() => acquireJobSlot(req({ 'x-request-id': 'abcdefgh1234' })), /already received/);
  r1();
  const env = { MAX_CONCURRENT_JOBS: '1' };
  const a = acquireJobSlot(req(), env);
  assert.throws(() => acquireJobSlot(req(), env), /at the same time/);
  a();
  a(); // double release is harmless
  _resetRateLimits();
  const env2 = { RATE_LIMIT_PER_HOUR: '2' };
  acquireJobSlot(req(), env2)();
  acquireJobSlot(req(), env2)();
  assert.throws(() => acquireJobSlot(req(), env2), /per hour/);
  _resetRateLimits();
});

test('paid HF assistant is never on implicitly', () => {
  assert.equal(assistantConfigured({ HF_TOKEN: 'hf_x' }), '');
  assert.equal(assistantConfigured({ HF_TOKEN: 'hf_x', HF_ASSISTANT: 'on' }), 'huggingface');
});

test('shot planner fills the target length with model-native clips and keeps continuity text', () => {
  const plan = planShots({ idea: 'A couple walking on a beach at sunset', preset: 'travel', targetSeconds: 30, maxClip: 10, presets: [5, 8, 10], source: 'photo' });
  const total = plan.shots.reduce((a, s) => a + s.duration, 0);
  assert.equal(total, 30);
  assert.ok(plan.shots.every((s) => s.duration <= 10));
  assert.equal(plan.shots[0].continuity, 'photo');
  assert.ok(plan.shots.slice(1).every((s) => s.continuity === 'continue'));
  const p = shotPrompt(plan.shots[1], plan.bible);
  assert.match(p, /same/i);
  const fast = planShots({ idea: 'x', preset: 'portrait', targetSeconds: 15, maxClip: 5, presets: [3, 5] });
  assert.equal(fast.shots.length, 3);
});

test('assembly graph: crossfade offsets, duplicate-frame trim, audio mix', () => {
  const g = buildAssemblyGraph({
    clips: [
      { duration: 5, hasAudio: false, trimStart: 0 },
      { duration: 5, hasAudio: true, trimStart: 1 / 16 },
      { duration: 5, hasAudio: false, trimStart: 1 / 16 },
    ],
    transition: 'crossfade',
    transitionSeconds: 0.5,
    width: 832,
    height: 480,
    fps: 16,
    keepOriginalAudio: true,
    music: { volume: 0.6, fadeIn: 1, fadeOut: 2 },
  });
  assert.match(g.filter, /xfade=transition=fade:duration=0.5:offset=4\.5\[.*offset=8\.9375/);
  assert.match(g.filter, /trim=start=0\.0625/);
  assert.match(g.filter, /amix=inputs=2/);
  assert.equal(Math.round(g.totalSeconds * 1000) / 1000, 13.875);
  const cut = buildAssemblyGraph({ clips: [{ duration: 3 }, { duration: 3 }], transition: 'cut', width: 640, height: 640, fps: 24 });
  assert.match(cut.filter, /concat=n=2:v=1:a=0/);
  assert.equal(cut.hasAudio, false);
});
