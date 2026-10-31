// Routing and POST bodies (ADR-0011 Decision 6).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionControl, StateSource } from './index.ts';
import type { SseHub } from './sse.ts';
import { serveImage, serveMarked, serveStatic } from './static.ts';

const MAX_BODY = 1024 * 1024;

export const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
};

const tooBig = (req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
  res.end('{"error":"toolarge"}', () => req.socket.destroy());
};

// Resolves with the body text, or null after it has already answered 413.
function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY) { tooBig(req, res); resolve(null); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) { over = true; chunks.length = 0; tooBig(req, res); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', () => { if (!over) { over = true; resolve(null); } });
    req.on('close', () => { if (!over && !req.complete) { over = true; resolve(null); } });
  });
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<{ value: any } | null> {
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') {
    sendJson(res, 415, { error: 'type' });
    req.resume();
    return null;
  }
  const text = await readBody(req, res);
  if (text === null) return null;
  try { return { value: JSON.parse(text) }; } catch { sendJson(res, 400, { error: 'json' }); return null; }
}

const ANSWER_STATUS: Record<string, number> = { unknown: 404, answered: 409, cancelled: 409, answer: 400 };

export async function route(
  opts: { state: StateSource; session: SessionControl; webDir: string },
  sse: SseHub,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  const params = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));

  if (path === '/api/events') {
    if (method !== 'GET') return sendJson(res, 405, { error: 'method' });
    return sse.handle(req, res);
  }
  if (path === '/api/message') {
    if (method !== 'POST') return sendJson(res, 405, { error: 'method' });
    const body = await readJson(req, res);
    if (!body) return;
    const r = opts.session.send(body.value?.text);
    if (r.ok) return sendJson(res, 202, { ok: true });
    return sendJson(res, r.error === 'ended' ? 409 : 400, { error: r.error });
  }
  const m = /^\/api\/requests\/([^/]+)\/answer$/.exec(path);
  if (m) {
    if (method !== 'POST') return sendJson(res, 405, { error: 'method' });
    const body = await readJson(req, res);
    if (!body) return;
    let id: string;
    try { id = decodeURIComponent(m[1]!); } catch { return sendJson(res, 404, { error: 'unknown' }); }
    const r = opts.session.answer(id, body.value);
    if (r.ok) return sendJson(res, 200, { ok: true, request: r.request });
    return sendJson(res, ANSWER_STATUS[r.error] ?? 400, r.request ? { error: r.error, request: r.request } : { error: r.error });
  }
  if (path === '/api/image') {
    if (method !== 'GET') return sendJson(res, 405, { error: 'method' });
    return serveImage(opts.state, params, res);
  }
  if (path === '/api' || path.startsWith('/api/')) return sendJson(res, 404, { error: 'notfound' });
  if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'method' });
  if (path === '/vendor/marked.js') return serveMarked(res);
  return serveStatic(opts.webDir, path, res);
}
