/**
 * Minimal Node HTTP server:
 *   GET  /api/health   - liveness + whether an upstream key is configured
 *   POST /api/llm       - OpenAI-compatible proxy; holds the API key server-side
 *   GET  /api/config    - non-secret model/config summary for the UI
 *   static              - dist/web
 *
 * Security: the key is read from .env.local (gitignored) or the process
 * environment. It is never returned to the client, never logged, and the proxy
 * only forwards a fixed request shape (model/messages/temperature/max_tokens).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, extname, normalize } from 'node:path';

export interface ServerOptions {
  port?: number;
  host?: string;
  webRoot?: string;
  envFile?: string;
  maxBodyBytes?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

export interface LLMProxyConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
}

export function readLLMProxyConfig(opts: ServerOptions = {}): LLMProxyConfig {
  const env = { ...process.env, ...loadEnv(resolve(opts.envFile ?? '.env.local')) };
  return {
    baseUrl: (env.MC_LLM_BASE_URL ?? '').replace(/\/+$/, ''),
    apiKey: env.MC_LLM_API_KEY ?? '',
    model: env.MC_LLM_MODEL ?? 'deepseek-chat',
    timeoutMs: Number(env.MC_LLM_TIMEOUT_MS ?? 20000),
    maxTokens: Number(env.MC_LLM_MAX_TOKENS ?? 900),
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { rejectP(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolveP(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectP);
  });
}

/** Only a fixed, non-executable request shape is forwarded upstream. */
function sanitizeLLMRequest(body: unknown, cfg: LLMProxyConfig): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const messages = b.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const safeMessages = messages.slice(0, 8).map(m => {
    const mm = m as Record<string, unknown>;
    const role = mm.role === 'system' || mm.role === 'user' || mm.role === 'assistant' ? mm.role : 'user';
    const content = typeof mm.content === 'string' ? mm.content.slice(0, 60000) : '';
    return { role, content };
  });
  const temp = typeof b.temperature === 'number' ? Math.max(0, Math.min(1.5, b.temperature)) : 0.2;
  const maxTokens = typeof b.max_tokens === 'number' ? Math.max(1, Math.min(cfg.maxTokens, b.max_tokens)) : cfg.maxTokens;
  return { model: cfg.model, messages: safeMessages, temperature: temp, max_tokens: maxTokens, stream: false };
}

export function createApp(opts: ServerOptions = {}) {
  const webRoot = resolve(opts.webRoot ?? 'dist/web');
  const maxBody = opts.maxBodyBytes ?? 256 * 1024;
  const doFetch = opts.fetchImpl ?? ((globalThis as unknown as { fetch: typeof fetch }).fetch);
  const cfg = readLLMProxyConfig(opts);

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/api/health') {
      json(res, 200, { ok: true, llmConfigured: Boolean(cfg.apiKey && cfg.baseUrl), model: cfg.model, version: '0.1.0' });
      return;
    }
    if (path === '/api/config') {
      json(res, 200, {
        llmConfigured: Boolean(cfg.apiKey && cfg.baseUrl),
        model: cfg.model,
        baseUrlHost: cfg.baseUrl ? new URL(cfg.baseUrl).host : null,
        maxTokens: cfg.maxTokens,
        timeoutMs: cfg.timeoutMs,
        promptVersion: 'mc-prompt-v1',
      });
      return;
    }
    if (path === '/api/llm') {
      if (req.method !== 'POST') { json(res, 405, { error: 'method not allowed' }); return; }
      if (!cfg.apiKey || !cfg.baseUrl) {
        json(res, 503, { error: 'llm_not_configured', detail: 'Set MC_LLM_BASE_URL and MC_LLM_API_KEY in .env.local' });
        return;
      }
      let raw: string;
      try { raw = await readBody(req, maxBody); } catch { json(res, 413, { error: 'body too large' }); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { json(res, 400, { error: 'invalid json' }); return; }
      const upstreamBody = sanitizeLLMRequest(parsed, cfg);
      if (!upstreamBody) { json(res, 400, { error: 'invalid request shape' }); return; }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
      try {
        const upstream = await doFetch(cfg.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey },
          body: JSON.stringify(upstreamBody),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const text = await upstream.text();
        res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(text);
      } catch (e) {
        clearTimeout(timer);
        // Never echo the upstream message verbatim if it might contain the key.
        const msg = String((e as Error)?.message ?? 'upstream failure').split(cfg.apiKey).join('[REDACTED]');
        json(res, 502, { error: 'upstream_failed', detail: msg.slice(0, 200) });
      }
      return;
    }

    // Static files (path traversal guarded).
    if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method not allowed' }); return; }
    const rel = path === '/' ? '/index.html' : path;
    const target = normalize(join(webRoot, rel));
    if (!target.startsWith(webRoot)) { json(res, 403, { error: 'forbidden' }); return; }
    if (!existsSync(target) || !statSync(target).isFile()) {
      const fallback = join(webRoot, 'index.html');
      if (existsSync(fallback)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(readFileSync(fallback));
      } else {
        json(res, 404, { error: 'not found', hint: 'run pnpm build first, or use pnpm dev' });
      }
      return;
    }
    const ext = extname(target).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
    res.end(readFileSync(target));
  };

  return { handler, config: cfg, webRoot };
}

export async function startServer(port = 4173, opts: ServerOptions = {}): Promise<void> {
  const app = createApp(opts);
  const server = createServer((req, res) => { app.handler(req, res).catch(() => { try { json(res, 500, { error: 'internal' }); } catch { /* noop */ } }); });
  await new Promise<void>((resolveP, rejectP) => {
    server.once('error', rejectP);
    server.listen(port, opts.host ?? '127.0.0.1', () => resolveP());
  });
  const cfg = app.config;
  console.log('Metropolis Council serving on http://127.0.0.1:' + port);
  console.log('  web root : ' + app.webRoot);
  console.log('  llm proxy: ' + (cfg.apiKey && cfg.baseUrl ? 'configured (' + cfg.model + ' @ ' + cfg.baseUrl + ')' : 'NOT configured (deterministic council only)'));
}

export function stopServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise(resolveP => server.close(() => resolveP()));
}
