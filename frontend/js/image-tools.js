// Image intake + preparation. Decodes once, crops to the chosen output ratio,
// encodes once per (image, ratio, focus) and caches the result — so variations and
// retries never re-encode a large photo.

export const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
const EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
export const MAX_FILE_BYTES = 40 * 1024 * 1024; // raw upload guard
export const MIN_SIDE = 320;

export class ImageError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function mimeOf(file) {
  if (ACCEPTED.includes(file.type)) return file.type;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return EXT[ext] || file.type || 'unknown';
}

async function sniff(file) {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

/** Validates and decodes a File. Returns { bitmap, width, height, mime } */
export async function loadImageFile(file) {
  const declared = mimeOf(file);
  if (!ACCEPTED.includes(declared)) {
    throw new ImageError('UNSUPPORTED_FORMAT', `“${file.name}” is ${declared.replace('image/', '').toUpperCase() || 'an unknown type'}. Supported: JPG, JPEG, PNG, WEBP.`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new ImageError('IMAGE_TOO_LARGE', `Your image is too large (${fmtBytes(file.size)}). Maximum upload is ${fmtBytes(MAX_FILE_BYTES)}.`);
  }
  const real = await sniff(file);
  if (!real) throw new ImageError('INVALID_IMAGE', `“${file.name}” is not a valid JPG, PNG or WEBP image (the file may be corrupt or renamed).`);

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new ImageError('INVALID_IMAGE', `“${file.name}” could not be decoded.`));
      };
      img.src = url;
    });
  }
  const width = bitmap.width || bitmap.naturalWidth;
  const height = bitmap.height || bitmap.naturalHeight;
  if (Math.min(width, height) < MIN_SIDE) {
    throw new ImageError('INVALID_IMAGE', `Image is ${width}×${height}px. Use at least ${MIN_SIDE}px on the short side for usable video.`);
  }
  return { bitmap, width, height, mime: real };
}

export function parseRatio(value) {
  const [w, h] = String(value).split(':').map(Number);
  return { w, h, r: w / h };
}

/** Crop rect (source pixels) for a target ratio, with a focus point 0..1 */
export function cropRect(srcW, srcH, ratio, focus = { x: 0.5, y: 0.5 }) {
  const srcR = srcW / srcH;
  let w, h;
  if (srcR > ratio) {
    h = srcH;
    w = Math.round(srcH * ratio);
  } else {
    w = srcW;
    h = Math.round(srcW / ratio);
  }
  const x = Math.round(Math.min(Math.max(focus.x * srcW - w / 2, 0), srcW - w));
  const y = Math.round(Math.min(Math.max(focus.y * srcH - h / 2, 0), srcH - h));
  return { x, y, w, h };
}

function canvasFor(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

async function toBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((res) => canvas.toBlob(res, type, quality));
}

export function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Draw a (cropped) region scaled so the long side ≤ maxLong. */
function render(bitmap, rect, maxLong) {
  const scale = Math.min(1, maxLong / Math.max(rect.w, rect.h));
  const w = Math.max(1, Math.round(rect.w * scale));
  const h = Math.max(1, Math.round(rect.h * scale));
  const c = canvasFor(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
  return c;
}

const cache = new Map(); // key -> Promise<{dataUri,width,height,bytes}>

/**
 * Prepares the first frame for the provider: crop to the output ratio, scale,
 * encode JPEG under the byte budget (backend limit 4 MB encoded, Runway data-URI limit 5 MB).
 */
export function prepareForGeneration(imageId, bitmap, ratioValue, focus, { maxLong = 2048, maxDataUriBytes = 3_600_000 } = {}) {
  const key = `${imageId}|${ratioValue}|${focus.x.toFixed(3)},${focus.y.toFixed(3)}|${maxLong}`;
  if (cache.has(key)) return cache.get(key);
  const job = (async () => {
    const { r } = parseRatio(ratioValue);
    const srcW = bitmap.width || bitmap.naturalWidth;
    const srcH = bitmap.height || bitmap.naturalHeight;
    const rect = cropRect(srcW, srcH, r, focus);
    let long = maxLong;
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = render(bitmap, rect, long);
      for (const q of [0.92, 0.86, 0.8]) {
        const blob = await toBlob(canvas, 'image/jpeg', q);
        const dataUri = await blobToDataUri(blob);
        if (dataUri.length <= maxDataUriBytes) {
          return { dataUri, width: canvas.width, height: canvas.height, bytes: dataUri.length, quality: q };
        }
      }
      long = Math.round(long * 0.8);
    }
    throw new ImageError('IMAGE_TOO_LARGE', 'Your image is too large to encode within the provider limit, even after resizing.');
  })();
  cache.set(key, job);
  job.catch(() => cache.delete(key));
  return job;
}

export function clearPreparedCache(imageId) {
  for (const k of cache.keys()) if (k.startsWith(`${imageId}|`)) cache.delete(k);
}

/** Small JPEG data URI (thumbnails, analysis). */
export async function makeJpegDataUri(bitmap, maxLong = 480, quality = 0.8) {
  const w = bitmap.width || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  const canvas = render(bitmap, { x: 0, y: 0, w, h }, maxLong);
  return blobToDataUri(await toBlob(canvas, 'image/jpeg', quality));
}

/** Tiny RGBA sample for on-device analysis. */
export function samplePixels(bitmap, size = 96) {
  const w = bitmap.width || bitmap.naturalWidth;
  const h = bitmap.height || bitmap.naturalHeight;
  const scale = size / Math.max(w, h);
  const cw = Math.max(8, Math.round(w * scale));
  const ch = Math.max(8, Math.round(h * scale));
  const c = canvasFor(cw, ch);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, cw, ch);
  return { data: ctx.getImageData(0, 0, cw, ch).data, width: cw, height: ch };
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
