// ZeroGPU quota helper. Hugging Face doesn't expose the remaining quota via API, but its
// quota error says exactly how much is left and when it resets — we remember that.
const KEY = 'cas.zerogpu.v1';

export function parseQuotaError(message = '') {
  const m = /\((\d+)s requested vs\.? (\d+)s left\)/i.exec(message);
  const r = /try again in (\d+):(\d{2}):(\d{2})/i.exec(message);
  if (!m && !r) return null;
  const info = {
    requested: m ? Number(m[1]) : null,
    left: m ? Number(m[2]) : null,
    resetAt: r ? Date.now() + ((Number(r[1]) * 60 + Number(r[2])) * 60 + Number(r[3])) * 1000 : null,
    seenAt: Date.now(),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(info));
  } catch {
    /* ignore */
  }
  return info;
}

export function lastQuota() {
  try {
    const q = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!q) return null;
    if (q.resetAt && Date.now() > q.resetAt) {
      localStorage.removeItem(KEY);
      return null;
    }
    return q;
  } catch {
    return null;
  }
}

const fmtClock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** A plain-English explanation to append to quota errors. */
export function explainQuota(info) {
  if (!info) return '';
  const parts = [];
  if (info.requested != null) {
    parts.push(
      `This model has to reserve ${info.requested}s before it starts, and you have ${info.left}s left today. ` +
        'Hugging Face only charges the time actually used (often much less than the reservation), but it won’t start a job unless the full reservation is available.'
    );
  }
  if (info.resetAt) parts.push(`Your allowance resets at about ${fmtClock(info.resetAt)}.`);
  if (info.left != null && info.left >= 30) parts.push(`With ${info.left}s left you can still try a 3-second Wan 2.2 Fast video (it reserves only about 29s).`);
  return parts.join(' ');
}

export function quotaLine() {
  const q = lastQuota();
  if (!q) return '';
  return `Last known: ${q.left != null ? `${q.left}s left` : 'allowance used up'}${q.resetAt ? ` · resets ≈ ${fmtClock(q.resetAt)}` : ''}`;
}
