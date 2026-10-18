// Pure FFmpeg graph builder for the in-browser assembler (no DOM, unit-tested in Node).
//
// Each clip is normalised (trim → fps → scale/pad → SAR → yuv420p), then joined with a
// hard cut (concat) or an overlap transition (xfade). Original clip audio is placed on the
// same timeline with adelay and mixed; user music is looped, trimmed, faded and mixed.
// Output: H.264 (yuv420p, +faststart) + AAC in MP4 — plays everywhere.

const r6 = (n) => Math.round(n * 1e6) / 1e6;
const XFADE = { crossfade: 'fade', dip: 'fadeblack', fadewhite: 'fadewhite', slideleft: 'slideleft', wipeleft: 'wipeleft' };

/**
 * @param {object} o
 * @param {Array<{duration:number, hasAudio?:boolean, trimStart?:number, transition?:string, name?:string}>} o.clips
 * @param {string} [o.transition='crossfade']  default for clips without their own (cut|crossfade|dip|…)
 * @param {number} [o.transitionSeconds=0.5]
 * @param {number} o.width  @param {number} o.height  @param {number} o.fps  output frame rate
 * @param {boolean} [o.interpolate] motion-interpolate to o.fps (synthesized frames; slow)
 * @param {boolean} [o.keepOriginalAudio=true]  @param {number} [o.originalVolume=1]
 * @param {{volume:number, fadeIn:number, fadeOut:number, name?:string}|null} [o.music]
 * @param {boolean} [o.fadeEdges] fade from/to black at the very start and end
 * @param {number} [o.crf=20]  @param {string} [o.preset='veryfast']
 */
