import { Client } from '@gradio/client';
import { VideoProvider } from './VideoProvider.js';
import { StudioError, toStudioError } from '../core/errors.js';

/**
 * FREE provider: open-source image-to-video models running on Hugging Face
 * ZeroGPU Spaces, called through the official Gradio client.
 *
 * - Free Hugging Face account + free access token (HF_TOKEN). ZeroGPU gives each
 *   free account a small daily GPU allowance (≈5 min/day at the time of writing);
 *   calls made with your token count against YOUR allowance.
 * - Gradio jobs are bound to an open connection (disconnecting cancels the job),
 *   so this provider STREAMS status events instead of being polled.
 *   The router turns these events into an NDJSON response the browser reads live.
 */
export class HuggingFaceProvider extends VideoProvider {
  constructor({ token, spaceOverrides = {} } = {}) {
    super();
    this.token = token || '';
    this.spaceOverrides = spaceOverrides; // modelId -> space id / URL (tests, self-hosted mirrors)
  }

  get id() {
    return 'huggingface';
  }

  get mode() {
    return 'stream';
  }

  isConfigured() {
    return Boolean(this.token);
  }

  spaceFor(caps, modelId) {
    return this.spaceOverrides[modelId] || this.spaceOverrides['*'] || caps.space;
  }

