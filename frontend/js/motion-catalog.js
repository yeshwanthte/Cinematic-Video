// Motion vocabulary used by the controls and the prompt engine.
// `needs` declares what must be visible in the photo for a motion to make sense:
//   person | face | hair | fabric | sky | water | foliage

export const INTENSITY = {
  subtle: { label: 'Subtle', speed: 'very slow, gentle', amount: 'minimal, restrained' },
  balanced: { label: 'Balanced', speed: 'slow, smooth', amount: 'natural, moderate' },
  dynamic: { label: 'Dynamic', speed: 'steady, purposeful', amount: 'clearly visible, energetic yet controlled' },
};

export const CAMERA = [
  { id: 'push_in', label: 'Slow Push In', hint: 'Draws the eye to the subject', phrase: (s, t) => `The camera performs a ${s} push-in toward ${t}` },
  { id: 'pull_out', label: 'Slow Pull Out', hint: 'Reveals the wider scene', phrase: (s) => `The camera pulls back in a ${s} move, gradually revealing more of the scene` },
  { id: 'pan_left', label: 'Pan Left', hint: 'Horizontal sweep', phrase: (s) => `The camera pans to the left in a ${s} sweep` },
  { id: 'pan_right', label: 'Pan Right', hint: 'Horizontal sweep', phrase: (s) => `The camera pans to the right in a ${s} sweep` },
  { id: 'tilt_up', label: 'Tilt Up', hint: 'Reveal height', phrase: (s) => `The camera tilts upward in a ${s} motion` },
  { id: 'tilt_down', label: 'Tilt Down', hint: 'Descend the frame', phrase: (s) => `The camera tilts downward in a ${s} motion` },
  { id: 'orbit', label: 'Orbit', hint: 'Arc around the subject', phrase: (s, t) => `The camera orbits around ${t} in a ${s}, smooth arc` },
  { id: 'dolly', label: 'Dolly', hint: 'Travel on a track', phrase: (s) => `The camera dollies forward along a straight, stable path at a ${s} pace` },
  { id: 'tracking', label: 'Tracking Shot', hint: 'Follows the subject', phrase: (s) => `The camera tracks alongside the subject at a ${s}, steady pace`, needs: ['person'] },
  { id: 'crane_up', label: 'Crane Up', hint: 'Rise and reveal', phrase: (s) => `The camera rises in a ${s} crane movement, lifting upward to reveal the scene` },
  { id: 'parallax', label: 'Parallax', hint: 'Depth between layers', phrase: (s) => `A ${s} lateral camera drift creates layered parallax between foreground and background` },
  { id: 'handheld', label: 'Handheld', hint: 'Organic, documentary', phrase: () => `Subtle handheld camera movement adds natural, organic micro-shake` },
  { id: 'static', label: 'Static Cinematic', hint: 'Locked off, scene moves', phrase: () => `The camera remains locked off on a tripod; all motion comes from within the scene` },
];

export const SUBJECT = [
  { id: 'natural', label: 'Natural subtle movement', phrase: 'The subject shows natural, subtle life-like micro-movement' },
  { id: 'hair', label: 'Hair moving gently', phrase: 'hair moves gently in a soft breeze', needs: ['hair'] },
  { id: 'clothing', label: 'Clothing in wind', phrase: 'clothing and fabric ripple softly in the wind', needs: ['fabric'] },
  { id: 'blink', label: 'Natural blinking', phrase: 'the subject blinks naturally', needs: ['face'] },
  { id: 'head', label: 'Slight head movement', phrase: 'the subject makes a slight, natural head movement', needs: ['face'] },
  { id: 'walking', label: 'Walking', phrase: 'the subject walks forward with a natural, unhurried gait', needs: ['person'] },
  { id: 'turning', label: 'Turning', phrase: 'the subject turns slowly and naturally', needs: ['person'] },
  { id: 'looking', label: 'Looking around', phrase: 'the subject gently looks around, eyes shifting naturally', needs: ['face'] },
  { id: 'smile', label: 'Smiling naturally', phrase: 'a soft, natural smile gradually forms', needs: ['face'] },
  { id: 'interaction', label: 'Environmental interaction', phrase: 'the subject interacts naturally with the surroundings', needs: ['person'] },
];

