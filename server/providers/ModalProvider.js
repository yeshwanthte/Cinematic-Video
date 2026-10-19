import { VideoProvider } from './VideoProvider.js';
import { StudioError, toStudioError } from '../core/errors.js';

/**
 * FREE-CREDIT provider: your own Wan 2.2 deployment on Modal (modal.com), see modal/wan_app.py.
 * Modal's Starter plan includes US$30 of compute per month; with the workspace spend limit set to
 * $0, work stops instead of being billed once those credits are used.
 *
 * Polled like Runway: POST /jobs → id, GET /jobs/{id} → status, GET /jobs/{id}/video → mp4.
 * The endpoint URL and the shared secret live only in server env vars:
 *   MODAL_ENDPOINT_URL   e.g. https://<workspace>--cinematic-studio-wan-api.modal.run
 *   MODAL_API_SECRET     the same value as STUDIO_MODAL_SECRET in the Modal secret "cinematic-studio"
 */
export class ModalProvider extends VideoProvider {
  constructor({ endpoint, secret } = {}) {
    super();
    this.endpoint = String(endpoint || '').replace(/\/+$/, '');
    this.secret = secret || '';
  }

  get id() {
    return 'modal';
  }

  get mode() {
    return 'poll';
  }

  isConfigured() {
    return Boolean(this.endpoint && this.secret);
  }

  #headers(json = false) {
    return { Authorization: `Bearer ${this.secret}`, ...(json ? { 'Content-Type': 'application/json' } : {}) };
  }

  async #request(method, path, body) {
    if (!this.isConfigured()) {
      throw new StudioError('NOT_CONFIGURED', 'MODAL_ENDPOINT_URL and MODAL_API_SECRET are not set on the backend. See README → “Free extra GPU with Modal”.');
    }
    let res;
    try {
      res = await fetch(`${this.endpoint}${path}`, {
        method,
        headers: this.#headers(body !== undefined),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw toStudioError(err);
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const msg = (typeof data?.error === 'string' && data.error) || data?.detail || text.slice(0, 300) || res.statusText;
      if (res.status === 401 || res.status === 403) throw new StudioError('AUTH_FAILED', `Your Modal app rejected MODAL_API_SECRET (${res.status}). It must equal STUDIO_MODAL_SECRET in the Modal secret “cinematic-studio”.`, { providerStatus: res.status });
      if (res.status === 404 && path === '/jobs') throw new StudioError('PROVIDER_UNAVAILABLE', `MODAL_ENDPOINT_URL does not point to the Cinematic Studio Modal app (${this.endpoint}).`, { providerStatus: 404 });
      if (res.status === 404) throw new StudioError('NOT_FOUND', `Modal: ${msg}`, { providerStatus: 404 });
      if (res.status === 400 || res.status === 422) throw new StudioError('INVALID_REQUEST', `Modal rejected the request: ${msg}`, { providerStatus: res.status });
      if (res.status === 429) throw new StudioError('RATE_LIMITED', `Modal: ${msg}`, { providerStatus: 429 });
      if (res.status >= 500) throw new StudioError('PROVIDER_UNAVAILABLE', `Your Modal app returned ${res.status}. It may be (re)deploying or out of credits. ${msg}`, { providerStatus: res.status });
      throw new StudioError('PROVIDER_ERROR', `Modal error ${res.status}: ${msg}`, { providerStatus: res.status });
    }
    return data;
  }

  buildRequestBody(job, caps = {}) {
    const res = caps.ratios?.find((r) => r.value === job.ratio)?.resolution;
    return {
      image: job.image,
      last_image: job.lastImage || null,
      prompt: job.prompt,
      negative_prompt: caps.negativePrompt ? job.negativePrompt || '' : '',
      duration: job.duration,
      steps: job.steps ?? 4,
      seed: Number.isInteger(job.seed) ? job.seed : null,
      max_dim: res === '720p' ? 1280 : 832,
    };
  }

  async generate(job, caps = {}) {
    const data = await this.#request('POST', '/jobs', this.buildRequestBody(job, caps));
    if (!data?.id) throw new StudioError('PROVIDER_ERROR', 'Your Modal app did not return a job id.');
    return { taskId: data.id, estimatedCredits: null };
  }

  async getStatus(taskId) {
    const s = await this.#request('GET', `/jobs/${encodeURIComponent(taskId)}`);
    const state = ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(s?.status) ? s.status : 'running';
    let failure = s?.error || null;
    if (failure && /credit|billing|spend limit|payment|usage limit/i.test(failure)) failure = `Your Modal credits for this month are used up (or the spend limit stopped the job): ${failure}`;
    return {
      taskId,
      provider: this.id,
      state,
      raw: s?.status || 'unknown',
      progress: typeof s?.progress === 'number' ? Math.max(0, Math.min(1, s.progress)) : null,
      step: s?.step ?? null,
      steps: s?.steps ?? null,
      note: s?.note || null,
      seed: s?.seed ?? null,
      outputs: state === 'succeeded' ? [this.videoUrl(taskId)] : [],
      failure,
      failureCode: state === 'failed' ? 'MODAL_JOB_FAILED' : null,
      createdAt: null,
      credits: null,
    };
  }

  videoUrl(taskId) {
    return `${this.endpoint}/jobs/${encodeURIComponent(taskId)}/video`;
  }

  /** The video URL is private (needs the secret): the backend download route adds this header. */
  fileHeaders() {
    return this.#headers();
  }

  async cancel(taskId) {
    await this.#request('DELETE', `/jobs/${encodeURIComponent(taskId)}`);
    return { taskId, cancelled: true };
  }

  async getAccountInfo() {
    const h = await this.#request('GET', '/health');
    return { gpu: h?.gpu || null, model: h?.model || null, quotaNote: 'Modal Starter: US$30 compute credits / month' };
  }
}
