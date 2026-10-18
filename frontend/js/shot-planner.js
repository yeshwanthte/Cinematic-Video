// Deterministic shot planner for Film Studio — no paid language model needed.
// Turns an idea + preset + target length into an editable list of shots whose
// durations are all NATIVE clip lengths the selected model really supports.
// The "bible" (subject, wardrobe, setting, lighting, look) is appended to every
// shot prompt so characters, clothing and scene stay described identically.
import { CAMERA, byId } from './motion-catalog.js';

export const FILM_PRESETS = {
  travel: {
    label: 'Travel film',
    look: 'travel-film look, vivid but natural colour, crisp detail',
    lighting: 'warm golden-hour sunlight with long soft shadows',
    beats: [
      { title: 'Establish', action: 'the scene comes alive as {subject} take in the view', camera: 'crane_up' },
      { title: 'Move', action: '{subject} walk forward naturally through the location', camera: 'tracking' },
      { title: 'Detail', action: 'the environment moves around {subject}: wind, water and light', camera: 'parallax' },
      { title: 'Moment', action: '{subject} pause, smile and look out at the horizon', camera: 'orbit' },
      { title: 'Farewell', action: '{subject} continue on as the scene opens up', camera: 'pull_out' },
    ],
  },
  portrait: {
    label: 'Cinematic portrait',
    look: 'shallow depth of field, soft filmic contrast, true skin tones',
    lighting: 'soft window light with gentle falloff',
    beats: [
      { title: 'Presence', action: '{subject} breathe naturally and blink, hair moving slightly', camera: 'push_in' },
      { title: 'Expression', action: 'a soft, natural smile slowly forms on {subject}', camera: 'static' },
      { title: 'Turn', action: '{subject} turn the head gently toward the light', camera: 'orbit' },
      { title: 'Close', action: '{subject} hold a calm, confident gaze', camera: 'push_in' },
    ],
  },
  product: {
    label: 'Product showcase',
    look: 'premium commercial look, clean reflections, crisp edges',
    lighting: 'controlled studio light with a slow, elegant light sweep',
    beats: [
      { title: 'Reveal', action: '{subject} is revealed as light glides across its surface', camera: 'pull_out' },
      { title: 'Hero orbit', action: 'the camera circles {subject}, highlights travelling over materials', camera: 'orbit' },
      { title: 'Detail', action: 'close detail of {subject}, subtle reflections moving', camera: 'push_in' },
      { title: 'Hero', action: '{subject} rests centre frame as the light settles', camera: 'static' },
    ],
  },
  nature: {
    label: 'Nature',
    look: 'documentary nature look, rich natural colour',
    lighting: 'soft natural daylight shifting slowly',
    beats: [
      { title: 'Wide', action: 'wind moves through {subject}, clouds drifting slowly', camera: 'pan_right' },
      { title: 'Layers', action: 'foreground foliage sways while the background stays calm', camera: 'parallax' },
      { title: 'Life', action: 'water, leaves and light move naturally across {subject}', camera: 'dolly' },
      { title: 'Rise', action: 'the view of {subject} opens up toward the sky', camera: 'crane_up' },
    ],
  },
  architecture: {
    label: 'Architecture',
    look: 'architectural photography look, perfectly straight verticals',
    lighting: 'clear daylight with soft sky reflections on glass',
    beats: [
      { title: 'Approach', action: 'a smooth approach toward {subject}', camera: 'dolly' },
      { title: 'Rise', action: 'the full height of {subject} is revealed', camera: 'crane_up' },
      { title: 'Glide', action: 'a lateral glide past {subject}, foreground and background separating', camera: 'parallax' },
      { title: 'Detail', action: 'materials and textures of {subject} catch the light', camera: 'push_in' },
    ],
  },
  lifestyle: {
    label: 'Lifestyle',
    look: 'bright lifestyle look, natural candid feel',
    lighting: 'airy natural daylight',
    beats: [
      { title: 'Candid', action: '{subject} share a relaxed, natural moment', camera: 'handheld' },
      { title: 'Laugh', action: '{subject} laugh and react naturally to each other', camera: 'push_in' },
      { title: 'Move', action: '{subject} walk together through the space', camera: 'tracking' },
      { title: 'Settle', action: '{subject} settle into a calm, happy pose', camera: 'pull_out' },
    ],
  },
  story: {
    label: 'Storytelling',
    look: 'narrative film look, motivated lighting, cinematic composition',
    lighting: 'moody, motivated light with gentle contrast',
    beats: [
      { title: 'Opening', action: 'we meet {subject}, still and thoughtful', camera: 'push_in' },
      { title: 'Inciting', action: '{subject} notice something and turn toward it', camera: 'orbit' },
      { title: 'Journey', action: '{subject} move forward with purpose', camera: 'tracking' },
      { title: 'Turn', action: 'the light changes as {subject} reach the moment', camera: 'crane_up' },
      { title: 'Resolution', action: '{subject} pause as the scene settles', camera: 'pull_out' },
    ],
  },
};

