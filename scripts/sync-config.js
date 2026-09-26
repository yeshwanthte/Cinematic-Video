// Copies server/models.js → frontend/models.json (offline fallback used only
// when the backend is unreachable; the live UI always prefers GET /api/models).
import { writeFileSync } from 'node:fs';
import MODELS from '../server/models.js';

writeFileSync(new URL('../frontend/models.json', import.meta.url), JSON.stringify(MODELS, null, 2) + '\n');
console.log('frontend/models.json updated');
