import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../../server/core/router.js';

test('HF download retries when a Space replica answers 403, then streams the file', async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls < 4) return new Response('File not allowed', { status: 403 });
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'video/mp4' } });
  };
  try {
    const url = 'https://zerogpu-aoti-wan2-2-fp8da-aoti-faster.hf.space/gradio_api/file=/tmp/gradio/abc/out.mp4';
    const r = await handle(new Request(`http://t/api/download?provider=huggingface&url=${encodeURIComponent(url)}`), { HF_TOKEN: 'hf_x' }, 'download');
    assert.equal(r.status, 200);
    assert.equal((await r.arrayBuffer()).byteLength, 4);
    assert.equal(calls, 4);
  } finally {
    globalThis.fetch = real;
  }
});
