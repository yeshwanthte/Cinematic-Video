import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModalProvider } from '../../server/providers/ModalProvider.js';
import { validateJob } from '../../server/core/validate.js';
import { handle } from '../../server/core/router.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function withFetch(handler, fn) {
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return fn(seen).finally(() => (globalThis.fetch = orig));
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

test('Modal provider: not configured → honest NOT_CONFIGURED', async () => {
  const p = new ModalProvider({});
  assert.equal(p.isConfigured(), false);
  await assert.rejects(p.generate({ image: PNG }), (e) => e.code === 'NOT_CONFIGURED');
  const r = await handle(new Request('http://t/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'modal', model: 'wan2.2-modal', image: PNG, prompt: 'x', duration: 5, ratio: '832:480' }) }), {}, 'generate');
  assert.equal(r.status, 503);
});

test('Modal provider: request contract, 720p, end frame, steps, auth header', async () => {
  const { job, caps } = validateJob({ provider: 'modal', model: 'wan2.2-modal', image: PNG, lastImage: PNG, prompt: 'walk', negativePrompt: 'blur', duration: 5, ratio: '1280:720', quality: 'max', seed: 9 });
  const p = new ModalProvider({ endpoint: 'https://me--cinematic-studio-wan-api.modal.run/', secret: 's3cret' });
  await withFetch(
    () => json({ id: 'fc-abc123' }),
    async (seen) => {
      const r = await p.generate(job, caps);
      assert.equal(r.taskId, 'fc-abc123');
      const body = JSON.parse(seen[0].init.body);
      assert.equal(seen[0].url, 'https://me--cinematic-studio-wan-api.modal.run/jobs');
      assert.equal(seen[0].init.headers.Authorization, 'Bearer s3cret');
      assert.deepEqual([body.max_dim, body.steps, body.duration, body.seed, Boolean(body.last_image), body.negative_prompt], [1280, 8, 5, 9, true, 'blur']);
    }
  );
});

test('Modal provider: status mapping, credits message, private video download', async () => {
  const p = new ModalProvider({ endpoint: 'https://m.modal.run', secret: 's' });
  await withFetch(
    (url) => (url.endsWith('/jobs/fc-1') ? json({ status: 'running', step: 2, steps: 4, progress: 0.5 }) : json({ status: 'failed', error: 'Workspace billing cycle spend limit reached' })),
    async () => {
      const s = await p.getStatus('fc-1');
      assert.deepEqual([s.state, s.progress, s.step, s.steps], ['running', 0.5, 2, 4]);
      const f = await p.getStatus('fc-2');
      assert.equal(f.state, 'failed');
      assert.match(f.failure, /credits for this month/);
    }
  );
  await withFetch(
    () => json({ error: 'Missing or wrong Authorization bearer token.' }, 401),
    async () => assert.rejects(p.getStatus('fc-1'), (e) => e.code === 'AUTH_FAILED' && /STUDIO_MODAL_SECRET/.test(e.message))
  );
  // backend download route adds the secret only server-side and streams the mp4
  const env = { MODAL_ENDPOINT_URL: 'https://m.modal.run', MODAL_API_SECRET: 's' };
  await withFetch(
    (url, init) => {
      if (url.endsWith('/jobs/fc-999999')) return json({ status: 'succeeded', progress: 1 });
      if (url.endsWith('/jobs/fc-999999/video')) {
        assert.equal(init.headers.Authorization, 'Bearer s');
        return new Response(new Uint8Array([0, 0, 0, 24]), { headers: { 'content-type': 'video/mp4' } });
      }
      return json({}, 404);
    },
    async () => {
      const r = await handle(new Request('http://t/api/download?provider=modal&id=fc-999999&name=x'), env, 'download');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-disposition'), /x\.mp4/);
      const text = JSON.stringify(Object.fromEntries(r.headers));
      assert.ok(!text.includes('Bearer'), 'secret never reaches the browser');
    }
  );
});

test('Modal model capabilities are validated', () => {
  assert.throws(() => validateJob({ provider: 'modal', model: 'wan2.2-modal', image: PNG, prompt: 'x', duration: 8, ratio: '832:480' }), /1–5 seconds/);
  assert.throws(() => validateJob({ provider: 'modal', model: 'wan2.2-modal', mode: 't2v', prompt: 'x', duration: 5, ratio: '832:480' }), /text-to-video/);
  assert.equal(validateJob({ provider: 'modal', model: 'wan2.2-modal', image: PNG, prompt: 'x', duration: 3, ratio: '992:992' }).job.steps, 4);
});
