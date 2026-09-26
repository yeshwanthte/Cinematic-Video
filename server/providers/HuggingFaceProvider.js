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
    if (!this.isConfigured()) {
      throw new StudioError('NOT_CONFIGURED', 'HF_TOKEN is not set on the backend. Create a free token at huggingface.co/settings/tokens and add it as an environment variable.');
    }
    const space = this.spaceFor(caps, job.model);
    let client;
    try {
      client = await Client.connect(space, this.#connectOptions());
    } catch (err) {
      throw mapConnectError(err, space);
    }

    const image = dataUriToBlob(job.image);
    const params = {
      [caps.params?.image || 'input_image']: image,
      prompt: job.prompt,
      steps: caps.params?.steps ?? 4,
      negative_prompt: [caps.params?.baseNegative, job.negativePrompt].filter(Boolean).join(', '),
      duration_seconds: job.duration,
      seed: Number.isInteger(job.seed) ? job.seed : 42,
      randomize_seed: !Number.isInteger(job.seed),
    };

    let submission;
    try {
      submission = client.submit(caps.endpoint || '/generate_video', params);
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
            const p = msg.progress_data?.find((d) => d.length);
            if (p) {
              yield { type: 'progress', progress: Math.min(1, (p.index ?? 0) / p.length), step: p.index, steps: p.length, desc: p.desc || p.unit || 'steps' };
            }
          } else if (msg.stage === 'pending' && msg.position != null) {
            yield { type: 'queued', position: msg.position, size: msg.size ?? null, eta: msg.eta ?? null };
          }
        } else if (msg.type === 'data') {
          const url = findVideoUrl(msg.data);
          if (!url) throw new StudioError('PROVIDER_ERROR', 'The Space finished but returned no video file.');
          const seed = msg.data.find((v) => typeof v === 'number');
          yield { type: 'completed', outputs: [url], seed: seed ?? null };
          return;
        }
      }
      throw new StudioError('PROVIDER_ERROR', 'The Space closed the connection before returning a video.');
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

function dataUriToBlob(dataUri) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUri || '');
  if (!m) throw new StudioError('INVALID_IMAGE', 'Image must be a base64 data URI for Hugging Face Spaces.');
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
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
