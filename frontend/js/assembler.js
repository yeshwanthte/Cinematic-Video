// In-browser video assembly with ffmpeg.wasm (single-threaded core: works on GitHub Pages
// and Vercel without special COOP/COEP headers). Nothing is uploaded — clips, music and the
// exported film never leave this browser.
//
// The small @ffmpeg/ffmpeg wrapper is vendored in /vendor/ffmpeg (same-origin worker).
// The ~31 MB WebAssembly core is fetched once from a CDN and cached by the browser;
// override with STUDIO_CONFIG.ffmpegCoreBase to self-host it.
import { FFmpeg } from '../vendor/ffmpeg/index.js';
import { buildAssemblyGraph, describeAssembly } from './assembler-graph.js';

const DEFAULT_CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
let instance = null;
let loading = null;
let logSink = null;

async function toBlobURLWithProgress(url, mime, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download ${url.split('/').pop()} (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !onBytes) return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: mime }));
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.byteLength;
    onBytes(got, total);
  }
  return URL.createObjectURL(new Blob(parts, { type: mime }));
}

/** Loads ffmpeg.wasm once. onStatus(text, fraction|null) */
export async function getFFmpeg(onStatus = () => {}) {
  if (instance) return instance;
  if (loading) return loading;
  loading = (async () => {
    const base = (window.STUDIO_CONFIG?.ffmpegCoreBase || DEFAULT_CORE).replace(/\/+$/, '');
    onStatus('Loading the video engine (ffmpeg.wasm, ~31 MB, cached after the first time)…', 0);
    const coreURL = await toBlobURLWithProgress(`${base}/ffmpeg-core.js`, 'text/javascript');
    const wasmURL = await toBlobURLWithProgress(`${base}/ffmpeg-core.wasm`, 'application/wasm', (got, total) =>
      onStatus(`Loading the video engine… ${(got / 1e6).toFixed(1)}${total ? ` / ${(total / 1e6).toFixed(1)}` : ''} MB`, total ? got / total : null)
    );
    const ff = new FFmpeg();
    ff.on('log', ({ message }) => logSink?.(message));
    await ff.load({ coreURL, wasmURL });
    instance = ff;
    return ff;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

function terminate() {
  try {
    instance?.terminate();
  } catch {
    /* already gone */
  }
  instance = null;
}

const ext = (blob) => (/webm/.test(blob?.type || '') ? 'webm' : /quicktime/.test(blob?.type || '') ? 'mov' : /mpeg|mp3/.test(blob?.type || '') ? 'mp3' : /wav/.test(blob?.type || '') ? 'wav' : /ogg/.test(blob?.type || '') ? 'ogg' : /aac|mp4a|m4a/.test(blob?.type || '') ? 'm4a' : 'mp4');

/** Reads duration / audio / fps from FFmpeg's own stream report. */
async function probe(ff, name) {
  const lines = [];
  logSink = (m) => lines.push(m);
  try {
    await ff.exec(['-hide_banner', '-i', name, '-t', '0', '-f', 'null', '-']);
  } catch {
    /* exit code is irrelevant; we only want the report */
  }
  logSink = null;
  const text = lines.join('\n');
  const d = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
  const fps = Number((text.match(/(\d+(?:\.\d+)?)\s*fps/) || [])[1]) || null;
  const size = text.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
  return { duration, hasAudio: /Stream #\d+:\d+.*Audio:/.test(text), fps, width: size ? Number(size[1]) : null, height: size ? Number(size[2]) : null };
}

/**
 * @param {object} job
 * @param {Array<{blob:Blob, duration?:number, trimStart?:number|'auto', transition?:string}>} job.clips  in order
 * @param {{blob:Blob, volume:number, fadeIn:number, fadeOut:number}|null} job.music
 * @param {object} job.settings { transition, transitionSeconds, width|'native', height, fps|'native', interpolate, keepOriginalAudio, originalVolume, fadeEdges }
 * @param {(p:{phase:string, text:string, fraction:number|null})=>void} [job.onProgress]
 * @param {AbortSignal} [job.signal]
 * @returns {Promise<{blob:Blob, seconds:number, summary:string[], hasAudio:boolean, width:number, height:number, fps:number}>}
 */
export async function assembleFilm({ clips, music = null, settings = {}, onProgress = () => {}, signal } = {}) {
  if (!clips?.length) throw new Error('There are no finished clips to assemble yet.');
  const report = (phase, text, fraction = null) => onProgress({ phase, text, fraction });
  const ff = await getFFmpeg((t, f) => report('load', t, f));
  const onAbort = () => terminate();
  signal?.addEventListener('abort', onAbort, { once: true });
  const written = [];
  try {
    report('prepare', 'Reading clips…');
    const meta = [];
    for (let i = 0; i < clips.length; i++) {
      const name = `clip${i}.${ext(clips[i].blob)}`;
      await ff.writeFile(name, new Uint8Array(await clips[i].blob.arrayBuffer()));
      written.push(name);
      const m = await probe(ff, name);
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      meta.push({ ...m, name });
    }
    let musicName = null;
    if (music?.blob) {
      musicName = `music.${ext(music.blob)}`;
      await ff.writeFile(musicName, new Uint8Array(await music.blob.arrayBuffer()));
      written.push(musicName);
    }
    const first = meta[0];
    const fps = settings.fps === 'native' || !settings.fps ? Math.round(Math.max(...meta.map((m) => m.fps || 0)) || 24) : Number(settings.fps);
    const width = settings.width === 'native' || !settings.width ? first.width || 832 : Number(settings.width);
    const height = settings.width === 'native' || !settings.height ? first.height || 480 : Number(settings.height);
    const graphClips = clips.map((c, i) => ({
      name: meta[i].name,
      duration: meta[i].duration || c.duration,
      hasAudio: meta[i].hasAudio,
      fps: meta[i].fps,
      trimStart: c.trimStart === 'auto' ? 1 / (meta[i].fps || 16) : Number(c.trimStart) || 0,
      transition: c.transition,
    }));
    const opts = {
      clips: graphClips,
      transition: settings.transition || 'crossfade',
      transitionSeconds: settings.transitionSeconds ?? 0.5,
      width,
      height,
      fps,
      interpolate: Boolean(settings.interpolate),
      keepOriginalAudio: settings.keepOriginalAudio !== false,
      originalVolume: settings.originalVolume ?? 1,
      music: musicName ? { name: musicName, volume: music.volume ?? 0.8, fadeIn: music.fadeIn ?? 1, fadeOut: music.fadeOut ?? 2 } : null,
      fadeEdges: Boolean(settings.fadeEdges),
    };
    const g = buildAssemblyGraph(opts);
    const out = 'film.mp4';
    const args = ['-hide_banner', '-y', ...g.inputArgs, '-filter_complex', g.filter, ...g.outputArgs, out];
    const tail = [];
    logSink = (m) => {
      tail.push(m);
      if (tail.length > 40) tail.shift();
      const t = m.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (t) {
        const sec = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
        report('encode', `Encoding H.264/AAC MP4… ${sec.toFixed(1)} / ${g.totalSeconds.toFixed(1)} s`, Math.min(1, sec / g.totalSeconds));
      }
    };
    report('encode', `Encoding H.264/AAC MP4… 0.0 / ${g.totalSeconds.toFixed(1)} s`, 0);
    const code = await ff.exec(args);
    logSink = null;
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (code !== 0) throw new Error(`FFmpeg could not assemble the film (exit ${code}). ${tail.slice(-4).join(' ')}`);
    written.push(out);
    const data = await ff.readFile(out);
    const blob = new Blob([data.buffer ? data : new Uint8Array(data)], { type: 'video/mp4' });
    report('done', 'Done', 1);
    return { blob, seconds: g.totalSeconds, summary: describeAssembly(opts, g), hasAudio: g.hasAudio, width, height, fps };
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError' || /terminate/i.test(String(err?.message))) {
      const e = new Error('Export cancelled.');
      e.code = 'CANCELLED';
      throw e;
    }
    throw err;
  } finally {
    logSink = null;
    signal?.removeEventListener('abort', onAbort);
    if (instance) for (const f of written) await instance.deleteFile(f).catch(() => {});
  }
}

/** Grabs the real last frame of a generated clip (used to start the next shot). */
export async function extractLastFrame(blob, { quality = 0.95 } = {}) {
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  try {
    await new Promise((res, rej) => {
      v.onloadeddata = res;
      v.onerror = () => rej(new Error('This browser could not decode the clip to read its last frame.'));
      setTimeout(() => rej(new Error('Timed out reading the clip.')), 20000);
    });
    if (!isFinite(v.duration)) {
      // Some WebM files report Infinity until fully scanned.
      v.currentTime = 1e6;
      await new Promise((r) => (v.onseeked = r));
    }
    const target = Math.max(0, v.duration - 0.02);
    await new Promise((res) => {
      v.onseeked = res;
      v.currentTime = target;
    });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const frame = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
    if (!frame) throw new Error('Could not capture the last frame.');
    return { blob: frame, width: c.width, height: c.height, duration: v.duration };
  } finally {
    URL.revokeObjectURL(url);
    v.removeAttribute('src');
    v.load();
  }
}
