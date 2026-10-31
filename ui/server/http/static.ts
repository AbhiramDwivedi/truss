// Static files from webDir, the vendored marked, and images through state.readImage (Decisions 6 and 7).
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';
import type { StateSource } from './index.ts';

const PAGE_CSP = "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const MARKED = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', 'marked', 'lib', 'marked.esm.js');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};
const IMAGE_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const extOf = (p: string): string => { const i = p.lastIndexOf('.'); return i < 0 ? '' : p.slice(i).toLowerCase(); };

export const notFound = (res: ServerResponse) => {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"notfound"}');
};

export async function serveStatic(webDir: string, rawPath: string, res: ServerResponse): Promise<void> {
  let decoded: string;
  try { decoded = decodeURIComponent(rawPath); } catch { return notFound(res); }
  if (decoded.includes('\0') || decoded.includes('\\')) return notFound(res);
  const segs = decoded.split('/').filter((s) => s !== '');
  if (segs.some((s) => s === '..' || s === '.')) return notFound(res);
  if (decoded.endsWith('/') && segs.length > 0) return notFound(res);
  const rel = segs.length === 0 ? ['index.html'] : segs;
  try {
    const root = await realpath(webDir);
    const file = await realpath(join(root, ...rel));
    if (!file.startsWith(root + sep)) return notFound(res);
    if (!(await stat(file)).isFile()) return notFound(res);
    const body = await readFile(file);
    const ext = extOf(file);
    const headers: Record<string, string | number> = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Content-Length': body.length };
    if (ext === '.html') headers['Content-Security-Policy'] = PAGE_CSP;
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    notFound(res);
  }
}

export async function serveMarked(res: ServerResponse): Promise<void> {
  try {
    const body = await readFile(MARKED);
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': body.length });
    res.end(body);
  } catch {
    notFound(res);
  }
}

export async function serveImage(state: StateSource, params: URLSearchParams, res: ServerResponse): Promise<void> {
  const ref = params.get('ref');
  const path = params.get('path');
  if (!ref || !path) return notFound(res);
  let body: Buffer | null = null;
  try { body = await state.readImage(ref, path); } catch { body = null; }
  if (!body) return notFound(res);
  const ext = extOf(path);
  const headers: Record<string, string | number> = {
    'Content-Type': IMAGE_TYPES.has(ext) ? TYPES[ext]! : 'application/octet-stream',
    'Content-Length': body.length,
  };
  if (ext === '.svg') headers['Content-Security-Policy'] = 'sandbox';
  res.writeHead(200, headers);
  res.end(body);
}