export const ENVIRONMENT = [
  { id: 'wind', label: 'Wind', phrase: 'a light breeze moves through the scene' },
  { id: 'clouds', label: 'Clouds', phrase: 'clouds drift slowly across the sky', needs: ['sky'] },
  { id: 'rain', label: 'Rain', phrase: 'light rain falls steadily with soft droplets' },
  { id: 'fog', label: 'Fog', phrase: 'thin fog drifts slowly through the scene' },
  { id: 'smoke', label: 'Smoke', phrase: 'wisps of smoke curl and rise slowly' },
  { id: 'water', label: 'Water movement', phrase: 'water ripples and flows naturally', needs: ['water'] },
  { id: 'trees', label: 'Trees moving', phrase: 'leaves and branches sway gently', needs: ['foliage'] },
  { id: 'sunlight', label: 'Sunlight shifting', phrase: 'sunlight shifts subtly as the light gently changes across the scene' },
  { id: 'dust', label: 'Dust particles', phrase: 'fine dust particles float and catch the light' },
  { id: 'ambient', label: 'Ambient background', phrase: 'subtle ambient movement in the background keeps the scene alive' },
];

export const STYLES = [
  { id: 'cinematic', label: 'Cinematic Film', blurb: 'Natural movement, filmic camera, realistic depth.', phrase: 'Filmic look with realistic depth and natural cinematic pacing.', camera: 'push_in', intensity: 'balanced', env: ['ambient'] },
  { id: 'luxury', label: 'Luxury', blurb: 'Elegant slow camera, premium lighting.', phrase: 'Elegant, unhurried motion with refined, premium lighting transitions.', camera: 'dolly', intensity: 'subtle', env: ['sunlight'] },
  { id: 'travel', label: 'Travel Film', blurb: 'Lively environment, cinematic camera.', phrase: 'Travel-film energy with lively, natural environmental motion.', camera: 'crane_up', intensity: 'dynamic', env: ['wind', 'clouds'] },
  { id: 'wedding', label: 'Wedding', blurb: 'Soft, romantic, natural expressions.', phrase: 'Soft, romantic atmosphere with tender, natural expressions.', camera: 'push_in', intensity: 'subtle', subject: ['natural', 'clothing'], env: ['sunlight'] },
  { id: 'realestate', label: 'Real Estate', blurb: 'Smooth architectural moves, true verticals.', phrase: 'Smooth architectural camera movement with controlled perspective; vertical lines stay perfectly straight.', camera: 'dolly', intensity: 'subtle', env: ['sunlight'] },
  { id: 'portrait', label: 'Portrait', blurb: 'Subtle facial and ambient motion.', phrase: 'Intimate, subtle motion focused on the subject.', camera: 'push_in', intensity: 'subtle', subject: ['blink', 'hair'], env: ['ambient'] },
  { id: 'fashion', label: 'Fashion', blurb: 'Editorial camera, controlled motion.', phrase: 'Editorial camera movement with confident, controlled motion.', camera: 'orbit', intensity: 'balanced', subject: ['clothing', 'head'] },
  { id: 'documentary', label: 'Documentary', blurb: 'Natural handheld, observational.', phrase: 'Natural, observational documentary feel.', camera: 'handheld', intensity: 'balanced', env: ['ambient'] },
  { id: 'dramatic', label: 'Dramatic', blurb: 'Stronger camera, atmospheric motion.', phrase: 'Bold, atmospheric motion with a moody, dramatic feel.', camera: 'crane_up', intensity: 'dynamic', env: ['fog', 'clouds'] },
  { id: 'dreamy', label: 'Dreamy', blurb: 'Soft, floating, atmospheric depth.', phrase: 'Soft, floating movement with atmospheric depth and a gentle ethereal feel.', camera: 'pull_out', intensity: 'subtle', env: ['dust', 'sunlight'] },
];

