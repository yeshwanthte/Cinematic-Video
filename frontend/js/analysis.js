// On-device photo analysis (fallback when the backend AI assistant is not configured).
// It is a transparent heuristic — colour regions, edge geometry, border uniformity and,
// where the browser supports it, the Shape Detection FaceDetector. The UI labels it as such
// and always lets the user correct the category.
import { samplePixels } from './image-tools.js';

function stats(px, w, h, x0, y0, x1, y1, fn) {
  let n = 0, hit = 0;
  for (let y = Math.floor(y0 * h); y < Math.floor(y1 * h); y++) {
    for (let x = Math.floor(x0 * w); x < Math.floor(x1 * w); x++) {
      const i = (y * w + x) * 4;
      n++;
      if (fn(px[i], px[i + 1], px[i + 2])) hit++;
    }
  }
  return n ? hit / n : 0;
}

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const sat = (r, g, b) => {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
};
const isSkin = (r, g, b) => {
  const y = lum(r, g, b);
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 50 && cb > 77 && cb < 127 && cr > 136 && cr < 173;
};
const isSky = (r, g, b) => (b > r + 8 && b >= g - 12 && lum(r, g, b) > 110) || (lum(r, g, b) > 205 && sat(r, g, b) < 0.12);
const isFoliage = (r, g, b) => g > r + 6 && g > b + 6 && sat(r, g, b) > 0.18 && lum(r, g, b) > 30;
const isWater = (r, g, b) => b > r + 12 && g > r && sat(r, g, b) > 0.15 && lum(r, g, b) > 50;

function edgeGeometry(px, w, h) {
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = lum(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
  let strong = 0, axis = 0, total = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1] - L[i - w - 1] - 2 * L[i - 1] - L[i + w - 1];
      const gy = L[i + w - 1] + 2 * L[i + w] + L[i + w + 1] - L[i - w - 1] - 2 * L[i - w] - L[i - w + 1];
      const mag = Math.hypot(gx, gy);
      total++;
      if (mag > 120) {
        strong++;
        const a = Math.abs(Math.atan2(gy, gx)) % (Math.PI / 2);
        if (a < 0.14 || a > Math.PI / 2 - 0.14) axis++;
      }
    }
  }
  return { edgeDensity: strong / total, rectilinear: strong ? axis / strong : 0 };
}

function borderUniformity(px, w, h) {
  const vals = [];
  for (let x = 0; x < w; x++) vals.push(lum(px[x * 4], px[x * 4 + 1], px[x * 4 + 2]), lum(...px.slice(((h - 1) * w + x) * 4, ((h - 1) * w + x) * 4 + 3)));
  for (let y = 0; y < h; y++) vals.push(lum(...px.slice(y * w * 4, y * w * 4 + 3)), lum(...px.slice((y * w + w - 1) * 4, (y * w + w - 1) * 4 + 3)));
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  return { mean, sd };
}

async function detectFaces(bitmap) {
  if (!('FaceDetector' in globalThis)) return null;
  try {
    const fd = new globalThis.FaceDetector({ fastMode: true, maxDetectedFaces: 10 });
    const faces = await fd.detect(bitmap);
    const area = (bitmap.width || 1) * (bitmap.height || 1);
    const largest = faces.reduce((m, f) => Math.max(m, (f.boundingBox.width * f.boundingBox.height) / area), 0);
    return { count: faces.length, largest };
  } catch {
    return null;
  }
}

export async function analyzeOnDevice(bitmap) {
  const { data: px, width: w, height: h } = samplePixels(bitmap, 96);
  const skinCenter = stats(px, w, h, 0.25, 0.1, 0.75, 0.75, isSkin);
  const skinAll = stats(px, w, h, 0, 0, 1, 1, isSkin);
  const skyTop = stats(px, w, h, 0, 0, 1, 0.33, isSky);
  const foliage = stats(px, w, h, 0, 0, 1, 1, isFoliage);
  const waterBottom = stats(px, w, h, 0, 0.55, 1, 1, isWater);
  const { edgeDensity, rectilinear } = edgeGeometry(px, w, h);
  const border = borderUniformity(px, w, h);
  const faces = await detectFaces(bitmap);
  const aspect = (bitmap.width || w) / (bitmap.height || h);

  const scores = {
    portrait: skinCenter * 3.2 + (aspect < 1 ? 0.15 : 0),
    group: skinAll > 0.1 && aspect >= 1 ? skinAll * 2.2 : 0,
    architecture: rectilinear > 0.5 ? rectilinear * 0.9 + skyTop * 0.6 + edgeDensity : 0,
    interior: rectilinear > 0.5 && skyTop < 0.08 ? rectilinear * 0.85 + edgeDensity * 0.8 : 0,
    product: border.sd < 14 && edgeDensity < 0.18 ? 0.75 - border.sd / 40 : 0,
    nature: foliage * 1.6,
    landscape: skyTop * 1.3 + (aspect > 1.2 ? 0.15 : 0) + (rectilinear < 0.45 ? 0.1 : 0),
    other: 0.2,
  };
  if (faces) {
    if (faces.count >= 2) scores.group += 1.2;
    else if (faces.count === 1) scores.portrait += 0.8 + faces.largest * 4;
    else {
      scores.portrait *= 0.4;
      scores.group *= 0.4;
    }
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [category, top] = ranked[0];
  const second = ranked[1];
  const confidence = Math.max(0.3, Math.min(0.85, top / (top + second[1] + 0.15)));

  return {
    source: 'device',
    category,
    secondary: second[1] > 0.25 ? second[0] : null,
    confidence,
    people: faces ? faces.count : undefined,
    faceVisible: faces ? faces.count > 0 : ['portrait', 'group'].includes(category) ? true : undefined,
    hasSky: skyTop > 0.18,
    hasFoliage: foliage > 0.12,
    hasWater: waterBottom > 0.2 ? true : undefined,
    signals: { skinCenter, skinAll, skyTop, foliage, waterBottom, edgeDensity, rectilinear, borderSd: border.sd, faceDetector: Boolean(faces) },
  };
}