  #connectOptions() {
    return { token: this.token || undefined, events: ['data', 'status'] };
  }

  /**
   * Streams normalised events:
   *  { type:'accepted', taskId }            job submitted to the Space queue
   *  { type:'queued', position, size, eta } waiting for a ZeroGPU slot
   *  { type:'started' }                     GPU allocated, model running
   *  { type:'progress', progress, step, steps, desc }  real tqdm steps from the Space
   *  { type:'completed', outputs:[url], seed }
   *  errors are thrown as StudioError
   */
  async *generateStream(job, caps, { signal } = {}) {
    this.#requireToken();
    const params = {
      [caps.params?.image || 'input_image']: dataUriToBlob(job.image),
      prompt: job.prompt,
      steps: caps.params?.steps ?? 4,
      negative_prompt: [caps.params?.baseNegative, job.negativePrompt].filter(Boolean).join(', '),
      duration_seconds: job.duration,
      seed: Number.isInteger(job.seed) ? job.seed : 42,
      randomize_seed: !Number.isInteger(job.seed),
    };
    yield* this.#runSpace({
      space: this.spaceFor(caps, job.model),
      endpoint: caps.endpoint || '/generate_video',
      params,
      signal,
      findOutput: findVideoUrl,
      what: 'video',
    });
  }

  /**
   * Image generation / editing on a ZeroGPU Space (Qwen-Image-Edit, FLUX Kontext, FLUX schnell).
   * job: { model, mode:'edit'|'create', images:[dataUri], prompt, seed, width, height }
   */
  async *generateImageStream(job, caps, { signal } = {}) {
    this.#requireToken();
    const p = caps.params || {};
    const params = { ...(p.fixed || {}) };
    params[p.prompt || 'prompt'] = job.prompt;
    if (job.images?.length && p.image) {
      const blobs = job.images.map(dataUriToBlob);
      params[p.image] = p.imageIsGallery ? blobs.map((b) => ({ image: b, caption: null })) : blobs[0];
    }
    if (p.seed) params[p.seed] = Number.isInteger(job.seed) ? job.seed : 42;
    if (p.randomize) params[p.randomize] = !Number.isInteger(job.seed);
    if (job.width && p.width) params[p.width] = job.width;
    if (job.height && p.height) params[p.height] = job.height;
    yield* this.#runSpace({
      space: this.spaceFor(caps, job.model),
      endpoint: caps.endpoint || '/infer',
      params,
      signal,
      findOutput: findImageUrl,
      what: 'image',
    });
  }

  #requireToken() {
    if (!this.isConfigured()) {
      throw new StudioError('NOT_CONFIGURED', 'HF_TOKEN is not set on the backend. Create a free token at huggingface.co/settings/tokens and add it as an environment variable.');
    }
  }

  /** Shared Gradio job runner: connect → fit params → submit → stream status → fetch output inline. */
  async *#runSpace({ space, endpoint, params, signal, findOutput, what }) {
    let client;
    try {
      client = await Client.connect(space, this.#connectOptions());
    } catch (err) {
      throw mapConnectError(err, space);
    }
    await this.#fitToEndpoint(client, endpoint, params, space);

    let submission;
    try {
      submission = client.submit(endpoint, params);
    } catch (err) {
      client.close?.();
      throw mapRunError(err);
    }
    const abort = () => {
      try {
        submission.cancel();
      } catch {
        /* already finished */
      }
      client.close?.();
    };
    signal?.addEventListener('abort', abort, { once: true });

    const taskId = `hf_${client.session_hash || Date.now().toString(36)}`;
    yield { type: 'accepted', taskId, space };

    let started = false;
    try {
      for await (const msg of submission) {
        if (signal?.aborted) throw new StudioError('INVALID_REQUEST', 'Generation cancelled.');
        if (msg.type === 'status') {
          if (msg.stage === 'error') throw mapRunError(new Error(msg.message || 'The Space reported an error.'));
          if (msg.original_msg === 'process_starts' || msg.progress_data) {
            if (!started) {
              started = true;
              yield { type: 'started' };
            }
            const pd = msg.progress_data?.find((d) => d.length);
            if (pd) {
              yield { type: 'progress', progress: Math.min(1, (pd.index ?? 0) / pd.length), step: pd.index, steps: pd.length, desc: pd.desc || pd.unit || 'steps' };
            }
          } else if (msg.stage === 'pending' && msg.position != null) {
            yield { type: 'queued', position: msg.position, size: msg.size ?? null, eta: msg.eta ?? null };
          }
        } else if (msg.type === 'data') {
          const url = findOutput(msg.data);
          if (!url) throw new StudioError('PROVIDER_ERROR', `The Space finished but returned no ${what} file.`);
          const seed = msg.data.find((v) => typeof v === 'number');
          // Fetch the file NOW, from this same server instance. Busy Spaces run several
          // replicas and route by client, so a later request from a different server
          // (or from the browser) can land on a replica that doesn't have the file (403).
          yield { type: 'saving' };
          const file = await this.#fetchFile(url, signal, what === 'image' ? 'image/webp' : 'video/mp4');
          if (file) {
            const b64 = toBase64(new Uint8Array(file.bytes));
            const CHUNK = 512 * 1024;
            for (let i = 0; i < b64.length; i += CHUNK) yield { type: 'file_chunk', data: b64.slice(i, i + CHUNK) };
            yield { type: 'completed', outputs: [url], seed: seed ?? null, inline: { mime: file.mime, size: file.bytes.byteLength } };
          } else {
            yield { type: 'completed', outputs: [url], seed: seed ?? null };
          }
          return;
        }
      }
      throw new StudioError('PROVIDER_ERROR', `The Space closed the connection before returning the ${what}.`);
    } catch (err) {
      throw err instanceof StudioError ? err : mapRunError(err);
    } finally {
      signal?.removeEventListener('abort', abort);
      client.close?.();
    }
  }

  async generate() {
    throw new StudioError('NOT_IMPLEMENTED', 'Hugging Face Spaces are streamed, not polled — use generateStream().');
  }

  async getStatus() {
    throw new StudioError('NOT_IMPLEMENTED', 'Hugging Face jobs cannot be polled after the connection closes. Start a new generation.');
  }

  async cancel(taskId) {
    // Cancellation happens by closing the stream (the browser aborts its request).
    return { taskId, cancelled: true };
  }

  async getAccountInfo() {
    if (!this.token) return null;
    const res = await fetch('https://huggingface.co/api/whoami-v2', {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(10_000),
    }).catch((e) => {
      throw toStudioError(e);
    });
    if (res.status === 401) throw new StudioError('AUTH_FAILED', 'Hugging Face rejected HF_TOKEN (invalid or revoked).');
    if (!res.ok) throw new StudioError('PROVIDER_UNAVAILABLE', `Hugging Face account check failed (${res.status}).`);
    const me = await res.json();
    return { user: me.name, plan: me.isPro ? 'PRO' : 'Free', quotaNote: me.isPro ? '≈40 min GPU/day' : '≈5 min GPU/day' };
  }

  /**
   * Spaces differ in their inputs (e.g. community Spaces add "last_image").
   * Read the Space's own API description, drop inputs it doesn't have, and give
   * every required input without a default an empty value so the call is valid.
   */
  async #fitToEndpoint(client, endpoint, params, space) {
    let info;
    try {
      info = (await client.view_api())?.named_endpoints?.[endpoint];
    } catch {
      return; // keep params as-is; the Space will report anything missing
    }
    if (!info?.parameters) {
      throw new StudioError('PROVIDER_UNAVAILABLE', `The Space “${space}” no longer has the ${endpoint} function. It may have changed — pick another model.`);
    }
    const names = new Set(info.parameters.map((p) => p.parameter_name));
    for (const key of Object.keys(params)) if (!names.has(key)) delete params[key];
    for (const p of info.parameters) {
      if (p.parameter_name in params || p.parameter_has_default) continue;
      params[p.parameter_name] = null; // optional media like last_image → none
    }
  }

  async #fetchFile(url, signal, fallbackMime = 'video/mp4') {
    for (let i = 0; i < 8; i++) {
      if (signal?.aborted) return null;
      try {
        const res = await fetch(url, { headers: this.fileHeaders(url), cache: 'no-store', signal: AbortSignal.timeout(30_000) });
        if (res.ok) {
          const bytes = await res.arrayBuffer();
          if (bytes.byteLength > 0) return { bytes, mime: res.headers.get('content-type') || fallbackMime };
        } else {
          await res.body?.cancel().catch(() => {});
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 300 + i * 200));
    }
    return null;
  }

  /** Only proxy files served by Hugging Face Spaces (or an explicitly configured override host). */
  isAllowedFileUrl(url) {
    try {
      const u = new URL(url);
      const overrideHosts = Object.values(this.spaceOverrides)
        .filter((s) => /^https?:\/\//.test(s))
        .map((s) => new URL(s).host);
      const hostOk = (u.protocol === 'https:' && u.hostname.endsWith('.hf.space')) || overrideHosts.includes(u.host);
      return hostOk && u.pathname.includes('/file=');
    } catch {
      return false;
    }
  }

  fileHeaders(url) {
    const u = new URL(url);
    return this.token && u.hostname.endsWith('.hf.space') ? { Authorization: `Bearer ${this.token}` } : {};
  }
}

