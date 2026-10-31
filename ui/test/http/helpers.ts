// Shared helpers for the ui-server crew tests (ADR-0011 Decisions 5, 6, 8, 9).
// Erasable TypeScript, node:test, built-ins only. Every server binds port 0.
// makeState and makeSession implement the Decision 9 interfaces (StateSource, SessionControl);
// they are interface implementations, not a fake Claude session.
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from '../../server/http/index.ts';

export const INSTANCE = 'fedcba9876543210';

export function makeState() {
  const log: any[] = [];
  const subs = new Set<(d: any) => void>();
  const images = new Map<string, Buffer>();
  const imageCalls: Array<[string, string]> = [];
  const st = {
    images, imageCalls,
    emit(set: Record<string, unknown>) { return st.emitRaw({ set }); },
    emitRaw(body: Record<string, unknown>) {
      const d = { type: 'delta', seq: log.length + 1, ...body };
      log.push(d);
      for (const f of [...subs]) f(d);
      return d;
    },
    get subscribers() { return subs.size; },
    snapshot() {
      return {
        type: 'snapshot', instance: INSTANCE, seq: log.length,
        state: {
          v: 1, repo: '/tmp/repo', trussDir: { path: null, exists: false },
          session: { status: 'idle', sessionId: null, model: null, claudeCodeVersion: null, permissionMode: null, plugin: null, usage: null, backgroundTasks: 0, error: null },
          requests: [], transcript: [], run: null, decisions: [], adrs: [], design: null, notices: [],
        },
      };
    },
    since(seq: number) { return Number.isInteger(seq) && seq >= 0 && seq <= log.length ? log.slice(seq) : null; },
    subscribe(fn: (d: any) => void) { subs.add(fn); return () => { subs.delete(fn); }; },
    async readImage(ref: string, path: string) { imageCalls.push([ref, path]); return images.get(`${ref}\0${path}`) ?? null; },
  };
  return st;
}

export function makeSession() {
  const s = {
    sent: [] as string[],
    answers: [] as string[],
    send(text: unknown) {
      if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'text' };
      s.sent.push(text);
      return { ok: true };
    },
    answer(id: string, _body: unknown) { s.answers.push(id); return { ok: false, error: 'unknown' }; },
  };
  return s;
}

export interface Res { status: number; headers: http.IncomingHttpHeaders; text: string; body: Buffer; json: any }

export function call(port: number, method: string, path: string, o: { headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) };
    if (o.body !== undefined) headers['content-length'] = String(Buffer.byteLength(o.body));
    const r = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body, json });
      });
    });
    r.on('error', reject);
    r.end(o.body);
  });
}

// A chunked upload (no Content-Length): `chunks` pieces of `size` bytes. A server that answers 413 and
// closes early may reset the socket; the status counts only when the response arrived first.
export function callChunked(port: number, path: string, headers: Record<string, string>, chunks: number, size: number): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve) => {
    let status = 0;
    let rh: http.IncomingHttpHeaders = {};
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: { host: `127.0.0.1:${port}`, 'transfer-encoding': 'chunked', ...headers }, agent: false }, (res) => {
      status = res.statusCode ?? 0;
      rh = res.headers;
      res.resume();
      res.on('end', () => resolve({ status, headers: rh }));
      res.on('error', () => resolve({ status, headers: rh }));
    });
    r.on('error', () => resolve({ status, headers: rh }));
    const piece = Buffer.alloc(size, 0x78);
    let i = 0;
    const pump = () => {
      while (i < chunks) {
        i++;
        if (!r.write(piece)) { r.once('drain', pump); return; }
      }
      r.end();
    };
    pump();
  });
}

// Raw socket request: lets a test omit the Host header (HTTP/1.0).
export function rawRequest(port: number, lines: string[]): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let data = '';
    sock.setEncoding('utf8');
    sock.on('data', (c) => { data += c; });
    sock.on('error', reject);
    sock.on('close', () => resolve({ status: Number(/^HTTP\/1\.\d (\d+)/.exec(data)?.[1] ?? 0), text: data }));
    sock.end(lines.join('\r\n') + '\r\n\r\n');
  });
}

export interface SseEvent { id: string | null; event: string; data: any; raw: string }
export function openSse(port: number, path: string, headers: Record<string, string> = {}) {
  const events: SseEvent[] = [];
  const waiters: Array<() => void> = [];
  const rawChunks: string[] = [];
  let buf = '';
  let head: { status: number; headers: http.IncomingHttpHeaders } | null = null;
  let req!: http.ClientRequest;
  const ready = new Promise<void>((resolve, reject) => {
    req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers: { host: `127.0.0.1:${port}`, accept: 'text/event-stream', ...headers }, agent: false }, (res) => {
      head = { status: res.statusCode ?? 0, headers: res.headers };
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        rawChunks.push(c);
        buf += c;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let id: string | null = null, event = 'message', data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) id = line.slice(4);
            else if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) events.push({ id, event, data: JSON.parse(data), raw: block });
        }
        for (const w of waiters.splice(0)) w();
      });
      res.on('error', () => {});
      resolve();
    });
    req.on('error', (e) => { if (!head) reject(e); });
    req.end();
  });
  async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
    const end = Date.now() + ms;
    while (!pred()) {
      const left = end - Date.now();
      if (left <= 0) assert.fail(`timed out waiting for ${what}; events ${JSON.stringify(events.map((e) => e.id))}`);
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, Math.min(left, 100)); });
    }
  }
  return {
    ready, events,
    get head() { return head!; },
    get raw() { return rawChunks.join(''); },
    until: async (n: number, ms = 3000) => { await waitFor(() => events.length >= n, ms, `${n} SSE events`); return events; },
    untilRaw: (text: string, ms: number) => waitFor(() => rawChunks.join('').includes(text), ms, `raw ${JSON.stringify(text)}`),
    close() { req.destroy(); },
  };
}

export async function until(pred: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export interface Booted {
  server: any; port: number; token: string; url: string;
  webDir: string; root: string;
  state: ReturnType<typeof makeState>; session: ReturnType<typeof makeSession>;
  origin: string;
  cookie: string;
  authed(extra?: Record<string, string>): Record<string, string>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Res>;
  stop(): Promise<void>;
}

// Start a server on port 0. The temp root holds web/ (index.html plus `files`); a test may put a secret beside web/.
export async function boot(o: { state?: ReturnType<typeof makeState>; session?: ReturnType<typeof makeSession>; files?: Record<string, string> } = {}): Promise<Booted> {
  const root = mkdtempSync(join(tmpdir(), 'truss-http-test-'));
  const webDir = join(root, 'web');
  mkdirSync(webDir);
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>t</title><p>hi</p>');
  for (const [name, text] of Object.entries(o.files ?? {})) {
    mkdirSync(dirname(join(webDir, name)), { recursive: true });
    writeFileSync(join(webDir, name), text);
  }
  const state = o.state ?? makeState();
  const session = o.session ?? makeSession();
  const server = createServer({ state, session, webDir });
  const l = await server.listen(0);
  const origin = `http://127.0.0.1:${l.port}`;
  const cookie = `truss-ui-${l.port}=${l.token}`;
  return {
    server, port: l.port, token: l.token, url: l.url, webDir, root, state, session, origin, cookie,
    authed: (extra = {}) => ({ origin, cookie, ...extra }),
    post: (path, body, headers) => call(l.port, 'POST', path, { headers: { 'content-type': 'application/json', ...(headers ?? { origin, cookie }) }, body: JSON.stringify(body) }),
    async stop() { await server.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
