import { VideoProvider } from './VideoProvider.js';
import { StudioError, toStudioError } from '../core/errors.js';

const DEFAULT_BASE = 'https://api.dev.runwayml.com';
const DEFAULT_VERSION = '2024-11-06';
const REQUEST_TIMEOUT_MS = 25_000;

const STATE_MAP = {
  PENDING: 'queued',
  THROTTLED: 'throttled',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runway Developer API provider.
 * Docs: https://docs.dev.runwayml.com/api/
 *   POST   /v1/image_to_video   -> { id, estimatedCost: { credits } }
 *   GET    /v1/tasks/{id}       -> { id, status, progress?, output?, failure?, failureCode?, ... }
 *   DELETE /v1/tasks/{id}       -> cancel (running/pending) or delete (finished)
 *   GET    /v1/organization     -> { creditBalance, tier, usage }
 */
export class RunwayProvider extends VideoProvider {
  constructor({ apiKey, baseUrl, version, fetchImpl } = {}) {
    super();
    this.apiKey = apiKey || '';
    this.baseUrl = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    this.version = version || DEFAULT_VERSION;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
  }

  get id() {
    return 'runway';
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  // ---------------------------------------------------------------- core HTTP

  async #request(method, path, body, { retries = 0 } = {}) {
    if (!this.isConfigured()) {
      throw new StudioError(
        'NOT_CONFIGURED',
        'RUNWAY_API_KEY is not set on the backend. Add it as a server environment variable and redeploy.'
      );
    }

    let attempt = 0;
    // Retries only for statuses Runway documents as safe to retry (429 / 502 / 503).
    for (;;) {
      let res;
      try {
        res = await this.fetch(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'X-Runway-Version': this.version,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            Accept: 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw toStudioError(err);
      }

      if (res.ok) {
        if (res.status === 204) return null;
        const text = await res.text();
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          throw new StudioError('PROVIDER_ERROR', 'Runway returned a response that was not valid JSON.');
        }
      }

      const retryable = [429, 502, 503].includes(res.status);
      if (retryable && attempt < retries) {
        attempt += 1;
        const base = Number(res.headers.get('retry-after')) * 1000 || 800 * 2 ** attempt;
        await sleep(base + Math.random() * base * 0.5); // exponential backoff + jitter
        continue;
      }
      throw await this.#mapHttpError(res);
    }
  }

  async #mapHttpError(res) {
    let payload = null;
    let text = '';
    try {
      text = await res.text();
      payload = JSON.parse(text);
    } catch {
      /* non-JSON body */
    }
    const providerMsg =
      (typeof payload?.error === 'string' && payload.error) ||
      payload?.error?.message ||
      payload?.message ||
      text.slice(0, 300) ||
      res.statusText;
    const details = payload?.issues || payload?.docUrl ? { issues: payload.issues, docUrl: payload.docUrl } : undefined;
    const opts = { providerStatus: res.status, details, retryAfter: res.headers.get('retry-after') || undefined };

    if (/credit/i.test(providerMsg) && /(enough|insufficient|exhaust|out of|balance)/i.test(providerMsg)) {
      return new StudioError('INSUFFICIENT_CREDITS', `Runway: ${providerMsg}`, opts);
    }
    switch (res.status) {
      case 400:
        return new StudioError('INVALID_REQUEST', `Runway rejected the request: ${providerMsg}`, opts);
      case 401:
      case 403:
        return new StudioError('AUTH_FAILED', `Runway rejected the backend API key (${res.status}): ${providerMsg}`, opts);
      case 404:
        return new StudioError('NOT_FOUND', `Runway could not find that task: ${providerMsg}`, opts);
      case 429:
        return new StudioError('RATE_LIMITED', `Runway rate limit reached: ${providerMsg}`, opts);
      case 502:
      case 503:
        return new StudioError('PROVIDER_UNAVAILABLE', `Runway is temporarily unavailable (${res.status}).`, opts);
      case 504:
        return new StudioError('TIMEOUT', 'Runway timed out while handling the request.', opts);
      default:
        return new StudioError('PROVIDER_ERROR', `Runway error ${res.status}: ${providerMsg}`, opts);
    }
  }

  // ---------------------------------------------------------------- contract

  buildRequestBody(job, capabilities) {
    const body = {
      model: job.model,
      promptImage: job.image,
      ratio: job.ratio,
      duration: job.duration,
    };
    if (job.prompt) body.promptText = job.prompt;
    if (Number.isInteger(job.seed) && capabilities.seed) body.seed = job.seed;
    if (capabilities.negativePrompt && job.negativePrompt) body.negativePrompt = job.negativePrompt;
    if (capabilities.audio && typeof job.audio === 'boolean') body.audio = job.audio;
    return body;
  }

  async generate(job, capabilities = {}) {
    const body = this.buildRequestBody(job, capabilities);
    const data = await this.#request('POST', '/v1/image_to_video', body, { retries: 2 });
    if (!data?.id) throw new StudioError('PROVIDER_ERROR', 'Runway did not return a task id.');
    return { taskId: data.id, estimatedCredits: data.estimatedCost?.credits ?? null };
  }

  async getStatus(taskId) {
    const t = await this.#request('GET', `/v1/tasks/${encodeURIComponent(taskId)}`, null, { retries: 2 });
    const state = STATE_MAP[t.status] || 'running';
    return {
      taskId: t.id,
      provider: this.id,
      state,
      raw: t.status,
      progress: typeof t.progress === 'number' ? Math.max(0, Math.min(1, t.progress)) : null,
      outputs: Array.isArray(t.output) ? t.output : [],
      failure: t.failure || null,
      failureCode: t.failureCode || null,
      createdAt: t.createdAt || null,
      credits: {
        ...(t.estimatedCost?.credits != null ? { estimated: t.estimatedCost.credits } : {}),
        ...(t.cost?.credits != null ? { charged: t.cost.credits } : {}),
      },
    };
  }

  async cancel(taskId) {
    await this.#request('DELETE', `/v1/tasks/${encodeURIComponent(taskId)}`);
    return { taskId, cancelled: true };
  }

  async getAccountInfo() {
    const org = await this.#request('GET', '/v1/organization');
    return { creditBalance: org?.creditBalance ?? null, tier: org?.tier ?? null };
  }
}
