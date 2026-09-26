// Deterministic motion-prompt engine.
// Builds image-to-video prompts that describe MOTION (camera, subject, environment,
// intensity, direction, speed, timing) and avoids re-describing what the photo shows.
import { CAMERA, SUBJECT, ENVIRONMENT, STYLES, PROTECTIONS, INTENSITY, CATEGORY, byId } from './motion-catalog.js';

const NEED_LABEL = {
  person: 'no person detected',
  face: 'no visible face detected',
  hair: 'no visible hair detected',
  fabric: 'no clothing/fabric detected',
  sky: 'no sky detected',
  water: 'no water detected',
  foliage: 'no trees or foliage detected',
};

/** Which physical traits are present in the photo. `null` = unknown (allow everything). */
export function traitsFrom(analysis) {
  if (!analysis) return null;
  const t = new Set(CATEGORY[analysis.category]?.traits || []);
  const people = Number(analysis.people || 0);
  if (people > 0) t.add('person');
  if (analysis.faceVisible) t.add('face');
  if (analysis.faceVisible === false) t.delete('face');
  if (people === 0 && analysis.people !== undefined && analysis.people !== null) {
    ['person', 'face', 'hair'].forEach((x) => t.delete(x));
    if (!analysis.hasFabric) t.delete('fabric');
  }
  for (const [flag, trait] of [['hasSky', 'sky'], ['hasWater', 'water'], ['hasFoliage', 'foliage'], ['hasHair', 'hair'], ['hasFabric', 'fabric']]) {
    if (analysis[flag] === true) t.add(trait);
    if (analysis[flag] === false) t.delete(trait);
  }
  if (t.has('face') || t.has('hair')) t.add('person');
  return t;
}

