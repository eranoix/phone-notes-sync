import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { EventEmitter } from 'node:events';
import type { NoteStore } from './store.js';
import { silentLogger, type Logger } from './log.js';

function publicDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, '..', 'public'), path.join(here, '..', '..', 'public')]) {
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  throw new Error('public/index.html not found');
}

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export interface WebOptions {
  store: NoteStore;
  events: EventEmitter;
  status: () => unknown;
  log?: Logger;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

export function createWebServer({ store, events, status, log = silentLogger }: WebOptions): Server {
  const dir = publicDir();
  const clients = new Set<ServerResponse>();

  const broadcast = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  events.on('change', (c) => broadcast('note', c));
  events.on('resync', () => broadcast('resync', {}));
  events.on('status', (s) => broadcast('status', s));
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': keep-alive\n\n');
  }, 20_000);
  heartbeat.unref();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = await readFile(path.join(dir, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
      res.end(html);
      return;
    }
    if (url.pathname === '/app.js' || url.pathname === '/style.css') {
      const type = url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css';
      const body = await readFile(path.join(dir, url.pathname.slice(1)));
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
      res.end(body);
      return;
    }
    if (url.pathname === '/healthz') {
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/api/status') {
      json(res, 200, { ...(status() as object), ...(await store.stats()) });
      return;
    }
    if (url.pathname === '/api/notes') {
      const q = url.searchParams.get('q') ?? undefined;
      json(res, 200, { notes: await store.list(q) });
      return;
    }
    const one = /^\/api\/notes\/([^/]+)$/.exec(url.pathname);
    if (one?.[1]) {
      const note = await store.get(decodeURIComponent(one[1]));
      if (note) json(res, 200, note);
      else json(res, 404, { error: 'not found' });
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    json(res, 404, { error: 'not found' });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      log.error('request failed', { url: req.url, error: err.message });
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const res of clients) res.end();
  });
  return server;
}
