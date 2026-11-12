// Tests for ADR-0028 sections 2, 6 and 7: the stress bound on the flow and task folds (R-14, R-40, R-42), and isApprovalAsk (R-47).
// Written from the ADR before the implementation. The Agent SDK is replaced by a stand-in through a module resolve hook
// (as gaps.test.ts does), so no live Claude session runs. Erasable TypeScript, node:test, built-ins only.
// Temp dirs come from mkdtemp; the server binds port 0.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.dirname(path.dirname(here));
const serverUrl = (rel: string) => pathToFileURL(path.join(uiDir, 'server', rel)).href;

const STUB_SOURCE = `
const g = globalThis;
export function query({ prompt }) {
  const feed = [];
  let wake = null;
  let stopped = false;
  const rec = { sent: [], emit(m) { feed.push(m); if (wake) { const w = wake; wake = null; w(); } } };
  g.__trussStub = rec;
  (async () => { for await (const m of prompt) rec.sent.push(m.message.content); })().catch(() => {});
  return {
    async *[Symbol.asyncIterator]() {
      while (!stopped) {
        if (feed.length) { yield feed.shift(); continue; }
        await new Promise((r) => { wake = r; });
      }
    },
    async interrupt() { stopped = true; if (wake) { const w = wake; wake = null; w(); } },
  };
}
`;
const HOOKS_SOURCE = `
export async function resolve(specifier, context, next) {
  if (specifier === '@anthropic-ai/claude-agent-sdk') {
    return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(STUB_SOURCE)}), shortCircuit: true };
  }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(HOOKS_SOURCE));

interface Stub { sent: string[]; emit(m: unknown): void }
const stub = (): Stub | undefined => (globalThis as any).__trussStub;

async function until(f: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) assert.fail('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-session-rework-'));
after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
let counter = 0;
const tmpDir = (name: string) => {
  const d = path.join(tmpRoot, `${name}-${++counter}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

const SLUGS = Array.from({ length: 12 }, (_, i) => `crew-${String(i + 1).padStart(2, '0')}`);
const NEWEST_TASK = 'a' + '0'.repeat(13) + '599'; // the task_id of the last of 600 tasks
const taskId = (i: number) => 'a' + '0'.repeat(13) + String(i).padStart(3, '0');

const PLAN = JSON.stringify({
  version: 3, goal: 'Stress', approval: 'client', approvedAt: '2026-11-04T15:31:12Z', architecture: 'docs/architecture.md',
  maxParallelCrews: 2, reworkAllowance: 2,
  crews: [{ slug: 'alpha', stage: 0, verdict: 'build', modules: ['m'], owns: ['src/alpha.ts'], acceptanceTest: 'npm test', acceptanceTestProved: true, estAgents: 2, status: 'planned' }],
});
const SPAWNS = jsonl([
  { v: 1, ts: '2026-11-04T16:00:00Z', event: 'spawn', crew: 'alpha', agent: 'alpha', agentId: 'a0000000000000000', type: 'truss:project-manager', model: 'opus', effort: 'high', by: 'main' },
  { v: 1, ts: '2026-11-04T16:00:01Z', event: 'spawn', crew: 'alpha', agent: 'alpha-builder', agentId: NEWEST_TASK, type: 'kit:builder', model: 'opus', effort: 'high', by: 'main' },
]);

async function boot() {
  const { createStore } = await import(serverUrl('state/index.ts'));
  const { createSession } = await import(serverUrl('session/index.ts'));
  const { createServer } = await import(serverUrl('http/index.ts'));
  (globalThis as any).__trussStub = undefined;
  const repo = tmpDir('repo');
  const truss = tmpDir('truss');
  fs.writeFileSync(path.join(truss, 'plan.json'), PLAN);
  fs.writeFileSync(path.join(truss, 'events.jsonl'), SPAWNS);
  const store = createStore({ repo, trussDir: truss, pollMs: 50 });
  const session = createSession({
    repo,
    pluginPath: path.join(path.dirname(uiDir), 'plugins', 'truss'),
    hasPlan: () => false,
    crewSlugs: () => SLUGS,
  });
  session.subscribe((v: unknown) => store.setSession(v));
  const server = createServer({ state: store, session, webDir: tmpDir('web') });
  const { port, token } = await server.listen(0);
  const post = (body: unknown): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const r = http.request(
        {
          host: '127.0.0.1', port, method: 'POST', path: '/api/message', agent: false,
          headers: {
            host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(data)), cookie: `truss-ui-${port}=${token}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            let json: any = null;
            try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      r.on('error', reject);
      r.end(data);
    });
  return {
    state: () => store.snapshot().state as any,
    post,
    async close() { await session.close(); await server.close(); store.close(); },
  };
}

const pmCall = (n: number) => {
  const slug = SLUGS[n % 12];
  // Workflow is not invented here: its real input has only scriptPath and args (see the Workflow test below).
  const tool = ['Agent', 'SendMessage'][n % 2];
  const tag = `call ${String(n).padStart(4, '0')} ${slug} `;
  const text = tag + 'x'.repeat(300);
  const input = tool === 'SendMessage' ? { to: slug, message: text + '\nsecond line' } : { description: text, prompt: `Work on ${slug}`, subagent_type: 'truss:project-manager' };
  return {
    type: 'assistant', parent_tool_use_id: null,
    message: { id: `msg_${n}`, role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${n}`, name: tool, input }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  };
};

