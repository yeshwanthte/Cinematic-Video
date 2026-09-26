// Optional AI assistant (photo analysis + prompt enhancement).
//  • ANTHROPIC_API_KEY set            → Anthropic Claude (paid)
//  • else HF_TOKEN set (free default) → Hugging Face Inference Providers router
//    (OpenAI-compatible; free accounts get small monthly credits). Disable with HF_ASSISTANT=off.
// Without either, the frontend uses its built-in on-device analysis and prompt
// engine, and clearly labels that it did so. Any assistant failure falls back to it.

import { StudioError, toStudioError } from './errors.js';

const API = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5';

const HF_ROUTER = 'https://router.huggingface.co/v1/chat/completions';

export function assistantConfigured(env) {
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.HF_TOKEN && String(env.HF_ASSISTANT || 'on').toLowerCase() !== 'off') return 'huggingface';
  return '';
}

// Models that the Hugging Face router actually serves change over time, so each task
// has a fallback chain (checked against router.huggingface.co/v1/models, 2026-09-26).
// Set HF_VISION_MODEL / HF_TEXT_MODEL to put your own choice first.
const HF_VISION_MODELS = ['Qwen/Qwen3-VL-30B-A3B-Instruct', 'google/gemma-3-12b-it', 'zai-org/GLM-4.5V'];
const HF_TEXT_MODELS = ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'google/gemma-3-12b-it'];
const lastGood = { vision: null, text: null }; // remembered per warm function instance

function hfCandidates(env, vision) {
  const own = vision ? env.HF_VISION_MODEL : env.HF_TEXT_MODEL;
  const list = vision ? HF_VISION_MODELS : HF_TEXT_MODELS;
  const good = lastGood[vision ? 'vision' : 'text'];
  return [...new Set([own, good, ...list].filter(Boolean))];
}

function assistantModel(env, vision) {
  if (assistantConfigured(env) === 'anthropic') return env.ASSISTANT_MODEL || DEFAULT_MODEL;
  return lastGood[vision ? 'vision' : 'text'] || hfCandidates(env, vision)[0];
}

async function callHFModel(env, model, { system, parts, vision, maxTokens }) {
  let res;
  try {
    res = await fetch(env.HF_ROUTER_URL || HF_ROUTER, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.HF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: vision ? parts : parts.map((p) => p.text).join('\n') },
        ],
      }),
      signal: AbortSignal.timeout(40_000),
    });
  } catch (err) {
    throw toStudioError(err);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || res.statusText;
    const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
    const code = res.status === 402 ? 'QUOTA_EXCEEDED' : res.status === 429 ? 'RATE_LIMITED' : res.status === 401 ? 'AUTH_FAILED' : res.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR';
    const e = new StudioError(code, `Hugging Face assistant error (${res.status}): ${text}`, { providerStatus: res.status });
    // "model not supported / not found" → try the next model in the chain
    e.tryNext = (res.status === 400 || res.status === 404 || res.status >= 500) && !/credit|quota|balance/i.test(text);
    throw e;
  }
  return String(data?.choices?.[0]?.message?.content || '').trim();
}

async function callHF(env, { system, content, maxTokens }) {
  const vision = content.some((b) => b.type === 'image');
  const parts = content.map((b) =>
    b.type === 'image' ? { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } } : { type: 'text', text: b.text }
  );
  let lastErr;
  for (const model of hfCandidates(env, vision)) {
    try {
      const out = await callHFModel(env, model, { system, parts, vision, maxTokens });
      if (!out) throw Object.assign(new StudioError('PROVIDER_ERROR', `${model} returned an empty answer.`), { tryNext: true });
      lastGood[vision ? 'vision' : 'text'] = model;
      return out;
    } catch (err) {
      lastErr = err;
      if (!err.tryNext) throw err;
    }
  }
  throw lastErr;
}

