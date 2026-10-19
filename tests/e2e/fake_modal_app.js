// TEST ONLY — a local HTTP server with the SAME API as modal/wan_app.py (POST /jobs, GET /jobs/{id},
// GET /jobs/{id}/video, DELETE /jobs/{id}, GET /health, Bearer auth). Renders a real WebM with ffmpeg.
// Prompt switches: CREDITS → Modal out-of-credits failure, BOOM → generic failure.
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.PORT || 7890);
const SECRET = process.env.STUDIO_MODAL_SECRET || 'test-modal-secret';
const jobs = new Map();
export const calls = [];

function sizeFor(w, h, maxDim) {
  const ar = w / h;
  if (Math.abs(ar - 1) < 1e-6) return [Math.round((maxDim * 640) / 832 / 16) * 16, Math.round((maxDim * 640) / 832 / 16) * 16];
  let tw = ar > 1 ? maxDim : maxDim * ar;
  let th = ar > 1 ? maxDim / ar : maxDim;
  const clamp = (v) => Math.max(480, Math.min(maxDim, Math.round(v / 16) * 16));
  return [clamp(tw), clamp(th)];
}

function render(job) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fm-'));
  const src = path.join(dir, 'in.jpg');
  writeFileSync(src, Buffer.from(job.image.split(',')[1], 'base64'));
  const dims = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', src]).toString().trim().split(',').map(Number);
  const [w, h] = sizeFor(dims[0], dims[1], job.max_dim);
  const frames = 1 + Math.max(8, Math.min(80, Math.round(job.duration * 16)));
  const out = path.join(dir, 'out.webm');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-loop', '1', '-i', src, '-vf', `scale=${w}:${h},zoompan=z='1+0.002*on':d=${frames}:s=${w}x${h}:fps=16`, '-frames:v', String(frames), '-pix_fmt', 'yuv420p', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '500k', out]);
  return { video: readFileSync(out), w, h, frames };
}

const send = (res, code, obj, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type });
  res.end(type === 'application/json' ? JSON.stringify(obj) : obj);
};

http
  .createServer(async (req, res) => {
    if ((req.headers.authorization || '') !== `Bearer ${SECRET}`) return send(res, 401, { error: 'Missing or wrong Authorization bearer token.' });
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/jobs\/([\w-]+)(\/video)?$/);
    if (url.pathname === '/health') return send(res, 200, { ok: true, gpu: 'H200', model: 'Wan-AI/Wan2.2-I2V-A14B-Diffusers', maxContainers: 1 });
    if (url.pathname === '/__calls') return send(res, 200, calls);
    if (req.method === 'POST' && url.pathname === '/jobs') {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      if (!String(body.image || '').startsWith('data:image/')) return send(res, 400, { error: 'image must be a data URI' });
      calls.push({ steps: body.steps, duration: body.duration, max_dim: body.max_dim, last_image: Boolean(body.last_image), seed: body.seed, prompt: body.prompt.slice(0, 60), negative: Boolean(body.negative_prompt) });
      const id = `fc-${Math.random().toString(36).slice(2, 14)}`;
      jobs.set(id, { body, polls: 0, state: 'queued' });
      return send(res, 200, { id });
    }
    if (!m || !jobs.has(m[1])) return send(res, 404, { error: 'Unknown job id.' });
    const job = jobs.get(m[1]);
    if (req.method === 'DELETE') {
      job.state = 'cancelled';
      return send(res, 200, { cancelled: true });
    }
    if (m[2]) {
      if (job.state !== 'succeeded') return send(res, 409, { error: 'Not finished yet.' });
      return send(res, 200, job.out.video, 'video/webm');
    }
    if (job.state === 'cancelled') return send(res, 200, { status: 'cancelled' });
    job.polls++;
    if (/CREDITS/.test(job.body.prompt)) return send(res, 200, { status: 'failed', error: 'Workspace billing cycle spend limit reached' });
    if (/BOOM/.test(job.body.prompt)) return send(res, 200, { status: 'failed', error: 'CUDA error: an illegal memory access was encountered' });
    if (job.polls === 1) return send(res, 200, { status: 'queued', note: 'Waiting for the GPU (a cold start loads the model, ~1–2 min)' });
    const steps = job.body.steps;
    const step = (job.polls - 1) * 2;
    if (step < steps) return send(res, 200, { status: 'running', step, steps, progress: step / steps });
    if (!job.out) job.out = render(job.body);
    job.state = 'succeeded';
    return send(res, 200, { status: 'succeeded', progress: 1, seed: job.body.seed ?? 1234, width: job.out.w, height: job.out.h, fps: 16, frames: job.out.frames });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`fake modal app on ${PORT}`));
