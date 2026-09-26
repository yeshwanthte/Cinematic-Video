// TEST ONLY — a local stand-in that implements Runway's documented HTTP contract
// (POST /v1/image_to_video, GET/DELETE /v1/tasks/:id, GET /v1/organization) so the
// full pipeline can be exercised without spending credits. The app never uses this
// unless you explicitly point RUNWAY_API_BASE at it.
//
// Behaviour switches (put the token in the prompt):
//   FAIL_SAFETY   → task FAILED with failureCode SAFETY.OUTPUT.VIDEO
//   FAIL_INTERNAL → task FAILED with failureCode INTERNAL.BAD_OUTPUT.01
//   RATE_LIMIT    → HTTP 429 on submit
//   NO_CREDITS    → HTTP 400 "You do not have enough credits to run this task."
//   SLOW          → stays RUNNING much longer (for cancel / timeout tests)
import http from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.PORT || 9911);
const KEY = process.env.EXPECT_KEY || 'key_test_local';
const VIDEO = readFileSync(new URL('./fixtures/sample-output.mp4', import.meta.url));
const tasks = new Map();
export const log = [];

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

function statusOf(t) {
  if (t.cancelled) return { id: t.id, status: 'CANCELLED', createdAt: t.createdAt, cost: { credits: 0 } };
  t.polls += 1;
  const p = t.polls;
  const base = { id: t.id, createdAt: t.createdAt, estimatedCost: { credits: t.credits } };
  const slow = t.body.promptText?.includes('SLOW');
  if (p <= 1) return { ...base, status: 'PENDING' };
  if (t.body.promptText?.includes('FAIL_SAFETY') && p >= 2) return { id: t.id, createdAt: t.createdAt, status: 'FAILED', failure: 'The output was flagged by content moderation.', failureCode: 'SAFETY.OUTPUT.VIDEO', cost: { credits: t.credits } };
  if (t.body.promptText?.includes('FAIL_INTERNAL') && p >= 3) return { id: t.id, createdAt: t.createdAt, status: 'FAILED', failure: 'An internal error occurred.', failureCode: 'INTERNAL.BAD_OUTPUT.01', cost: { credits: 0 } };
  if (slow ? p < 60 : p <= 3) return { ...base, status: 'RUNNING', progress: Math.min(0.95, (p - 1) * (slow ? 0.01 : 0.35)) };
  return { id: t.id, createdAt: t.createdAt, status: 'SUCCEEDED', output: [`http://127.0.0.1:${PORT}/outputs/${t.id}.mp4`], cost: { credits: t.credits } };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/outputs/')) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': VIDEO.length, 'Access-Control-Allow-Origin': '*' });
    return res.end(VIDEO);
  }
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${KEY}`) return send(res, 401, { error: 'The provided API key is not valid.' });
  if (!req.headers['x-runway-version']) return send(res, 400, { error: 'X-Runway-Version header is required.' });

  if (req.method === 'POST' && url.pathname === '/v1/image_to_video') {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    log.push({ path: url.pathname, body: { ...body, promptImage: `${String(body.promptImage).slice(0, 30)}… (${String(body.promptImage).length} chars)` } });
    const issues = [];
    if (!['gen4.5', 'gen4_turbo', 'veo3.1', 'veo3.1_fast'].includes(body.model)) issues.push('model');
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(body.promptImage || '') && !/^https:/.test(body.promptImage || '')) issues.push('promptImage');
    if (String(body.promptImage).length > 5_000_000) issues.push('promptImage too large');
    if (!body.ratio) issues.push('ratio');
    if (body.model === 'gen4.5' && !body.promptText) issues.push('promptText');
    if (issues.length) return send(res, 400, { error: `Invalid request: ${issues.join(', ')}`, issues });
    if (body.promptText?.includes('RATE_LIMIT')) return send(res, 429, { error: 'Too many requests.' }, { 'Retry-After': '1' });
    if (body.promptText?.includes('NO_CREDITS')) return send(res, 400, { error: 'You do not have enough credits to run this task.' });
    const id = crypto.randomUUID();
    const credits = { 'gen4.5': 12, gen4_turbo: 5, 'veo3.1_fast': 10, 'veo3.1': 40 }[body.model] * (body.duration || 5);
    tasks.set(id, { id, body, credits, polls: 0, createdAt: new Date().toISOString() });
    return send(res, 200, { id, estimatedCost: { credits } });
  }
  const m = url.pathname.match(/^\/v1\/tasks\/([\w-]+)$/);
  if (m) {
    const t = tasks.get(m[1]);
    if (!t) return send(res, 404, { error: 'Task not found.' });
    if (req.method === 'GET') return send(res, 200, statusOf(t));
    if (req.method === 'DELETE') {
      t.cancelled = true;
      res.writeHead(204);
      return res.end();
    }
  }
  if (req.method === 'GET' && url.pathname === '/v1/organization') return send(res, 200, { creditBalance: 4200, tier: { maxMonthlyCreditSpend: 100000 } });
  if (url.pathname === '/__log') return send(res, 200, log);
  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => console.log(`[runway-test-double] listening on :${PORT}`));
