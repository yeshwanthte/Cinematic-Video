// Framework-agnostic request handler: (Request, env, route) -> Response.
// Used by Vercel functions (/api/*.js), the Cloudflare Worker adapter and dev-server.js.

import MODELS from '../models.js';
import { StudioError, toStudioError } from './errors.js';
import { validateJob, getCapabilities } from './validate.js';
import { getProvider, listProviderIds } from '../providers/index.js';
import { assistantConfigured, analyzeImage, enhancePrompt } from './assistant.js';

const MAX_BODY_BYTES = 4_400_000; // stays under Vercel's 4.5 MB request limit

// ------------------------------------------------------------------ helpers

function allowedOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const list = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*')) return origin;
  if (list.includes(origin)) return origin;
  // Same-origin deployments (frontend + API on one Vercel project) and local dev.
  const self = new URL(request.url).origin;
  if (origin === self) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) && env.NODE_ENV !== 'production') return origin;
  return null;
}

function corsHeaders(request, env) {
  const origin = allowedOrigin(request, env);
  const h = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Studio-Access',
    'Access-Control-Max-Age': '600',
  };
  if (origin) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(request, env, status, data, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(request, env), ...extra },
  });
}

function errorResponse(request, env, err) {
  const e = toStudioError(err);
  if (e.code === 'INTERNAL') console.error('[studio] internal error', err);
  return json(request, env, e.status, e.toJSON(), e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {});
}

async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY_BYTES) {
    throw new StudioError('IMAGE_TOO_LARGE', `Request is ${(len / 1e6).toFixed(1)} MB; the backend accepts up to ${(MAX_BODY_BYTES / 1e6).toFixed(1)} MB.`);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new StudioError('IMAGE_TOO_LARGE', 'Request body is too large.');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new StudioError('INVALID_REQUEST', 'Request body is not valid JSON.');
  }
}

function requireAccess(request, env) {
  const code = env.STUDIO_ACCESS_CODE;
  if (!code) return;
  const given = request.headers.get('x-studio-access') || '';
  // constant-time-ish comparison
  let diff = given.length ^ code.length;
  for (let i = 0; i < Math.max(given.length, code.length); i++) diff |= (given.charCodeAt(i) || 0) ^ (code.charCodeAt(i) || 0);
  if (diff !== 0) throw new StudioError('FORBIDDEN', 'This studio requires an access code. Add it under Settings → Backend.');
}

function taskIdFrom(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(id)) throw new StudioError('INVALID_REQUEST', 'Invalid task id.');
  return id;
}