async function callClaude(env, opts) {
  if (assistantConfigured(env) === 'huggingface') return callHF(env, { maxTokens: 700, ...opts });
  const { system, content, maxTokens = 700 } = opts;
  if (!assistantConfigured(env)) {
    throw new StudioError('NOT_CONFIGURED', 'No AI assistant configured (set HF_TOKEN or ANTHROPIC_API_KEY).');
  }
  let res;
  try {
    res = await fetch(env.ANTHROPIC_API_BASE || API, {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.ASSISTANT_MODEL || DEFAULT_MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw toStudioError(err);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    const code = res.status === 429 ? 'RATE_LIMITED' : res.status === 401 ? 'AUTH_FAILED' : res.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR';
    throw new StudioError(code, `AI assistant error (${res.status}): ${msg}`, { providerStatus: res.status });
  }
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new StudioError('PROVIDER_ERROR', 'AI assistant did not return JSON.');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new StudioError('PROVIDER_ERROR', 'AI assistant returned malformed JSON.');
  }
}

const CATEGORIES = ['portrait', 'group', 'wedding', 'landscape', 'nature', 'architecture', 'interior', 'exterior', 'vehicle', 'product', 'travel', 'other'];

export async function analyzeImage(env, image) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(image || '');
  if (!m) throw new StudioError('INVALID_IMAGE', 'Analysis needs a JPG, PNG or WEBP data URI.');
  if (image.length > 1_500_000) throw new StudioError('IMAGE_TOO_LARGE', 'Send a downscaled preview (≤1.5 MB) for analysis.');

  const system = `You analyse a single photograph to plan an image-to-video animation. Reply with ONLY a JSON object:
{
 "category": one of ${JSON.stringify(CATEGORIES)},
 "secondary": optional second category or null,
 "summary": "max 14 words describing the shot type (not every detail)",
 "people": integer count of clearly visible people,
 "faceVisible": boolean,
 "hasSky": boolean, "hasWater": boolean, "hasFoliage": boolean, "hasHair": boolean, "hasFabric": boolean,
 "camera": one of ["push_in","pull_out","pan_left","pan_right","tilt_up","tilt_down","orbit","dolly","tracking","crane_up","parallax","handheld","static"],
 "subject": array (0-3) from ["natural","hair","clothing","blink","head","walking","turning","looking","smile","interaction"],
 "environment": array (0-3) from ["wind","clouds","rain","fog","smoke","water","trees","sunlight","dust","ambient"],
 "style": one of ["cinematic","luxury","travel","wedding","realestate","portrait","fashion","documentary","dramatic","dreamy"],
 "intensity": one of ["subtle","balanced","dynamic"],
 "avoid": array of short reasons why specific motions would look wrong for this photo
}
Only recommend subject motions that physically make sense (no blinking without a visible face, no hair motion without visible hair, no water motion without water).`;

  const text = await callClaude(env, {
    system,
    content: [
      { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
      { type: 'text', text: 'Analyse this photo and return the JSON.' },
    ],
  });
  const json = extractJson(text);
  if (!CATEGORIES.includes(json.category)) json.category = 'other';
  return { ...json, source: 'ai', assistant: assistantConfigured(env), model: assistantModel(env, true) };
}

export async function enhancePrompt(env, { text, context, maxChars = 1000 }) {
  const system = `You are a senior prompt engineer for image-to-video models (Runway Gen-4.5, Veo).
Rewrite the user's idea into ONE professional motion prompt. Rules:
- The image already defines what is visible. Describe MOTION only: subject action, environmental motion, camera motion, intensity, direction, speed and timing.
- Do not re-describe objects, colours, clothing or scenery already in the image.
- Use positive phrasing (say what should happen, e.g. "facial features remain stable"), never "no X" or "don't".
- Keep the subject's identity and the composition consistent. Physically plausible, smooth, restrained motion.
- Respect the selected controls in the context JSON; drop any motion that contradicts the photo analysis.
- Plain prose, 2–5 sentences, no lists, no quotes, under ${maxChars} characters.
Reply with the prompt text only.`;
  const out = await callClaude(env, {
    system,
    content: [{ type: 'text', text: `User idea: ${text || '(none — build from controls)'}\nContext: ${JSON.stringify(context || {})}` }],
    maxTokens: 500,
  });
  const prompt = out.replace(/^["'\s]+|["'\s]+$/g, '').slice(0, maxChars);
  if (!prompt) throw new StudioError('PROVIDER_ERROR', 'AI assistant returned an empty prompt.');
  return { prompt, source: 'ai', assistant: assistantConfigured(env), model: assistantModel(env, false) };
}
