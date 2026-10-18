// Best-effort abuse protection for GPU-spending routes (generate, image).
//
// • Duplicate guard: the browser sends a unique X-Request-Id per user action. The same id
//   arriving again (double click, network retry, two tabs replaying) is rejected with 409,
//   so one click can never spend GPU twice.
// • Concurrency: at most MAX_CONCURRENT_JOBS (default 3) running jobs per client IP.
// • Rate: at most RATE_LIMIT_PER_HOUR (default 30) jobs per client IP per rolling hour.
//
// State lives in memory, so on serverless hosts it is per warm instance — a strong guard
// against accidental duplicates and runaway loops, not a guarantee against a determined
// attacker. STUDIO_ACCESS_CODE remains the real gate for a public deployment.
import { StudioError } from './errors.js';

const seenIds = new Map(); // requestId -> expiresAt
const running = new Map(); // clientKey -> count
const history = new Map(); // clientKey -> [timestamps]
const HOUR = 3_600_000;

function clientKey(request) {
  const fwd = request.headers.get('x-forwarded-for') || '';
  return (fwd.split(',')[0] || request.headers.get('x-real-ip') || 'local').trim().slice(0, 64);
}

function sweep(now) {
  for (const [id, exp] of seenIds) if (exp < now) seenIds.delete(id);
  for (const [k, list] of history) {
    const kept = list.filter((t) => now - t < HOUR);
    if (kept.length) history.set(k, kept);
    else history.delete(k);
  }
}

/** Reserves a job slot or throws. Returns release() — call exactly once when the job ends. */
export function acquireJobSlot(request, env = {}, now = Date.now()) {
  sweep(now);
  const maxConcurrent = Math.max(1, Number(env.MAX_CONCURRENT_JOBS) || 3);
  const perHour = Math.max(1, Number(env.RATE_LIMIT_PER_HOUR) || 30);
  const key = clientKey(request);

  const rid = (request.headers.get('x-request-id') || '').trim();
  if (rid) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(rid)) throw new StudioError('INVALID_REQUEST', 'Invalid X-Request-Id header.');
    if (seenIds.has(rid)) throw new StudioError('DUPLICATE_REQUEST', 'This exact generation request was already received, so it was not started twice. Check the running job or press Generate again for a new one.');
  }
  if ((running.get(key) || 0) >= maxConcurrent) {
    throw new StudioError('RATE_LIMITED', `Only ${maxConcurrent} generations can run at the same time. Wait for one to finish.`, { retryAfter: 20 });
  }
  const recent = history.get(key) || [];
  if (recent.length >= perHour) {
    const wait = Math.ceil((HOUR - (now - recent[0])) / 1000);
    throw new StudioError('RATE_LIMITED', `Limit of ${perHour} generations per hour reached (set by RATE_LIMIT_PER_HOUR on the backend). Try again in ${Math.ceil(wait / 60)} min.`, { retryAfter: wait });
  }
  if (rid) seenIds.set(rid, now + 10 * 60_000);
  running.set(key, (running.get(key) || 0) + 1);
  history.set(key, [...recent, now]);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (running.get(key) || 1) - 1;
    if (n > 0) running.set(key, n);
    else running.delete(key);
  };
}

export function _resetRateLimits() {
  seenIds.clear();
  running.clear();
  history.clear();
}
