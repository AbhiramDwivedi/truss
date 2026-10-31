// Live-session proof for the local web UI (ADR-0011 Decision 8, plan "Live-session proof").
// Run by: npm --prefix ui run check:live. It is in no acceptance test: it needs the client's own Claude Code login.
// It starts the real ui/server/main.ts on a temp git repo with the Truss plugin and the real Agent SDK,
// passes no model, answers an AskUserQuestion card and a permission card over HTTP, and checks that each
// answer is settled in the session within 1 s of the POST (R-3, R-7, R-15). The server binds port 0.
// Erasable TypeScript, node:test, built-ins only.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const mainPath = join(root, 'ui', 'server', 'main.ts');
if (!existsSync(mainPath)) {
  throw new Error('producer missing: ui/server/main.ts');
}

const WAIT_MS = 5 * 60 * 1000; // the model decides how long a turn takes; there is no spending or time ceiling (R-22)
const ANSWER_MS = 1000;        // R-15: an answer reaches the session within 1 s

let repo = '';
let child: ChildProcess | undefined;
let port = 0;
let token = '';
let stderr = '';
const events: any[] = [];
const waiters: Array<() => void> = [];
let state: any = null;
let sseReq: http.ClientRequest | undefined;

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

function fold(msg: any) {
  if (msg.type === 'snapshot') state = structuredClone(msg.state);
  else if (msg.type === 'delta' && state) {
    for (const [k, v] of Object.entries(msg.set ?? {})) state[k] = structuredClone(v);
    if (msg.append?.transcript) state.transcript = state.transcript.concat(msg.append.transcript).slice(-500);
  }
  events.push(msg);
  for (const w of waiters.splice(0)) w();
}

function openStream() {
  sseReq = http.request({ host: '127.0.0.1', port, path: `/api/events?token=${token}`, headers: { host: `127.0.0.1:${port}`, accept: 'text/event-stream' }, agent: false }, (res) => {
    assert.equal(res.statusCode, 200);
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (line) fold(JSON.parse(line.slice(6)));
      }
    });
  });
  sseReq.on('error', () => {});
  sseReq.end();
}

function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: `${path}?token=${token}`, agent: false, headers: {
      host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)),
    } }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { out += c; });
      res.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(out); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    r.on('error', reject);
    r.end(text);
  });
}

async function waitFor<T>(what: string, pick: () => T | undefined | null | false, ms = WAIT_MS): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const got = pick();
    if (got) return got;
    if (child?.exitCode !== null && child?.exitCode !== undefined) assert.fail(`ui/server/main.ts exited (${child.exitCode}) while waiting for ${what}: ${stderr.slice(-400)}`);
    const left = end - Date.now();
    if (left <= 0) assert.fail(`timed out waiting for ${what}; session status ${state?.session?.status}, requests ${JSON.stringify((state?.requests ?? []).map((r: any) => [r.kind, r.status]))}`);
    await new Promise<void>((r) => { waiters.push(r); setTimeout(r, Math.min(left, 500)); });
  }
}

const openRequest = (kind: string, test: (r: any) => boolean = () => true) =>
  (state?.requests ?? []).find((r: any) => r.kind === kind && r.status === 'open' && test(r));

const seenAllowed = new Set<string>();
function allowOthers(isTarget: (r: any) => boolean) {
  for (const r of state?.requests ?? []) {
    if (r.kind === 'permission' && r.status === 'open' && !isTarget(r) && !seenAllowed.has(r.id)) {
      seenAllowed.add(r.id);
      void post(`/api/requests/${r.id}/answer`, { decision: 'allow' });
    }
  }
}

