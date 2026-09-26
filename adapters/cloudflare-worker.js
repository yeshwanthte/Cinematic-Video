// Cloudflare Workers adapter (alternative to Vercel).
// Deploy:  npx wrangler deploy   (see wrangler.toml)
// Secrets: npx wrangler secret put RUNWAY_API_KEY
import { handle, ROUTES } from '../server/core/router.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const m = pathname.match(/^\/api\/([a-z]+)\/?$/);
    if (!m || !ROUTES.includes(m[1])) {
      return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return handle(request, env, m[1]);
  },
};
