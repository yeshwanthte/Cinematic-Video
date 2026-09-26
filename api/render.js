// Vercel Function: /api/render  (thin wrapper — logic lives in server/core/router.js)
import { handle } from '../server/core/router.js';

const run = (request) => handle(request, process.env, 'render');

export const GET = run;
export const POST = run;
export const OPTIONS = run;