export function buildAssemblyGraph(o) {
  const clips = o.clips || [];
  if (!clips.length) throw new Error('No clips to assemble.');
  const W = even(o.width), H = even(o.height);
  const fps = Number(o.fps) || 24;
  const T = Math.max(0.1, Math.min(2, Number(o.transitionSeconds ?? 0.5)));
  const inputArgs = [];
  const f = [];

  // ---- video: normalise each clip
  const lens = [];
  clips.forEach((c, i) => {
    inputArgs.push('-i', c.name || `clip${i}.mp4`);
    const trim = Math.max(0, Number(c.trimStart) || 0);
    const len = r6(Math.max(0.2, Number(c.duration) - trim));
    lens.push(len);
    const chain = [];
    if (trim > 0) chain.push(`trim=start=${r6(trim)}`, 'setpts=PTS-STARTPTS');
    chain.push(`fps=${o.interpolate ? clipNativeFps(c, fps) : fps}`);
    chain.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos`, `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`, 'setsar=1', 'format=yuv420p', 'settb=AVTB');
    f.push(`[${i}:v]${chain.join(',')}[c${i}]`);
  });

  // ---- video: join, tracking where each clip starts on the output timeline
  const starts = [0];
  let cur = 'c0';
  let curLen = lens[0];
  for (let i = 1; i < clips.length; i++) {
    const kind = clips[i].transition && clips[i].transition !== 'none' ? clips[i].transition : o.transition || 'crossfade';
    const out = `v${i}`;
    const t = Math.min(T, lens[i - 1] / 2, lens[i] / 2);
    if (kind === 'cut' || !XFADE[kind]) {
      f.push(`[${cur}][c${i}]concat=n=2:v=1:a=0[${out}]`);
      starts.push(r6(curLen));
      curLen = r6(curLen + lens[i]);
    } else {
      const offset = r6(curLen - t);
      f.push(`[${cur}][c${i}]xfade=transition=${XFADE[kind]}:duration=${r6(t)}:offset=${offset}[${out}]`);
      starts.push(offset);
      curLen = r6(curLen + lens[i] - t);
      clips[i]._fadeIn = t;
      clips[i - 1]._fadeOut = t;
    }
    cur = out;
  }
  const total = curLen;
  const post = [];
  if (o.interpolate) post.push(`minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`);
  if (o.fadeEdges) post.push('fade=t=in:st=0:d=0.5', `fade=t=out:st=${r6(Math.max(0, total - 0.7))}:d=0.7`);
  post.push('format=yuv420p');
  f.push(`[${cur}]${post.join(',')}[vout]`);

  // ---- audio
  const keep = o.keepOriginalAudio !== false;
  const origVol = Number(o.originalVolume ?? 1);
  const orig = [];
  if (keep) {
    clips.forEach((c, i) => {
      if (!c.hasAudio) return;
      const trim = Math.max(0, Number(c.trimStart) || 0);
      const fi = Math.max(0.02, c._fadeIn || 0);
      const fo = Math.max(0.02, c._fadeOut || 0);
      const ms = Math.round(starts[i] * 1000);
      f.push(
        `[${i}:a]atrim=start=${r6(trim)}:duration=${lens[i]},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,` +
          `volume=${origVol},afade=t=in:st=0:d=${r6(fi)},afade=t=out:st=${r6(Math.max(0, lens[i] - fo))}:d=${r6(fo)},adelay=${ms}|${ms}[a${i}]`
      );
      orig.push(`[a${i}]`);
    });
  }
  let audioOut = null;
  if (orig.length) {
    f.push(`${orig.join('')}${orig.length > 1 ? `amix=inputs=${orig.length}:normalize=0:duration=longest,` : ''}apad=whole_dur=${total},atrim=duration=${total}[orig]`);
    audioOut = 'orig';
  }
  if (o.music) {
    const mi = clips.length;
    inputArgs.push('-stream_loop', '-1', '-i', o.music.name || 'music');
    const fi = Math.max(0, Number(o.music.fadeIn) || 0);
    const fo = Math.max(0, Number(o.music.fadeOut) || 0);
    const chain = [`atrim=duration=${total}`, 'asetpts=PTS-STARTPTS', 'aformat=sample_rates=48000:channel_layouts=stereo', `volume=${Number(o.music.volume ?? 0.8)}`];
    if (fi) chain.push(`afade=t=in:st=0:d=${r6(fi)}`);
    if (fo) chain.push(`afade=t=out:st=${r6(Math.max(0, total - fo))}:d=${r6(fo)}`);
    f.push(`[${mi}:a]${chain.join(',')}[mus]`);
    if (audioOut) {
      f.push(`[orig][mus]amix=inputs=2:normalize=0:duration=first[aout]`);
      audioOut = 'aout';
    } else audioOut = 'mus';
  }

  const outputArgs = ['-map', '[vout]'];
  if (audioOut) outputArgs.push('-map', `[${audioOut}]`, '-c:a', 'aac', '-b:a', '160k', '-ar', '48000');
  outputArgs.push('-c:v', 'libx264', '-preset', o.preset || 'veryfast', '-crf', String(o.crf ?? 20), '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart', '-t', String(total));
  clips.forEach((c) => {
    delete c._fadeIn;
    delete c._fadeOut;
  });
  return { inputArgs, filter: f.join(';'), outputArgs, totalSeconds: total, hasAudio: Boolean(audioOut), starts };
}

function even(n) {
  const v = Math.max(2, Math.round(Number(n) || 2));
  return v % 2 ? v + 1 : v;
}
function clipNativeFps(c, fallback) {
  return Number(c.fps) || fallback;
}

/** Human description used in the export summary (what is AI, what is post-processing). */
export function describeAssembly(o, g) {
  const lines = [];
  const n = o.clips.length;
  const native = o.clips.reduce((a, c) => a + Number(c.duration || 0), 0);
  lines.push(`${n} AI-generated clip${n > 1 ? 's' : ''} (${native.toFixed(1)} s of native AI video) assembled into ${g.totalSeconds.toFixed(1)} s.`);
  if (o.clips.some((c) => c.trimStart > 0)) lines.push('Continued shots drop their first frame, which repeats the previous shot’s last frame.');
  if (o.interpolate) lines.push(`Frame rate raised to ${o.fps} fps by motion interpolation — the extra frames are synthesized by FFmpeg, not generated by the AI model.`);
  lines.push(`Resized to ${o.width}×${o.height} with Lanczos scaling — resizing adds no new detail.`);
  if (o.music) lines.push('Music: your uploaded track (not AI-generated).');
  if (o.keepOriginalAudio !== false && o.clips.some((c) => c.hasAudio)) lines.push('Original clip audio: generated by the AI model together with the video (LTX-2.3 native audio).');
  if (!g.hasAudio) lines.push('Silent video (no audio track).');
  return lines;
}
