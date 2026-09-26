#!/usr/bin/env node
// Local development server: serves /frontend and routes /api/* through the same
// handler used in production. No dependencies. Usage: `npm run dev` → http://localhost:8787
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, ROUTES } from './server/core/router.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC = path.join(ROOT, 'frontend');
const PORT = Number(process.env.PORT || 8787);

// Minimal .env loader (never commit .env — it is in .gitignore)
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
};

async function toWebRequest(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const ac = new AbortController();
  res.on('close', () => !res.writableFinished && ac.abort());
  return new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers,
    signal: ac.signal,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  });
}

async function sendWebResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (!response.body) return res.end();
  const reader = response.body.getReader();
  res.on('close', () => !res.writableFinished && reader.cancel().catch(() => {}));
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true }));
    if (done) break;
    res.write(value);
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const m = url.pathname.match(/^\/api\/([a-z]+)\/?$/);
    if (m) {
      if (!ROUTES.includes(m[1])) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } }));
      }
      const response = await handle(await toWebRequest(req, res), process.env, m[1]);
      return sendWebResponse(res, response);
    }
    let file = path.normalize(path.join(STATIC, decodeURIComponent(url.pathname)));
    if (!file.startsWith(STATIC)) {
      res.writeHead(403);
      return res.end();
    }
    if ((await stat(file).catch(() => null))?.isDirectory()) file = path.join(file, 'index.html');
    const data = await readFile(file).catch(() => null);
    if (!data) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Dev server error');
  }
});

server.listen(PORT, () => {
  const key = process.env.RUNWAY_API_KEY || process.env.RUNWAYML_API_SECRET;
  console.log(`\n  Cinematic AI Studio  →  http://localhost:${PORT}`);
  console.log(`  Hugging Face (free): ${process.env.HF_TOKEN ? 'HF_TOKEN configured ✓' : 'MISSING — add HF_TOKEN to .env (free at huggingface.co/settings/tokens)'}`);
  console.log(`  Runway (optional, paid): ${key ? 'configured ✓' : 'not configured'}`);
  console.log(`  AI assistant: ${process.env.ANTHROPIC_API_KEY ? 'Claude ✓' : process.env.HF_TOKEN && process.env.HF_ASSISTANT !== 'off' ? 'Hugging Face router ✓' : 'off (built-in prompt engine)'}\n`);
});
