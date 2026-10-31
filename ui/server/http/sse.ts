// The SSE stream (ADR-0011 Decision 5).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StateSource } from './index.ts';

const PING_MS = 15000;

export interface SseHub {
  handle(req: IncomingMessage, res: ServerResponse): void;
  closeAll(): void;
}

export function createSse(state: StateSource): SseHub {
  const clients = new Set<() => void>();

  const parseLastId = (h: string | string[] | undefined): { instance: string; seq: number } | null => {
    if (typeof h !== 'string') return null;
    const m = /^([^:]+):(\d+)$/.exec(h.trim());
    if (!m) return null;
    const seq = Number(m[2]);
    return Number.isSafeInteger(seq) ? { instance: m[1]!, seq } : null;
  };

  return {
    handle(req, res) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 1000\n\n');

      let live = false;
      let lastSeq = 0;
      let queue: any[] = [];
      let unsubscribe: (() => void) | null = null;
      let timer: ReturnType<typeof setInterval> | null = null;
      let done = false;
      let instanceId = '';

      const cleanup = () => {
        if (done) return;
        done = true;
        clients.delete(cleanup);
        try { unsubscribe?.(); } catch { /* already gone */ }
        if (timer) clearInterval(timer);
        if (!res.writableEnded) res.end();
      };
      const write = (event: string, msg: any) => {
        if (done || res.destroyed || res.writableEnded) return;
        res.write(`id: ${instanceId}:${msg.seq}\nevent: ${event}\ndata: ${JSON.stringify(msg)}\n\n`);
      };
      const onDelta = (d: any) => {
        if (done) return;
        if (!live) { queue.push(d); return; }
        if (d.seq <= lastSeq) return;
        lastSeq = d.seq;
        write('delta', d);
      };

      clients.add(cleanup);
      res.on('close', cleanup);
      res.on('error', cleanup);
      req.on('error', cleanup);

      try {
        // Subscribe first, then read the snapshot, so no delta falls in the gap.
        unsubscribe = state.subscribe(onDelta);
        const snap = state.snapshot();
        instanceId = snap.instance;
        const last = parseLastId(req.headers['last-event-id']);
        const replay = last && last.instance === snap.instance ? state.since(last.seq) : null;
        if (replay) {
          lastSeq = last!.seq;
          for (const d of replay) { lastSeq = d.seq; write('delta', d); }
        } else {
          lastSeq = snap.seq;
          write('snapshot', snap);
        }
        live = true;
        const pending = queue;
        queue = [];
        for (const d of pending) onDelta(d);
      } catch {
        cleanup();
        return;
      }
      timer = setInterval(() => { if (!done && !res.destroyed) res.write(': ping\n\n'); }, PING_MS);
      timer.unref();
    },
    closeAll() {
      for (const c of [...clients]) c();
    },
  };
}