// ------------------------------------------------------------------ helpers

function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function dataUriToBlob(dataUri) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUri || '');
  if (!m) throw new StudioError('INVALID_IMAGE', 'Image must be a base64 data URI for Hugging Face Spaces.');
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}

function findImageUrl(data) {
  for (const v of data || []) {
    if (!v) continue;
    const items = Array.isArray(v) ? v : [v]; // gr.Gallery returns [{ image: FileData, caption }]
    for (const it of items) {
      const f = it?.image || it;
      if (f && typeof f === 'object' && (f.url || f.path)) return f.url || f.path;
      if (typeof f === 'string' && /\.(png|jpe?g|webp)(\?|$)/i.test(f)) return f;
    }
  }
  return null;
}

function findVideoUrl(data) {
  for (const v of data || []) {
    if (!v) continue;
    const f = v.video || v; // gr.Video may return { video: FileData, subtitles }
    if (typeof f === 'object' && (f.url || f.path)) return f.url || f.path;
    if (typeof v === 'string' && /\.(mp4|webm|mov)(\?|$)/i.test(v)) return v;
  }
  return null;
}

function mapConnectError(err, space) {
  const msg = String(err?.message || err);
  if (/sleep|paused|building|starting/i.test(msg)) {
    return new StudioError('PROVIDER_UNAVAILABLE', `The Hugging Face Space “${space}” is starting up or paused. Try again in a minute. (${msg})`);
  }
  if (/401|403|unauthori|invalid.*token/i.test(msg)) return new StudioError('AUTH_FAILED', `Hugging Face rejected HF_TOKEN: ${msg}`);
  if (/404|not found|could not resolve|Could not get/i.test(msg)) {
    return new StudioError('PROVIDER_UNAVAILABLE', `Could not reach the Hugging Face Space “${space}”. It may have been renamed, removed or be down. (${msg})`);
  }
  return new StudioError('PROVIDER_UNAVAILABLE', `Could not connect to the Hugging Face Space “${space}”: ${msg}`);
}

function mapRunError(err) {
  const msg = String(err?.message || err);
  if (/quota/i.test(msg)) return new StudioError('QUOTA_EXCEEDED', `Hugging Face: ${msg}`);
  if (/queue.*full|too many/i.test(msg)) return new StudioError('RATE_LIMITED', `Hugging Face: ${msg}`);
  if (/no gpu|gpu.*(unavailable|not available)|timed? ?out/i.test(msg)) return new StudioError('PROVIDER_UNAVAILABLE', `Hugging Face: ${msg}`);
  if (/nsfw|safety|unsafe/i.test(msg)) return new StudioError('CONTENT_MODERATION', `Hugging Face: ${msg}`);
  if (/connection|network|ECONN|fetch failed/i.test(msg)) return new StudioError('NETWORK', `Lost connection to the Hugging Face Space: ${msg}`);
  return new StudioError('GENERATION_FAILED', `Hugging Face Space error: ${msg}`);
}