test('R-14 R-40 R-42: 5,000 task_progress messages and 1,000 PM calls over 12 crews keep flow and task bounded and the fold fast', async () => {
  const w = await boot();
  try {
    await w.post({ text: 'stress' });
    await until(() => (stub()?.sent.length ?? 0) >= 1, 'the session to take the first message');
    const started = Date.now();
    stub()!.emit({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5', slash_commands: ['truss:run'], tools: [], cwd: '/' });
    let call = 0;
    for (let i = 0; i < 5000; i++) {
      const t = i % 600;
      stub()!.emit({ type: 'system', subtype: i < 600 ? 'task_started' : 'task_progress', task_id: taskId(t), description: `task ${t} step ${Math.floor(i / 600)}`, session_id: 's' });
      if (i % 5 === 0 && call < 1000) stub()!.emit(pmCall(call++));
    }
    // The last progress message for the newest task_id carries a known description.
    stub()!.emit({ type: 'system', subtype: 'task_progress', task_id: NEWEST_TASK, description: 'the latest of the newest task', session_id: 's' });
    assert.equal(call, 1000);

    const member = () => w.state().run?.crews?.find((c: any) => c.slug === 'alpha')?.members?.find((m: any) => m.name === 'alpha-builder');
    await until(() => member()?.task === 'the latest of the newest task', 'the newest task to reach Member.task', 8000);
    await until(() => (w.state().session.flow?.length ?? 0) > 0 && /call 0999 /.test(w.state().session.flow.at(-1)?.summary ?? ''), 'the last PM call to reach session.flow', 8000);
    const took = Date.now() - started;
    assert.ok(took < 5000, `the fold finished in ${took} ms, under the 5000 ms bound`);

    const flow = w.state().session.flow as any[];
    assert.equal(flow.length, 200, 'flow holds exactly the last 200 of 1,000 entries');
    assert.deepEqual(
      flow.map((e) => Number(/^call (\d{4}) /.exec(e.summary)?.[1])),
      Array.from({ length: 200 }, (_, i) => 800 + i),
      'oldest first, the newest last, nothing skipped',
    );
    for (const [i, e] of flow.entries()) {
      assert.ok(e.summary.length <= 200, `summary ${i} has ${e.summary.length} characters`);
      assert.ok(['Agent', 'SendMessage', 'Workflow'].includes(e.tool));
      assert.ok(!Number.isNaN(Date.parse(e.at)));
      assert.ok(SLUGS.includes(e.to), `to ${e.to} is a crew slug`);
      assert.equal(e.to, SLUGS[(800 + i) % 12]);
    }
    assert.ok(JSON.stringify(flow).length < 200 * 500, 'the serialised flow stays small');
    const task = member().task as string;
    assert.ok(typeof task === 'string' && task.length <= 500, 'Member.task is one short description');
  } finally { await w.close(); }
});

test('ADR-0028 section 7: a real Workflow call (input keys scriptPath and args only, as recorded in the PM transcript) still shows a summary in session.flow', async () => {
  const w = await boot();
  try {
    await w.post({ text: 'workflow' });
    await until(() => (stub()?.sent.length ?? 0) >= 1, 'the session to take the first message');
    stub()!.emit({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5', slash_commands: ['truss:run'], tools: [], cwd: '/' });
    const input = { scriptPath: '/home/u/plugins/truss/workflows/truss-stage.js', args: { trussFile: '/home/u/.git/truss/x/stage-args.json' } };
    stub()!.emit({
      type: 'assistant', parent_tool_use_id: null,
      message: { id: 'msg_wf', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_wf', name: 'Workflow', input }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });
    await until(() => (w.state().session.flow?.length ?? 0) > 0, 'the Workflow call to reach session.flow');
    const e = w.state().session.flow.at(-1);
    assert.equal(e.tool, 'Workflow');
    assert.ok(typeof e.summary === 'string' && e.summary.trim() !== '', `the Workflow summary is not empty (got ${JSON.stringify(e.summary)})`);
    assert.ok(e.summary.length <= 200);
    assert.match(e.summary, /truss-stage/, 'the summary names the script that was started');
  } finally { await w.close(); }
});

test('R-47: isApprovalAsk follows ADR-0028 section 2', async () => {
  const mod = await import(serverUrl('session/reply.ts'));
  assert.equal(typeof mod.isApprovalAsk, 'function', 'reply.ts exports isApprovalAsk');
  const f = mod.isApprovalAsk as (t: string) => boolean;
  const yes = [
    'Do you approve?',
    'Here is the plan.\n\nDo you approve this plan?',
    'Here is the plan.\n\nDo you approve this plan?\n\n',
    'Shall I proceed once I have your approval?',
    'Approve this plan?',
    'Plan is ready.\n\n\n\nCan you approve it?\n  \n',
  ];
  const no = [
    'Nothing is waiting on approval. Tell me what you want next; give me something new.',
    'Is nothing waiting on approval?',
    'There is no approval pending, right?',
    'Do you approve.',
    'Do you approve?\n\nI will wait here.',
    'Do you approve?\n\nThe plan is in the file.',
    'The build was approved?',
    'Do you disapprove?',
    'Shall I continue?',
    'What would you like next?',
    '',
    '   \n\n  ',
  ];
  for (const t of yes) assert.equal(f(t), true, JSON.stringify(t));
  for (const t of no) assert.equal(f(t), false, JSON.stringify(t));
});