// Streams provider events as NDJSON (one JSON object per line). Closing the
// connection (browser cancel / tab closed) aborts the upstream job.
function streamGeneration(request, env, provider, providerId, caps, job) {
  const enc = new TextEncoder();
  const abort = new AbortController();
  request.signal?.addEventListener?.('abort', () => abort.abort(), { once: true });
  let heartbeat;
  const body = new ReadableStream({
    async start(controller) {
      const send = (obj) => {
        try {
          controller.enqueue(enc.encode(JSON.stringify(obj) + '\n'));
        } catch {
          abort.abort();
        }
      };
      send({ type: 'submitted', provider: providerId, model: job.model, submittedAt: new Date().toISOString() });
      heartbeat = setInterval(() => send({ type: 'heartbeat', t: Date.now() }), 10_000);
      try {
        for await (const ev of provider.generateStream(job, caps, { signal: abort.signal })) send(ev);
      } catch (err) {
        const e = toStudioError(err);
        if (e.code === 'INTERNAL') console.error('[studio] stream error', err);
        if (!abort.signal.aborted) send({ type: 'error', ...e.toJSON() });
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      clearInterval(heartbeat);
      abort.abort();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(request, env),
    },
  });
}

// ------------------------------------------------------------------ routes

const routes = {
  async health(request, env) {
    const providers = {};
    for (const id of listProviderIds()) {
      const p = getProvider(id, env);
      const entry = { configured: p.isConfigured(), label: MODELS.providers[id]?.label || id };
      if (entry.configured && new URL(request.url).searchParams.get('account') === '1') {
        try {
          requireAccess(request, env);
          entry.account = await p.getAccountInfo();
        } catch (e) {
          entry.accountError = toStudioError(e).toJSON().error;
        }
      }
      providers[id] = entry;
    }
    return json(request, env, 200, {
      ok: true,
      service: 'cinematic-ai-studio',
      providers,
      assistant: Boolean(assistantConfigured(env)),
      assistantProvider: assistantConfigured(env) || null,
      accessCodeRequired: Boolean(env.STUDIO_ACCESS_CODE),
      time: new Date().toISOString(),
    });
  },

  async models(request, env) {
    const out = { defaultProvider: MODELS.defaultProvider, defaultModel: MODELS.defaultModel, limits: MODELS.limits, providers: {} };
    for (const [id, p] of Object.entries(MODELS.providers)) {
      out.providers[id] = { ...p, configured: getProvider(id, env).isConfigured() };
    }
    return json(request, env, 200, out, { 'Cache-Control': 'public, max-age=300' });
  },

  async generate(request, env) {
    if (request.method !== 'POST') throw new StudioError('INVALID_REQUEST', 'Use POST.');
    requireAccess(request, env);
    const body = await readJson(request);
    const { providerId, caps, job } = validateJob(body);
    const provider = getProvider(providerId, env);
    if (provider.mode === 'stream') return streamGeneration(request, env, provider, providerId, caps, job);
    const { taskId, estimatedCredits } = await provider.generate(job, caps);
    return json(request, env, 202, {
      taskId,
      provider: providerId,
      model: job.model,
      estimatedCredits,
      pollIntervalMs: MODELS.providers[providerId].pollIntervalMs,
      submittedAt: new Date().toISOString(),
    });
  },

  async status(request, env) {
    requireAccess(request, env);
    const url = new URL(request.url);
    const provider = getProvider(url.searchParams.get('provider') || MODELS.defaultProvider, env);
    const status = await provider.getStatus(taskIdFrom(url.searchParams.get('id')));
    return json(request, env, 200, status);
  },

  async cancel(request, env) {
    if (request.method !== 'POST') throw new StudioError('INVALID_REQUEST', 'Use POST.');
    requireAccess(request, env);
    const body = await readJson(request);
    const provider = getProvider(body.provider || MODELS.defaultProvider, env);
    return json(request, env, 200, await provider.cancel(taskIdFrom(body.taskId)));
  },

  // Streams the finished video through the backend with a download filename.
  // Output URLs come from the provider's own task record (never from the client) — no SSRF.
  async download(request, env) {
    requireAccess(request, env);
    const url = new URL(request.url);
    const providerId = url.searchParams.get('provider') || MODELS.defaultProvider;
    const provider = getProvider(providerId, env);
    let videoUrl;
    let headers = {};
    if (provider.mode === 'stream') {
      // Streamed providers hand the browser a file URL; only Space-hosted files are proxied.
      videoUrl = url.searchParams.get('url') || '';
      if (!provider.isAllowedFileUrl(videoUrl)) throw new StudioError('FORBIDDEN', 'Only video files served by Hugging Face Spaces can be downloaded through this proxy.');
      headers = provider.fileHeaders(videoUrl);
    } else {
      ({ videoUrl } = await provider.getResult(taskIdFrom(url.searchParams.get('id'))));
    }
    // Busy Spaces run several replicas behind one URL; the finished file exists only on the
    // replica that generated it, and the others answer 403/404. Retrying lets the load
    // balancer route us to the right replica (usually within a few attempts).
    const attempts = provider.mode === 'stream' ? 20 : 1;
    let upstream;
    let lastStatus = 0;
    for (let i = 0; i < attempts; i++) {
      upstream = await fetch(videoUrl, { headers, cache: 'no-store' }).catch((e) => {
        if (i === attempts - 1) throw new StudioError('NETWORK', `Could not fetch the video file: ${e.message}`);
        return null;
      });
      if (upstream?.ok && upstream.body) break;
      lastStatus = upstream?.status || 0;
      try {
        await upstream?.body?.cancel();
      } catch {
        /* ignore */
      }
      upstream = null;
      if (![403, 404, 429, 500, 502, 503, 504, 0].includes(lastStatus)) break;
      await new Promise((r) => setTimeout(r, 400 + i * 150));
    }
    if (!upstream) {
      throw new StudioError(
        'PROVIDER_ERROR',
        `The Space finished the video but kept refusing the file download (HTTP ${lastStatus} after ${attempts} tries). This happens when a busy Space runs several copies and the file lives on another copy, or the Space already deleted it. Click “Try again” to regenerate.`
      );
    }
    const name = (url.searchParams.get('name') || 'cinematic-ai-studio').replace(/[^\w.-]+/g, '-').slice(0, 80);
    const type = upstream.headers.get('content-type') || 'video/mp4';
    const ext = /webm/.test(type) ? 'webm' : 'mp4';
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': type,
        ...(upstream.headers.get('content-length') ? { 'Content-Length': upstream.headers.get('content-length') } : {}),
        'Content-Disposition': `attachment; filename="${name}.${ext}"`,
        'Cache-Control': 'private, no-store',
        ...corsHeaders(request, env),
      },
    });
  },

  async analyze(request, env) {
    if (request.method !== 'POST') throw new StudioError('INVALID_REQUEST', 'Use POST.');
    requireAccess(request, env);
    const body = await readJson(request);
    return json(request, env, 200, await analyzeImage(env, body.image));
  },

  async enhance(request, env) {
    if (request.method !== 'POST') throw new StudioError('INVALID_REQUEST', 'Use POST.');
    requireAccess(request, env);
    const body = await readJson(request);
    let maxChars = 1000;
    try {
      maxChars = getCapabilities(body.provider || MODELS.defaultProvider, body.model || MODELS.defaultModel).promptMaxChars;
    } catch {
      /* default */
    }
    return json(request, env, 200, await enhancePrompt(env, { text: String(body.text || '').slice(0, 2000), context: body.context, maxChars }));
  },

  // Story Mode final render (clip stitching) is intentionally NOT implemented yet.
  async render(request, env) {
    throw new StudioError('NOT_IMPLEMENTED', 'Story rendering (stitching scenes into one video) is not implemented yet. Download each scene clip individually.');
  },
};

export async function handle(request, env = {}, route) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  const fn = routes[route];
  if (!fn) return errorResponse(request, env, new StudioError('NOT_FOUND', `Unknown endpoint "${route}".`));
  // Reject browser calls from origins that are not allowed (defence in depth; CORS alone only hides responses).
  if (request.headers.get('origin') && !allowedOrigin(request, env)) {
    return json(request, env, 403, new StudioError('FORBIDDEN', 'This origin is not allowed. Add it to ALLOWED_ORIGINS on the backend.').toJSON());
  }
  try {
    return await fn(request, env);
  } catch (err) {
    return errorResponse(request, env, err);
  }
}

export const ROUTES = Object.keys(routes);