async function timedAnswer(id: string, body: unknown, settled: (r: any) => boolean) {
  const t0 = performance.now();
  const res = await post(`/api/requests/${id}/answer`, body);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const req = await waitFor('the answered request to show in the state', () => (state.requests as any[]).find((r) => r.id === id && r.status === 'answered' && settled(r)), 5000);
  const ms = performance.now() - t0;
  assert.ok(ms < ANSWER_MS, `answer reached the session after ${Math.round(ms)} ms, limit ${ANSWER_MS} ms`);
  console.log(`answer ${id} settled in ${Math.round(ms)} ms`);
  const again = await post(`/api/requests/${id}/answer`, body);
  assert.equal(again.status, 409);
  assert.equal(again.json?.error, 'answered');
  return req;
}

before(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'truss-live-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'live@example.invalid');
  git('config', 'user.name', 'live check');
  writeFileSync(join(repo, 'README.md'), '# tiny\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  child = spawn(process.execPath, [mainPath, '--repo', repo, '--plugin', root, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (c: string) => { stderr += c; });
  child.stdout!.setEncoding('utf8');
  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no URL line from main.ts in 30 s; stderr: ${stderr}`)), 30000);
    child!.on('exit', (code) => { clearTimeout(timer); reject(new Error(`main.ts exited ${code}: ${stderr}`)); });
    child!.stdout!.on('data', (c: string) => {
      out += c;
      const m = /^truss-ui listening on (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)$/m.exec(out);
      if (m) { clearTimeout(timer); resolve(m[1]!); }
    });
  });
  const u = new URL(url);
  port = Number(u.port);
  token = u.searchParams.get('token')!;
  assert.ok(port > 0 && token.length > 0);
  openStream();
  await waitFor('the first snapshot', () => state, 30000);
});

after(async () => {
  sseReq?.destroy();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((r) => { child!.on('exit', () => r()); setTimeout(r, 10000); });
  }
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('live session with the real SDK and the Truss plugin', { timeout: 15 * 60 * 1000 }, () => {
  it('answers an AskUserQuestion card within 1 s, once', async () => {
    const sent = await post('/api/message', { text: 'Use the truss:brief skill for this tiny goal: "add a --version flag to a hello-world CLI". Ask me exactly one question with AskUserQuestion, then stop.' });
    assert.equal(sent.status, 202, JSON.stringify(sent.json));
    const card = await waitFor('an open question card', () => {
      allowOthers(() => false);
      return openRequest('question');
    });
    assert.ok(state.session.plugin && state.session.plugin.name === 'truss', `Truss plugin not loaded: ${JSON.stringify(state.session.plugin)}`);
    assert.ok(state.trussDir.path, 'the Truss dir was not derived from the init session id');
    assert.ok(state.session.model, 'the header model comes from init (no model option is passed)');
    const answers: Record<string, string> = {};
    for (const q of card.questions) answers[q.question] = (q.options.find((o: any) => o.recommended) ?? q.options[0]).label;
    const done = await timedAnswer(card.id, { answers }, (r) => r.answers !== null);
    assert.deepEqual(done.answers, answers);
    await waitFor('the turn to end with a reply card', () => {
      allowOthers(() => false);
      const q = openRequest('question');
      if (q) {
        const more: Record<string, string> = {};
        for (const x of q.questions) more[x.question] = x.options[0].label;
        void post(`/api/requests/${q.id}/answer`, { answers: more });
      }
      return openRequest('reply');
    });
  });

  it('answers a permission card within 1 s, and the approved command runs', async () => {
    const sent = await post('/api/message', { text: 'Run the Bash command `mkdir live-out` in the working directory, then say done.' });
    assert.equal(sent.status, 202, JSON.stringify(sent.json));
    const target = (r: any) => r.toolName === 'Bash' && String(r.summary).includes('mkdir live-out');
    const card = await waitFor('an open Bash permission card for mkdir live-out', () => {
      allowOthers(target);
      return openRequest('permission', target);
    });
    await timedAnswer(card.id, { decision: 'allow' }, (r) => r.decision === 'allow');
    await waitFor('live-out to exist in the repo', () => existsSync(join(repo, 'live-out')), 2 * 60 * 1000);
  });
});