const MOTION_SPEED = { subtle: 'very slow, gentle', balanced: 'slow, smooth', dynamic: 'steady, purposeful', cinematic: 'deliberate, sweeping' };

function subjectFromIdea(idea) {
  const text = String(idea || '');
  const m = text.match(/(?:\bof|\bwith|\bshows?|\bfeaturing)\s+(an?\s+|the\s+|my\s+|our\s+)?([^,.;]+?)(?:\s+(?:walking|running|standing|sitting|dancing|playing|riding|on|in|at|near|by|during|come|comes|coming)\b|[,.;]|$)/i);
  const viaOf = (m ? m[2] : '').trim();
  if (viaOf && viaOf.length < 60 && !/^(this|the|my)?\s*(photo|picture|image)$/i.test(viaOf)) return `the ${viaOf.toLowerCase()}`;
  const lead = text.match(/^\s*(?:an?\s+|the\s+|my\s+|our\s+)?([a-z][a-z' -]{1,40}?)\s+(?:walking|running|standing|sitting|dancing|playing|riding|is|are|on|in|at|by|near|during|under)\b/i);
  if (lead && !/\b(make|turn|bring|animate|photo|picture|image|video)\b/i.test(lead[1])) return `the ${lead[1].trim().toLowerCase()}`;
  return 'the subject';
}

/** Splits targetSeconds into the fewest clips of at most maxClip (all integers ≥ minClip). */
export function splitDuration(targetSeconds, maxClip, minClip = 1) {
  const target = Math.max(minClip, Math.round(targetSeconds));
  const n = Math.max(1, Math.ceil(target / maxClip));
  const base = Math.floor(target / n);
  const out = Array.from({ length: n }, (_, i) => base + (i < target - base * n ? 1 : 0));
  return out.map((d) => Math.max(minClip, Math.min(maxClip, d)));
}

/**
 * @returns {{ bible: object, shots: Array<{id,title,action,camera,duration,continuity,transition}> }}
 * continuity: 'photo' (start from the uploaded photo), 'continue' (start from the previous
 * shot's real last frame), 'text' (text-to-video, new shot).
 */
export function planShots({ idea = '', preset = 'travel', targetSeconds = 15, maxClip = 5, minClip = 1, source = 'photo', intensity = 'balanced' } = {}) {
  const p = FILM_PRESETS[preset] || FILM_PRESETS.travel;
  const subject = subjectFromIdea(idea);
  const durations = splitDuration(targetSeconds, maxClip, minClip);
  const bible = {
    subject,
    wardrobe: 'the same clothing, colours and accessories in every shot',
    setting: idea ? String(idea).trim().replace(/[.\s]+$/, '') : 'the same location throughout',
    lighting: p.lighting,
    look: p.look,
    intensity,
  };
  const shots = durations.map((duration, i) => {
    const beat = p.beats[i % p.beats.length];
    return {
      id: `shot_${Date.now().toString(36)}_${i}_${Math.random().toString(36).slice(2, 6)}`,
      title: beat.title,
      action: beat.action.replaceAll('{subject}', subject),
      camera: beat.camera,
      duration,
      continuity: i === 0 ? (source === 'text' ? 'text' : 'photo') : 'continue',
      transition: i === 0 ? 'none' : 'crossfade',
    };
  });
  return { bible, shots, preset };
}

/** Final prompt sent to the model for one shot. */
export function shotPrompt(shot, bible = {}, { isFirst = false } = {}) {
  const speed = MOTION_SPEED[bible.intensity] || MOTION_SPEED.balanced;
  const cam = byId(CAMERA, shot.camera);
  const camLine = cam ? cam.phrase(speed, bible.subject || 'the subject') : '';
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const parts = [
    cap(String(shot.action || '').trim().replace(/[.\s]+$/, '')) + '.',
    camLine ? cap(camLine) + '.' : '',
    shot.continuity === 'continue'
      ? `This continues the previous shot in one unbroken take: the same ${bible.subject || 'subject'}, same faces, body proportions and ${bible.wardrobe || 'clothing'}, same location and lighting.`
      : shot.continuity === 'text'
        ? `${cap(bible.subject || 'The subject')} in ${bible.setting || 'the scene'}, wearing ${bible.wardrobe || 'consistent clothing'}.`
        : `Keep ${bible.subject || 'the subject'}, faces, clothing and the composition of the photo exactly as they are.`,
    bible.lighting ? `${cap(bible.lighting)}.` : '',
    bible.look ? `${cap(bible.look)}.` : '',
    'Natural, physically plausible motion with stable anatomy, no flicker and no sudden scene change.',
  ];
  let text = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (isFirst && shot.continuity === 'text' && bible.setting) text = `${cap(bible.setting)}. ${text}`;
  return text.slice(0, 1000);
}
