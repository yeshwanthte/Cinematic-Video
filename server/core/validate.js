import MODELS from '../models.js';
import { StudioError } from './errors.js';

const DATA_URI_RE = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

export function getCapabilities(providerId, modelId) {
  const provider = MODELS.providers[providerId];
  if (!provider) throw new StudioError('INVALID_REQUEST', `Unknown provider "${providerId}".`);
  const model = provider.models[modelId];
  if (!model) throw new StudioError('UNSUPPORTED_OPTION', `Model "${modelId}" is not available for ${provider.label}.`);
  return model;
}

function checkMagicBytes(mime, b64) {
  // atob works in Node 18+, Vercel, Cloudflare Workers and Deno (no Buffer dependency).
  let s;
  try {
    s = atob(b64.slice(0, 24));
  } catch {
    return false;
  }
  const b = (i) => s.charCodeAt(i);
  const isJpeg = b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff;
  const isPng = b(0) === 0x89 && s.slice(1, 4) === 'PNG' && b(4) === 0x0d && b(5) === 0x0a;
  const isWebp = s.slice(0, 4) === 'RIFF' && s.slice(8, 12) === 'WEBP';
  if (mime.includes('jp') && isJpeg) return true;
  if (mime.includes('png') && isPng) return true;
  if (mime.includes('webp') && isWebp) return true;
  return false;
}

export function validateImage(image) {
  if (typeof image !== 'string' || !image) {
    throw new StudioError('INVALID_IMAGE', 'No image was provided.');
  }
  if (/^https:\/\//i.test(image)) return; // provider fetches it (Runway limit: 16MB)
  if (!image.startsWith('data:')) {
    throw new StudioError('INVALID_IMAGE', 'Image must be a base64 data URI or an https URL.');
  }
  const m = image.match(DATA_URI_RE);
  if (!m) {
    const mime = image.slice(5, image.indexOf(';'));
    throw new StudioError('UNSUPPORTED_FORMAT', `Unsupported image format "${mime || 'unknown'}". Use JPG, PNG or WEBP.`);
  }
  if (image.length > MODELS.limits.maxImageDataUriBytes) {
    throw new StudioError(
      'IMAGE_TOO_LARGE',
      `Encoded image is ${(image.length / 1e6).toFixed(1)} MB; the limit is ${(MODELS.limits.maxImageDataUriBytes / 1e6).toFixed(1)} MB.`
    );
  }
  if (!checkMagicBytes(m[1], m[2])) {
    throw new StudioError('INVALID_IMAGE', 'The file content does not match its declared image type (corrupt or renamed file).');
  }
}

export function validateJob(body) {
  if (!body || typeof body !== 'object') throw new StudioError('INVALID_REQUEST', 'Request body must be JSON.');
  const providerId = body.provider || MODELS.defaultProvider;
  const modelId = body.model || MODELS.defaultModel;
  const caps = getCapabilities(providerId, modelId);

  validateImage(body.image);

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (caps.promptRequired && !prompt) throw new StudioError('INVALID_REQUEST', `${caps.label} requires a motion prompt.`);
  if (prompt.length > caps.promptMaxChars) {
    throw new StudioError('PROMPT_TOO_LONG', `Prompt is ${prompt.length} characters; ${caps.label} accepts up to ${caps.promptMaxChars}.`);
  }

  const duration = Number(body.duration);
  const d = caps.durations;
  const durationOk = Number.isInteger(duration) && (d.exact ? d.exact.includes(duration) : duration >= d.min && duration <= d.max);
  if (!durationOk) {
    const allowed = d.exact ? d.exact.join(', ') : `${d.min}–${d.max}`;
    throw new StudioError('UNSUPPORTED_OPTION', `${caps.label} supports durations of ${allowed} seconds, not "${body.duration}".`);
  }

  const ratio = String(body.ratio || '');
  if (!caps.ratios.some((r) => r.value === ratio)) {
    throw new StudioError('UNSUPPORTED_OPTION', `${caps.label} does not support output ratio "${ratio}".`);
  }

  let seed;
  if (body.seed !== undefined && body.seed !== null && body.seed !== '') {
    seed = Number(body.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
      throw new StudioError('INVALID_REQUEST', 'Seed must be an integer between 0 and 4294967295.');
    }
  }

  const negativePrompt = typeof body.negativePrompt === 'string' ? body.negativePrompt.trim().slice(0, 1000) : '';

  return {
    providerId,
    caps,
    job: {
      model: modelId,
      image: body.image,
      prompt,
      negativePrompt: caps.negativePrompt ? negativePrompt : '',
      duration,
      ratio,
      seed,
      audio: caps.audio ? Boolean(body.audio) : undefined,
    },
  };
}

export function getImageCapabilities(providerId, modelId) {
  const provider = MODELS.imageProviders?.[providerId];
  if (!provider) throw new StudioError('INVALID_REQUEST', `Unknown image provider "${providerId}".`);
  const model = provider.models[modelId];
  if (!model) throw new StudioError('UNSUPPORTED_OPTION', `Image model "${modelId}" is not available.`);
  return model;
}

export function validateImageJob(body) {
  if (!body || typeof body !== 'object') throw new StudioError('INVALID_REQUEST', 'Request body must be JSON.');
  const providerId = body.provider || 'huggingface';
  const modelId = body.model || 'qwen-edit-fast';
  const caps = getImageCapabilities(providerId, modelId);
  const mode = body.mode === 'create' ? 'create' : 'edit';
  if (!caps.modes.includes(mode)) {
    throw new StudioError('UNSUPPORTED_OPTION', `${caps.label} does not support ${mode === 'edit' ? 'editing an uploaded photo' : 'creating from text only'}.`);
  }
  const images = Array.isArray(body.images) ? body.images : [];
  if (mode === 'edit' && !images.length) throw new StudioError('INVALID_IMAGE', 'Upload the photo you want to edit.');
  if (images.length > (caps.maxImages || 0)) throw new StudioError('UNSUPPORTED_OPTION', `${caps.label} accepts up to ${caps.maxImages} image(s).`);
  let total = 0;
  for (const img of images) {
    validateImage(img);
    total += img.length;
  }
  if (total > MODELS.limits.maxImageDataUriBytes) throw new StudioError('IMAGE_TOO_LARGE', 'The reference images are too large together. Use fewer or smaller photos.');
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new StudioError('INVALID_REQUEST', 'Describe what you want to change or create.');
  if (prompt.length > (caps.promptMaxChars || 1000)) throw new StudioError('PROMPT_TOO_LONG', `Prompt is ${prompt.length} characters; the limit is ${caps.promptMaxChars}.`);
  let seed;
  if (body.seed !== undefined && body.seed !== null && body.seed !== '') {
    seed = Number(body.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647) throw new StudioError('INVALID_REQUEST', 'Seed must be an integer between 0 and 2147483647.');
  }
  let width;
  let height;
  if (mode === 'create' && caps.sizes) {
    const size = caps.sizes.find((z) => z.aspect === body.aspect) || caps.sizes[0];
    ({ width, height } = size);
  }
  return { providerId, caps, job: { model: modelId, mode, images: mode === 'edit' ? images : [], prompt, seed, width, height } };
}
