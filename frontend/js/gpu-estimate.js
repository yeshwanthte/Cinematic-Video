// ZeroGPU reservation estimates, using the formula each Space publishes in its own app.py.
// A run only starts if your remaining daily allowance covers this reservation; Hugging Face
// then deducts the GPU time actually used (usually less).

/**
 * @param {object} c model capabilities (server/models.js)
 * @param {{ratio:string, duration:number, quality?:string, fps?:number}} s
 * @returns {number|null} seconds
 */
export function gpuSeconds(c, s) {
  const g = c?.gpuEstimate;
  if (!g) return null;
  if (g.kind === 'fixed') return g.seconds;
  const [w, h] = String(s.ratio || '832:480').split(':').map(Number);
  const frames = 1 + Math.min(g.maxFrames, Math.max(g.minFrames, Math.round((Number(s.duration) || 5) * g.fps)));
  const factor = (frames * w * h) / g.baseVolume;
  const steps = (c.qualityPresets || []).find((q) => q.id === s.quality)?.steps ?? (c.qualityPresets || []).find((q) => q.id === c.defaultQuality)?.steps ?? g.steps;
  let t = g.base + steps * g.stepSeconds * factor ** 1.5;
  const fpsOpt = (c.fpsOptions || []).find((f) => f.value === Number(s.fps));
  const mult = fpsOpt?.multiplier ? fpsOpt.multiplier / 16 : 1;
  if (g.interpPerFrame && mult > 1) t += (frames * mult - frames) * g.interpPerFrame;
  if (g.safeMode) t *= g.safeMode;
  return Math.round(t);
}

const KEY = 'cas.gpu.v1';
const today = () => new Date().toISOString().slice(0, 10);

/** Local, per-browser tally of reservations made today (an upper bound, not HF's real meter). */
export const gpuTally = {
  get() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY) || '{}');
      return v.day === today() ? v : { day: today(), reserved: 0, runs: 0 };
    } catch {
      return { day: today(), reserved: 0, runs: 0 };
    }
  },
  add(seconds) {
    if (!seconds) return;
    const v = this.get();
    v.reserved += seconds;
    v.runs += 1;
    try {
      localStorage.setItem(KEY, JSON.stringify(v));
    } catch {
      /* storage blocked */
    }
  },
};