// Positive phrasing for models without a negative-prompt input (Runway Gen-4.x);
// `neg` terms feed the negativePrompt field for models that support it (Veo 3.1).
export const PROTECTIONS = [
  { id: 'face', label: 'Preserve face', needs: ['face'], positive: 'facial features stay stable, sharp and consistent', neg: 'distorted face, morphing facial features' },
  { id: 'identity', label: 'Preserve identity', needs: ['person'], positive: "the subject's identity remains exactly the same", neg: 'identity change, different person' },
  { id: 'composition', label: 'Preserve composition', positive: 'the original composition and framing are preserved', neg: 'reframing, composition change' },
  { id: 'clothing', label: 'Preserve clothing', needs: ['fabric'], positive: 'clothing keeps its original design and details', neg: 'changing clothes, altered outfit' },
  { id: 'architecture', label: 'Preserve architecture', positive: 'architectural lines stay straight and structurally stable', neg: 'warped buildings, bending walls, curved verticals' },
  { id: 'distortion', label: 'Avoid distortion', positive: 'geometry remains undistorted', neg: 'distortion, warping, melting' },
  { id: 'flicker', label: 'Avoid flickering', positive: 'lighting and textures stay temporally consistent and flicker-free', neg: 'flickering, strobing, temporal noise' },
  { id: 'limbs', label: 'Avoid extra limbs', needs: ['person'], positive: 'anatomy stays natural and correct', neg: 'extra limbs, extra fingers, malformed hands' },
  { id: 'duplication', label: 'Avoid duplication', positive: 'every object stays unique and consistent in number', neg: 'duplicated objects, cloned people' },
  { id: 'unnatural', label: 'Avoid unnatural motion', positive: 'all motion is physically plausible and smooth', neg: 'unnatural motion, jitter, sudden jumps' },
];

export const CATEGORY = {
  portrait: { label: 'Portrait', traits: ['person', 'face', 'hair', 'fabric'], camera: 'push_in', subject: ['blink', 'hair'], env: ['ambient'], style: 'portrait', intensity: 'subtle', recommend: 'Subtle push-in + natural blinking + hair movement' },
  group: { label: 'Group photo', traits: ['person', 'face', 'fabric'], camera: 'push_in', subject: ['natural', 'smile'], env: ['ambient'], style: 'cinematic', intensity: 'subtle', recommend: 'Gentle push-in + natural subtle movement' },
  wedding: { label: 'Wedding', traits: ['person', 'face', 'hair', 'fabric'], camera: 'push_in', subject: ['natural', 'clothing'], env: ['sunlight'], style: 'wedding', intensity: 'subtle', recommend: 'Slow cinematic push-in + subtle natural movement' },
  landscape: { label: 'Landscape', traits: ['sky'], camera: 'pan_right', subject: [], env: ['clouds', 'wind'], style: 'cinematic', intensity: 'subtle', recommend: 'Slow camera movement + cloud movement + atmospheric depth' },
  nature: { label: 'Nature', traits: ['foliage'], camera: 'parallax', subject: [], env: ['trees', 'wind', 'sunlight'], style: 'cinematic', intensity: 'subtle', recommend: 'Gentle parallax + swaying foliage + shifting light' },
  architecture: { label: 'Architecture', traits: ['sky'], camera: 'dolly', subject: [], env: ['ambient', 'clouds'], style: 'realestate', intensity: 'subtle', recommend: 'Slow dolly + parallax + subtle environmental movement' },
  interior: { label: 'Interior', traits: [], camera: 'dolly', subject: [], env: ['sunlight', 'dust'], style: 'realestate', intensity: 'subtle', recommend: 'Smooth dolly-in + shifting sunlight' },
  exterior: { label: 'Exterior', traits: ['sky', 'foliage'], camera: 'crane_up', subject: [], env: ['clouds', 'trees'], style: 'realestate', intensity: 'subtle', recommend: 'Slow crane up + drifting clouds + gentle foliage' },
  vehicle: { label: 'Vehicle', traits: [], camera: 'orbit', subject: [], env: ['dust', 'ambient'], style: 'dramatic', intensity: 'balanced', recommend: 'Smooth orbit + ambient particles' },
  product: { label: 'Product', traits: [], camera: 'orbit', subject: [], env: ['sunlight'], style: 'luxury', intensity: 'subtle', recommend: 'Slow orbit + elegant light sweep' },
  travel: { label: 'Travel', traits: ['sky', 'person'], camera: 'crane_up', subject: ['natural'], env: ['wind', 'clouds'], style: 'travel', intensity: 'balanced', recommend: 'Crane up + wind + drifting clouds' },
  other: { label: 'General', traits: [], camera: 'push_in', subject: [], env: ['ambient'], style: 'cinematic', intensity: 'subtle', recommend: 'Slow push-in + ambient movement' },
};

export const VARIATIONS = [
  { id: 'v_push', label: 'Slow push-in', camera: 'push_in' },
  { id: 'v_orbit', label: 'Orbit', camera: 'orbit' },
  { id: 'v_parallax', label: 'Parallax', camera: 'parallax' },
  { id: 'v_pull', label: 'Cinematic pull-out', camera: 'pull_out' },
];

export const byId = (list, id) => list.find((x) => x.id === id);
