// ui-server: the local HTTP server (ADR-0011 Decisions 5, 6, 9). Node built-ins only.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createGuard } from './guard.ts';
import { route, sendJson } from './routes.ts';
import { createSse } from './sse.ts';

// Local copies of the Decision 9 interfaces (type-only; ui-state and ui-session own the real ones).
export interface StateSource {
  snapshot(): any;
  since(seq: number): any[] | null;
  subscribe(fn: (d: any) => void): () => void;
  readImage(ref: string, path: string): Promise<Buffer | null>;
}
export type AnswerResult =
  | { ok: true; request: any }
  | { ok: false; error: 'unknown' | 'answered' | 'cancelled' | 'answer'; request?: any };
export interface SessionControl {
  send(text: string): { ok: true } | { ok: false; error: 'text' | 'ended' };
  answer(id: string, body: unknown): AnswerResult;
}

export function createServer(opts: { state: StateSource; session: SessionControl; webDir: string }): {
  listen(port: number): Promise<{ port: number; token: string; url: string }>;
  close(): Promise<void>;
} {
  const sse = createSse(opts.state);
  let server: http.Server | null = null;

  return {
    async listen(port) {
      if (server) throw new Error('already listening');
      const token = randomBytes(32).toString('base64url');
      const s = http.createServer();
      server = s;
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(port, '127.0.0.1', () => { s.off('error', reject); resolve(); });
      });
      const bound = (s.address() as AddressInfo).port;
      const guard = createGuard(bound, token);
      s.on('request', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        const v = guard.check(req);
        if (v.kind === 'deny') return sendJson(res, v.status, { error: v.error });
        if (v.kind === 'redirect') {
          res.writeHead(303, { Location: v.location, 'Set-Cookie': v.cookie, 'Content-Length': 0 });
          return void res.end();
        }
        route(opts, sse, req, res).catch(() => {
          if (!res.headersSent) sendJson(res, 500, { error: 'server' });
          else res.destroy();
        });
      });
      return { port: bound, token, url: `http://127.0.0.1:${bound}/?token=${token}` };
    },
    async close() {
      const s = server;
      server = null;
      sse.closeAll();
      if (!s) return;
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
        s.closeAllConnections();
      });
    },
  };
}
