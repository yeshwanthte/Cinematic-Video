import { RunwayProvider } from './RunwayProvider.js';
import { HuggingFaceProvider } from './HuggingFaceProvider.js';
import { StudioError } from '../core/errors.js';

/**
 * Provider registry. To add Kling / Luma / Veo-direct / Seedance:
 *   1. create server/providers/<Name>Provider.js extending VideoProvider
 *   2. register a factory below
 *   3. add its models to server/models.js under providers.<id>
 */
function parseOverrides(env) {
  // HF_SPACE_URL overrides every HF model (tests / your own duplicated Space);
  // HF_SPACE_OVERRIDES='{"wan2.2-fast":"you/your-space"}' overrides per model.
  const out = {};
  if (env.HF_SPACE_URL) out['*'] = env.HF_SPACE_URL;
  try {
    Object.assign(out, env.HF_SPACE_OVERRIDES ? JSON.parse(env.HF_SPACE_OVERRIDES) : {});
  } catch {
    console.warn('HF_SPACE_OVERRIDES is not valid JSON — ignored');
  }
  return out;
}

const FACTORIES = {
  huggingface: (env) => new HuggingFaceProvider({ token: env.HF_TOKEN, spaceOverrides: parseOverrides(env) }),
  runway: (env) =>
    new RunwayProvider({
      apiKey: env.RUNWAY_API_KEY || env.RUNWAYML_API_SECRET,
      baseUrl: env.RUNWAY_API_BASE,
      version: env.RUNWAY_API_VERSION,
    }),
  // kling: (env) => new KlingProvider({ apiKey: env.KLING_API_KEY }),
  // luma:  (env) => new LumaProvider({ apiKey: env.LUMA_API_KEY }),
};

export function listProviderIds() {
  return Object.keys(FACTORIES);
}

export function getProvider(id, env) {
  const factory = FACTORIES[id];
  if (!factory) throw new StudioError('INVALID_REQUEST', `Unknown provider "${id}".`);
  return factory(env);
}
