// ui-server SSE stream (ADR-0011 Decision 5, plus Decision 9 for the StateSource it consumes).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { boot, call, INSTANCE, openSse, until, type Booted } from './helpers.ts';

let b: Booted;
const open = new Set<ReturnType<typeof openSse>>();
const sse = (headers: Record<string, string> = {}) => { const s = openSse(b.port, `/api/events?token=${b.token}`, headers); open.add(s); return s; };

before(async () => { b = await boot(); });
after(async () => { for (const s of open) s.close(); await b.stop(); });

describe('SSE (Decision 5)', () => {
  it('Decision 5: a `: ping` comment arrives within 16 s of opening (every 15 s)', { timeout: 25000 }, async () => {
    const s = sse();
    await s.ready;
    await s.until(1);
    assert.ok(!s.raw.includes(': ping'), 'no ping in the first instant');
    await s.untilRaw(': ping\n\n', 16000);
    s.close();
  });

  it('Decision 5: several tabs at once each get their own snapshot and every delta', async () => {
    const tabs = Array.from({ length: 5 }, () => sse());
    await Promise.all(tabs.map((t) => t.ready));
    await Promise.all(tabs.map((t) => t.until(1)));
    const base = b.state.snapshot().seq;
    const sent = [b.state.emit({ notices: [] }), b.state.emit({ notices: [] }), b.state.emit({ notices: [] })];
    for (const t of tabs) {
      const ev = await t.until(4);
      assert.equal(ev[0]!.event, 'snapshot');
      assert.deepEqual(ev.slice(1).map((e) => e.data), sent);
      assert.deepEqual(ev.slice(1).map((e) => e.id), [1, 2, 3].map((i) => `${INSTANCE}:${base + i}`));
    }
    assert.notEqual(tabs[0]!.events, tabs[1]!.events);
    tabs.forEach((t) => t.close());
  });

  it('Decision 5: a tab that drops does not stop the others from getting deltas', async () => {
    const a = sse(), c = sse();
    await Promise.all([a.ready, c.ready]);
    await Promise.all([a.until(1), c.until(1)]);
    a.close();
    await until(() => true);
    const d = b.state.emit({ notices: [] });
    const ev = await c.until(2);
    assert.deepEqual(ev[1]!.data, d);
    c.close();
  });

  it('Decision 5: a reconnect storm (50 connects and drops, with and without Last-Event-ID) leaves no subscriber behind and the server serving', async () => {
    await until(() => b.state.subscribers === 0, 3000, 'earlier tabs to be unsubscribed');
    const start = b.state.subscribers;
    const top = b.state.snapshot().seq;
    const ids = [`${INSTANCE}:${top}`, `${INSTANCE}:${Math.max(0, top - 1)}`, 'garbage', 'ffffffffffffffff:1', `${INSTANCE}:${top + 99}`];
    await Promise.all(Array.from({ length: 50 }, async (_, i) => {
      const s = openSse(b.port, `/api/events?token=${b.token}`, i % 6 === 5 ? {} : { 'last-event-id': ids[i % ids.length]! });
      await s.ready;
      if (i % 3 === 0) await s.until(1).catch(() => {});
      s.close();
    }));
    b.state.emit({ notices: [] }); // emitting while tabs are going away must not throw
    await until(() => b.state.subscribers === start, 5000, `subscribers back to ${start} (now ${b.state.subscribers})`);
    assert.equal((await call(b.port, 'GET', '/', { headers: { cookie: b.cookie } })).status, 200);
    const s = sse({ 'last-event-id': `${INSTANCE}:${b.state.snapshot().seq}` });
    await s.ready;
    assert.equal(s.head.status, 200);
    const d = b.state.emit({ notices: [] });
    assert.deepEqual((await s.until(1))[0]!.data, d);
    s.close();
  });

  it('Decision 5: a delta with append.transcript passes through unchanged', async () => {
    const s = sse();
    await s.ready;
    await s.until(1);
    const entry = { id: 't1', role: 'assistant', text: 'line one\nline two   "quoted" é 😀' };
    const d = b.state.emitRaw({ append: { transcript: [entry] } });
    const ev = await s.until(2);
    assert.deepEqual(ev[1]!.data, d);
    assert.deepEqual(ev[1]!.data.append.transcript, [entry]);
    assert.equal(ev[1]!.event, 'delta');
    assert.equal(ev[1]!.raw.split('\n').filter((l) => l.startsWith('data: ')).length, 1, 'one data line');
    assert.ok(ev[1]!.raw.includes(`data: ${JSON.stringify(d)}`));
    s.close();
  });

  it('Decision 5: a delta with set and append together passes through with both parts', async () => {
    const s = sse();
    await s.ready;
    await s.until(1);
    const d = b.state.emitRaw({ set: { notices: [] }, append: { transcript: [{ id: 't2' }] } });
    const ev = await s.until(2);
    assert.deepEqual(ev[1]!.data, d);
    s.close();
  });
});
