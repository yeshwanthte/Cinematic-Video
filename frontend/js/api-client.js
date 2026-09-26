// Talks ONLY to your own backend. No provider secrets ever exist in the browser.

export class ApiError extends Error {
  constructor({ code = 'INTERNAL', message = 'Unexpected error', status = 0, retryable = false, details, providerStatus } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
    this.providerStatus = providerStatus;
  }
}

export class StudioApi {
  constructor(getSettings) {
    this.getSettings = getSettings;
  }

  get base() {
    const b = (this.getSettings().apiBase || '').trim().replace(/\/+$/, '');
    return b;
  }

  url(path) {
    return `${this.base}/api/${path}`;
  }

  async #call(path, { method = 'GET', body, timeoutMs = 45_000, raw = false, signal, onEvent } = {}) {
    const headers = {};
    const code = this.getSettings().accessCode;
    if (code) headers['X-Studio-Access'] = code;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(this.url(path), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        mode: 'cors',
      });
    } catch (err) {
      if (signal?.aborted) throw new ApiError({ code: 'CANCELLED', message: 'Generation cancelled.' });
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new ApiError({ code: 'TIMEOUT', message: `Your backend did not respond within ${Math.round(timeoutMs / 1000)}s.`, retryable: true });
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new ApiError({ code: 'NETWORK', message: 'You appear to be offline. Check your internet connection.', retryable: true });
      }
      throw new ApiError({
        code: 'NETWORK',
        message: `Could not reach your backend at ${this.base || window.location.origin}. Check the API endpoint in Settings, that the backend is deployed, and that ALLOWED_ORIGINS includes ${window.location.origin}.`,
        retryable: true,
      });
    }
    if (raw && res.ok) return res;
    if (res.ok && onEvent && (res.headers.get('content-type') || '').includes('ndjson')) return this.#readStream(res, onEvent, signal, timeoutMs);
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not json */
    }
    if (!res.ok) {
      const e = data?.error || {};
      throw new ApiError({
        code: e.code || (res.status === 404 ? 'NOT_FOUND' : 'PROVIDER_ERROR'),
        message: e.message || `Backend returned HTTP ${res.status}${text && !data ? `: ${text.slice(0, 160)}` : ''}`,
        status: res.status,
        retryable: e.retryable ?? res.status >= 500,
        details: e.details,
        providerStatus: e.providerStatus,
      });
    }
    if (data === null) throw new ApiError({ code: 'PROVIDER_ERROR', message: 'Backend returned an empty or non-JSON response.', status: res.status });
    return data;
  }

  // Reads an NDJSON event stream (streamed providers such as Hugging Face Spaces).
  async #readStream(res, onEvent, signal, timeoutMs) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let final = null;
    const chunks = [];
    try {
      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (signal?.aborted) throw new ApiError({ code: 'CANCELLED', message: 'Generation cancelled.' });
          if (err.name === 'TimeoutError') throw new ApiError({ code: 'TIMEOUT', message: `No result after ${Math.round(timeoutMs / 60000)} minutes.`, retryable: true });
          throw new ApiError({ code: 'NETWORK', message: `The connection to your backend dropped during generation (${err.message}). Free Space jobs stop when the connection closes — generate again.`, retryable: true });
        }
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === 'error') throw new ApiError({ ...(ev.error || {}), code: ev.error?.code || 'PROVIDER_ERROR' });
          if (ev.type === 'file_chunk') {
            chunks.push(ev.data);
            continue;
          }
          if (ev.type === 'completed') final = ev;
          if (ev.type !== 'heartbeat') onEvent(ev);
        }
      }
    } finally {
      reader.releaseLock?.();
    }
    if (!final) {
      throw new ApiError({
        code: 'NETWORK',
        message: 'The backend closed the stream before the video was ready. On Vercel this usually means the function hit its time limit (queue + generation over 5 minutes). Try again, ideally with a shorter clip.',
        retryable: true,
      });
    }
    let blob = null;
    if (final.inline && chunks.length) {
      const parts = chunks.map((c) => {
        const bin = atob(c);
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        return u;
      });
      blob = new Blob(parts, { type: final.inline.mime || 'video/mp4' });
    }
    return { stream: true, ...final, blob };
  }

  health({ account = false } = {}) {
    return this.#call(`health${account ? '?account=1' : ''}`, { timeoutMs: 15_000 });
  }
  models() {
    return this.#call('models', { timeoutMs: 15_000 });
  }
  /** Runway: returns { taskId, … } for polling. Streamed providers: calls onEvent live and returns the final event. */
  generate(job, { onEvent, signal, timeoutMs = 90_000 } = {}) {
    return this.#call('generate', { method: 'POST', body: job, timeoutMs, onEvent, signal });
  }
  status(provider, taskId) {
    return this.#call(`status?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(taskId)}`, { timeoutMs: 30_000 });
  }
  cancel(provider, taskId) {
    return this.#call('cancel', { method: 'POST', body: { provider, taskId } });
  }
  analyze(image) {
    return this.#call('analyze', { method: 'POST', body: { image }, timeoutMs: 45_000 });
  }
  enhance(payload) {
    return this.#call('enhance', { method: 'POST', body: payload, timeoutMs: 45_000 });
  }
  async downloadBlob(provider, taskId, name, url) {
    const q = url ? `url=${encodeURIComponent(url)}` : `id=${encodeURIComponent(taskId)}`;
    const res = await this.#call(`download?provider=${encodeURIComponent(provider)}&${q}&name=${encodeURIComponent(name)}`, {
      raw: true,
      timeoutMs: 120_000,
    });
    return res.blob();
  }
}

/** Human-readable titles for error codes; the real provider message is always shown beneath. */
export const ERROR_TITLES = {
  INVALID_REQUEST: 'The request was rejected.',
  INVALID_IMAGE: 'This image could not be used.',
  UNSUPPORTED_FORMAT: 'Unsupported image format.',
  IMAGE_TOO_LARGE: 'Your image is too large.',
  PROMPT_TOO_LONG: 'Your prompt is too long.',
  UNSUPPORTED_OPTION: 'That setting is not supported by this model.',
  FORBIDDEN: 'Access code required or incorrect.',
  NOT_CONFIGURED: 'The backend is not configured yet.',
  AUTH_FAILED: 'The AI provider rejected the backend API key.',
  INSUFFICIENT_CREDITS: 'Your API credits may be exhausted.',
  RATE_LIMITED: 'Rate limit reached. Please wait a moment and try again.',
  QUOTA_EXCEEDED: 'Your free daily GPU allowance is used up.',
  PROVIDER_UNAVAILABLE: 'AI provider is currently unavailable.',
  PROVIDER_ERROR: 'Generation failed. The AI provider returned an error.',
  CONTENT_MODERATION: 'The provider’s content moderation blocked this generation.',
  GENERATION_FAILED: 'Generation failed. The AI provider returned an error.',
  NOT_FOUND: 'Task not found.',
  TIMEOUT: 'Generation timed out. Please try again.',
  NETWORK: 'Network problem — could not reach your backend.',
  NOT_IMPLEMENTED: 'Not implemented yet.',
  CANCELLED: 'Generation cancelled.',
  INTERNAL: 'Unexpected server error.',
};
