// Vercel Function: /api/health  (thin wrapper — logic lives in server/core/router.js)
import { handle } from '../server/core/router.js';

const run = (request) => handle(request, process.env, 'health');

export const GET = run;
export const POST = run;
export const OPTIONS = run;