export function compatibility(item, traits) {
  if (!item?.needs || !traits) return { ok: true };
  const missing = item.needs.filter((n) => !traits.has(n));
  return missing.length ? { ok: false, reason: NEED_LABEL[missing[0]] } : { ok: true };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const joinList = (arr) => (arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`);
const sentence = (s) => (s ? cap(s.trim().replace(/[.\s]+$/, '')) + '.' : '');

function timingSentence(duration, intensity) {
  const pace = intensity === 'dynamic' ? 'builds confidently' : intensity === 'balanced' ? 'holds a steady pace' : 'stays unhurried';
  return `Motion eases in, ${pace} and eases out smoothly across the full ${duration} seconds.`;
}

/**
 * @param {object} s
 * @param {string} s.camera  @param {string[]} s.subject  @param {string[]} s.environment
 * @param {string} s.style   @param {string} s.intensity   @param {string[]} s.protections
 * @param {number} s.duration  @param {object|null} s.analysis  @param {object} s.caps (model capabilities)
 * @param {string} [s.extra] user-specific action text to keep verbatim
 */
export function buildPrompt(s) {
  const traits = traitsFrom(s.analysis);
  const intensity = INTENSITY[s.intensity] || INTENSITY.balanced;
  const dropped = [];
  const keep = (list, ids) =>
    (ids || [])
      .map((id) => byId(list, id))
      .filter(Boolean)
      .filter((item) => {
        const c = compatibility(item, traits);
        if (!c.ok) dropped.push(`${item.label} (${c.reason})`);
        return c.ok;
      });

  const parts = [];
  const target = !traits || traits.has('person') ? 'the subject' : 'the main focal point of the scene';
  const cam = byId(CAMERA, s.camera);
  if (cam) {
    const c = compatibility(cam, traits);
    if (c.ok) parts.push(sentence(cam.phrase(intensity.speed, target)));
    else {
      dropped.push(`${cam.label} (${c.reason})`);
      parts.push(sentence(byId(CAMERA, 'push_in').phrase(intensity.speed, target)));
    }
  }

  const subj = keep(SUBJECT, s.subject);
  if (subj.length) {
    const phrases = subj.map((x) => x.phrase.replace(/^The subject/, 'the subject'));
    parts.push(sentence(`${joinList(phrases)}, with ${intensity.amount} movement`));
  }
  if (s.extra) parts.push(sentence(s.extra));

  const env = keep(ENVIRONMENT, s.environment);
  if (env.length) parts.push(sentence(joinList(env.map((x) => x.phrase))));

  const style = byId(STYLES, s.style);
  if (style) parts.push(target === 'the subject' ? style.phrase : style.phrase.replace('focused on the subject', 'across the scene'));

  parts.push(timingSentence(s.duration || 5, s.intensity));

  const prots = (s.protections || []).map((id) => byId(PROTECTIONS, id)).filter((p) => p && compatibility(p, traits).ok);
  const supportsNeg = Boolean(s.caps?.negativePrompt);
  // Always add positive stability language; for Veo also send a negative prompt.
  const positive = prots.map((p) => p.positive);
  const max = s.caps?.promptMaxChars || 1000;

  let prompt = [...parts, positive.length ? sentence(joinList(positive)) : ''].filter(Boolean).join(' ');
  // Trim protections one by one if we exceed the provider limit.
  while (prompt.length > max && positive.length) {
    positive.pop();
    prompt = [...parts, positive.length ? sentence(joinList(positive)) : ''].filter(Boolean).join(' ');
  }
  if (prompt.length > max) prompt = prompt.slice(0, max - 1).replace(/\s+\S*$/, '') + '.';

  const negativePrompt = supportsNeg ? prots.map((p) => p.neg).join(', ') : '';
  return { prompt, negativePrompt, dropped };
}

// ------------------------------------------------------------ intent detection

const INTENTS = {
  camera: [
    ['push_in', /\b(push[- ]?in|zoom(?:s|ing)? in|move(?:s)? closer|dolly in)\b/i],
    ['pull_out', /\b(pull(?:s|ing)?[- ]?(?:out|back)|zoom(?:s|ing)? out|reveal(?:ing)? the (?:scene|room))\b/i],
    ['pan_left', /\bpan(?:s|ning)? (?:to the )?left\b/i],
    ['pan_right', /\bpan(?:s|ning)? (?:to the )?right\b|\bpan(?:s|ning)?\b/i],
    ['tilt_up', /\btilt(?:s|ing)? up(?:ward)?\b/i],
    ['tilt_down', /\btilt(?:s|ing)? down(?:ward)?\b/i],
    ['orbit', /\b(orbit(?:s|ing)?|circle(?:s)? around|360)\b/i],
    ['crane_up', /\b(crane|drone|aerial|rise(?:s)? up|rising)\b/i],
    ['tracking', /\b(track(?:s|ing)?|follow(?:s|ing)?) (?:shot|the subject|her|him|them)?/i],
    ['parallax', /\b(parallax|3d effect|depth effect)\b/i],
    ['handheld', /\bhand[- ]?held\b/i],
    ['static', /\b(static|locked[- ]off|tripod|still camera)\b/i],
    ['dolly', /\bdolly\b/i],
  ],
  subject: [
    ['blink', /\bblink/i],
    ['smile', /\bsmil/i],
    ['hair', /\bhair\b/i],
    ['clothing', /\b(dress|cloth|fabric|saree|sari|veil|scarf|gown|shirt)/i],
    ['walking', /\bwalk/i],
    ['turning', /\bturn(?:s|ing)?\b(?! (?:on|off))/i],
    ['looking', /\blook(?:s|ing)? around|glanc/i],
    ['head', /\bhead\b/i],
  ],
  environment: [
    ['wind', /\b(wind|breeze|windy)\b/i],
    ['clouds', /\bcloud/i],
    ['rain', /\brain/i],
    ['fog', /\b(fog|mist|haze)\b/i],
    ['smoke', /\b(smoke|steam)\b/i],
    ['water', /\b(water|waves?|river|ocean|sea|lake|waterfall)\b/i],
    ['trees', /\b(trees?|leaves|foliage|branches|grass)\b/i],
    ['sunlight', /\b(sun(?:light)?|golden hour|light(?:ing)? (?:shift|chang))/i],
    ['dust', /\b(dust|particles|sparkles?)\b/i],
  ],
  style: [
    ['dreamy', /\b(dream|ethereal|magical)/i],
    ['dramatic', /\b(dramatic|epic|moody|intense)\b/i],
    ['luxury', /\b(luxur|elegant|premium|high[- ]end)/i],
    ['wedding', /\b(wedding|romantic|bride|groom)/i],
    ['realestate', /\b(real estate|property|listing|architectur)/i],
    ['fashion', /\b(fashion|editorial|runway look)/i],
    ['documentary', /\bdocumentary\b/i],
    ['travel', /\btravel/i],
    ['portrait', /\bportrait\b/i],
    ['cinematic', /\b(cinematic|film(?:ic)?|movie)\b/i],
  ],
  intensity: [
    ['subtle', /\b(subtle|gentle|gently|slight(?:ly)?|calm|soft(?:ly)?|slow(?:ly)?)\b/i],
    ['dynamic', /\b(dynamic|fast|energetic|bold|strong|quick)\b/i],
  ],
};

// Generic filler sentences that add nothing the structured prompt doesn't already say.
const FILLER = /^(make|turn|bring|animate|give)\b.*\b(cinematic|alive|life|move|moving|video|animated|photo|image|picture)\b[^,;]*$|^(cinematic|beautiful|realistic|high quality|4k|8k)[\s,]*$/i;

export function detectIntents(text) {
  const found = { camera: null, subject: [], environment: [], style: null, intensity: null };
  if (!text) return found;
  for (const [id, re] of INTENTS.camera) if (re.test(text)) { found.camera = id; break; }
  for (const [id, re] of INTENTS.subject) if (re.test(text)) found.subject.push(id);
  for (const [id, re] of INTENTS.environment) if (re.test(text)) found.environment.push(id);
  for (const [id, re] of INTENTS.style) if (re.test(text)) { found.style = id; break; }
  for (const [id, re] of INTENTS.intensity) if (re.test(text)) { found.intensity = id; break; }
  return found;
}

/** Sentences from the user's text that describe something specific we can't express with controls. */
export function residualActions(text) {
  if (!text) return '';
  const all = Object.values(INTENTS).flat().map(([, re]) => re);
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3 && !FILLER.test(s.replace(/[.!?]+$/, '')))
    .filter((s) => {
      // Keep a sentence only if it contains meaningful words beyond recognised intents.
      let rest = s;
      for (const re of all) rest = rest.replace(new RegExp(re.source, 'gi'), ' ');
      const words = rest
        .toLowerCase()
        .replace(/[^a-z\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w));
      return words.length >= 2;
    })
    .map((s) => s.replace(/[.!?]+$/, ''))
    .slice(0, 2)
    .join('. ');
}

const STOP = new Set('the this that with and for from into onto over under make makes made photo photograph image picture video feel feels look looks like very really some more less while also just camera movement motion moving move moves slow slowly natural naturally smooth smoothly scene subject realistic cinematic alive life keep keeps stay stays remain remains consistent add adds bring give have has its their his her them they she him are was were been being will would should could can let lets gentle gently subtle subtly soft softly'.split(' '));

/**
 * Built-in "Enhance Prompt": interprets the user's plain-language idea, merges it with
 * the selected controls (text wins when it is explicit), and returns a professional prompt.
 */
export function enhanceLocal(text, state) {
  const intents = detectIntents(text);
  const merged = {
    ...state,
    camera: intents.camera || state.camera,
    subject: [...new Set([...(intents.subject || []), ...(state.subject || [])])].slice(0, 3),
    environment: [...new Set([...(intents.environment || []), ...(state.environment || [])])].slice(0, 3),
    style: intents.style || state.style,
    intensity: intents.intensity || state.intensity,
    extra: residualActions(text),
  };
  const out = buildPrompt(merged);
  return { ...out, applied: merged, intents, source: 'local' };
}
