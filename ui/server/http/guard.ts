// Host, then Origin, then token (ADR-0011 Decision 6). No rate limit (R-16).
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export type Verdict =
  | { kind: 'ok' }
  | { kind: 'deny'; status: number; error: 'host' | 'origin' | 'token' }
  | { kind: 'redirect'; location: string; cookie: string };

export interface Guard {
  cookieName: string;
  check(req: IncomingMessage): Verdict;
}

export function createGuard(port: number, token: string): Guard {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const cookieName = `truss-ui-${port}`;
  const want = Buffer.from(token);

  const same = (given: string | null | undefined): boolean => {
    if (typeof given !== 'string') return false;
    const got = Buffer.from(given);
    return got.length === want.length && timingSafeEqual(got, want);
  };

  const cookieToken = (header: string | undefined): string | null => {
    if (!header) return null;
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() === cookieName) return part.slice(i + 1).trim();
    }
    return null;
  };

  return {
    cookieName,
    check(req) {
      const host = req.headers.host;
      if (typeof host !== 'string' || !hosts.has(host)) return { kind: 'deny', status: 403, error: 'host' };

      const origin = req.headers.origin;
      if (origin === undefined ? req.method === 'POST' : typeof origin !== 'string' || !origins.has(origin)) {
        return { kind: 'deny', status: 403, error: 'origin' };
      }

      const raw = req.url ?? '/';
      const q = raw.indexOf('?');
      const rawPath = q < 0 ? raw : raw.slice(0, q);
      const params = new URLSearchParams(q < 0 ? '' : raw.slice(q + 1));
      const queryOk = same(params.get('token'));
      if (!queryOk && !same(cookieToken(req.headers.cookie))) return { kind: 'deny', status: 401, error: 'token' };

      if (queryOk && req.method === 'GET' && !rawPath.startsWith('/api/')) {
        params.delete('token');
        const rest = params.toString();
        const path = '/' + rawPath.replace(/^\/+/, '');
        return {
          kind: 'redirect',
          location: path + (rest ? '?' + rest : ''),
          cookie: `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        };
      }
      return { kind: 'ok' };
    },
  };
}
