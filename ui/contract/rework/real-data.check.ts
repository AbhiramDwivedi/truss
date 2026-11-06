// Contract check for the real-data defects 2 and 5 (ADR-0029 sections 2 and 6; R-9, R-39, R-42).
// Written from the ADR and the goal's Contract before any producer exists: on today's server every case imports its
// producer fine and then fails on an assertion, never on a missing export.
// Run with `node --test ui/contract/rework/real-data.check.ts`.
// Erasable TypeScript, node:test, built-ins only. Temp dirs come from mkdtemp; the server binds port 0.
// Nothing here reads the host's ~/.claude: the Claude dir is always a temp copy of the fixture.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.dirname(path.dirname(here))
const rootDir = path.dirname(uiDir)
const fixtures = path.join(uiDir, 'contract', 'fixtures')
const rawFixture = path.join(fixtures, 'real-data')
const snapshotPath = path.join(fixtures, 'rework', 'real-data', 'state.json')
const archPath = path.join(rootDir, 'plugins', 'truss', 'docs', 'architecture.md')
const SESSION = '00000000-0000-4000-8000-000000000001'

// ---------------------------------------------------------------------------
// Setup: a temp git repo holding the raw truss dir, and a temp Claude dir holding the fixture transcripts.
// ---------------------------------------------------------------------------
function projectKey(repoPath: string): string {
  return repoPath.replace(/[^A-Za-z0-9]/g, '-')
}

function makeEnv() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'truss-real-data-')))
  const repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' })
  const trussDir = path.join(repo, '.git', 'truss', SESSION)
  fs.cpSync(path.join(rawFixture, 'truss', SESSION), trussDir, { recursive: true })
  const claudeDir = path.join(base, 'claude')
  fs.cpSync(
    path.join(rawFixture, 'claude', 'projects', '-fixture-repo'),
    path.join(claudeDir, 'projects', projectKey(repo)),
    { recursive: true },
  )
  return { base, repo, trussDir, claudeDir, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) }
}

async function loadCreateStore(): Promise<(opts: any) => any> {
  try {
    const mod = await import(pathToFileURL(path.join(uiDir, 'server', 'state', 'index.ts')).href)
    if (typeof mod.createStore !== 'function') throw new Error('createStore is not exported')
    return mod.createStore
  } catch (e) {
    throw new Error('producer missing: ui/server/state/index.ts createStore (' + String((e as Error)?.message ?? e) + ')')
  }
}

const EMPTY_SESSION = {
  status: 'idle', sessionId: null, model: null, claudeCodeVersion: null, permissionMode: null,
  plugin: null, usage: null, backgroundTasks: [], error: null, queue: [],
}

// agentId -> task, over every foreman and member of the snapshot's run
function tasksOf(store: any): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const c of store.snapshot().state.run.crews) {
    for (const m of [...(c.foreman ? [c.foreman] : []), ...c.members]) out[m.agentId] = m.task
  }
  return out
}

async function withStore<T>(opts: { claude: boolean }, fn: (store: any, env: ReturnType<typeof makeEnv>) => T | Promise<T>): Promise<T> {
  const createStore = await loadCreateStore()
  const env = makeEnv()
  const store = createStore({
    repo: env.repo, trussDir: env.trussDir, pollMs: 60000,
    ...(opts.claude ? { claudeDir: env.claudeDir } : {}),
  })
  try {
    return await fn(store, env)
  } finally {
    store.close()
    env.cleanup()
  }
}

const snapshotTasks = (): Record<string, string | null> => {
  const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
  const out: Record<string, string | null> = {}
  for (const c of snap.run.crews) for (const m of [...(c.foreman ? [c.foreman] : []), ...c.members]) out[m.agentId] = m.task
  return out
}

// ---------------------------------------------------------------------------
// real-data 2: the task of a member comes from its transcript (ADR-0029 section 2).
// ---------------------------------------------------------------------------
test('real-data 2: a workflow member reads its task from the workflow transcript', async () => {
  await withStore({ claude: true }, (store) => {
    assert.equal(tasksOf(store)['a000000000000002'], 'Write the design note for the fixture widget in docs/widget.md.')
  })
})

test('real-data 2: a top-level transcript gives the task of a member the crew spawned itself', async () => {
  await withStore({ claude: true }, (store) => {
    assert.equal(tasksOf(store)['a000000000000003'], 'Build the fixture widget in src/widget/ from the design note.')
  })
})

test('real-data 2: the task is the first line after the preamble, dedented and cut to 200 characters', async () => {
  await withStore({ claude: true }, (store) => {
    const task = tasksOf(store)['a000000000000001']
    assert.equal(typeof task, 'string')
    assert.equal(task!.length, 200)
    assert.ok(task!.startsWith('Run exactly the one command below'), 'the leading indent is removed: ' + JSON.stringify(task!.slice(0, 20)))
    assert.ok(!task!.includes('\n'))
    assert.equal(task, snapshotTasks()['a000000000000001'], 'matches the snapshot the page tests run over')
  })
})

test('real-data 2: a missing transcript gives null', async () => {
  await withStore({ claude: true }, (store) => {
    const tasks = tasksOf(store)
    // a000...4 was spawned by the workflow but its transcript is not in the Claude dir.
    assert.ok('a000000000000004' in tasks)
    assert.equal(tasks['a000000000000004'], null)
    // the crew leads have no transcript either
    assert.equal(tasks['a000000000000010'], null)
    assert.equal(tasks['a000000000000011'], null)
    // and the same store did find the ones that exist, so null is not just "nothing works"
    assert.equal(typeof tasks['a000000000000002'], 'string')
  })
})

test("real-data 2: the session's task wins", async () => {
  await withStore({ claude: true }, (store) => {
    store.setSession({
      session: EMPTY_SESSION, requests: [], transcript: [],
      taskDescriptions: new Map([['a000000000000002', 'the session task for runner two']]),
    })
    const tasks = tasksOf(store)
    assert.equal(tasks['a000000000000002'], 'the session task for runner two')
    // members the session does not know still come from their transcripts
    assert.equal(tasks['a000000000000003'], 'Build the fixture widget in src/widget/ from the design note.')
    assert.equal(tasks['a000000000000004'], null)
  })
})

test('real-data 2: without a claudeDir no transcript is read and every task stays null', async () => {
  await withStore({ claude: false }, (store) => {
    for (const [id, task] of Object.entries(tasksOf(store))) assert.equal(task, null, id)
    // control: the same fixture with a claudeDir does produce tasks (fails on a server that ignores claudeDir)
  })
  await withStore({ claude: true }, (store) => {
    assert.equal(typeof tasksOf(store)['a000000000000003'], 'string')
  })
})

test('real-data 2: main.ts takes --claude-dir and starts', async () => {
  const env = makeEnv()
  const child = spawn(
    process.execPath,
    [path.join(uiDir, 'server', 'main.ts'), '--repo', env.repo, '--truss-dir', env.trussDir, '--claude-dir', env.claudeDir, '--port', '0'],
    { env: { ...process.env, CLAUDE_CONFIG_DIR: env.base }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let out = ''
  let err = ''
  try {
    const result = await new Promise<{ kind: 'url' | 'exit' | 'timeout'; code?: number | null }>((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'timeout' }), 20000)
      child.stdout!.on('data', (d) => {
        out += d
        if (/truss-ui listening on http:\/\/127\.0\.0\.1:\d+/.test(out)) { clearTimeout(timer); resolve({ kind: 'url' }) }
      })
      child.stderr!.on('data', (d) => { err += d })
      child.on('exit', (code) => { clearTimeout(timer); resolve({ kind: 'exit', code }) })
    })
    assert.equal(result.kind, 'url', `expected the URL line; got ${JSON.stringify(result)} stderr: ${err.split('\n')[0]}`)
  } finally {
    child.kill('SIGTERM')
    env.cleanup()
  }
})

// ---------------------------------------------------------------------------
// real-data 5: the architecture doc states the current design only (ADR-0029 section 6; R-39).
// ---------------------------------------------------------------------------
const FENCE = /^```/
function docLines(): string[] {
  return fs.readFileSync(archPath, 'utf8').split('\n')
}
// every heading line outside a code fence, as written
function headings(): string[] {
  const out: string[] = []
  let fenced = false
  for (const line of docLines()) {
    if (FENCE.test(line)) { fenced = !fenced; continue }
    if (!fenced && /^#+ /.test(line)) out.push(line)
  }
  return out
}
const stripSuffix = (h: string) => h.replace(/ \(\d+\.\d+\.\d+\)\s*$/, '')
// GitHub-style slug: lowercase, drop punctuation except hyphen, underscore and space, spaces to hyphens
function slug(h: string): string {
  return h.replace(/^#+ /, '').trim().toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-')
}

test('real-data 5: no heading ends in a version suffix', () => {
  const bad = headings().filter((h) => /\(\d+\.\d+\.\d+\)\s*$/.test(h))
  assert.deepEqual(bad, [])
})

test('real-data 5: no Truss version marker remains', () => {
  const marker = /(?<![\d.^~@])0\.\d+\.\d+/
  const hits: string[] = []
  docLines().forEach((line, i) => { if (marker.test(line)) hits.push(`${i + 1}: ${line.trim().slice(0, 80)}`) })
  assert.deepEqual(hits.slice(0, 10), [], `${hits.length} line(s) carry a 0.n.n marker`)
  // the pattern spares an address and a caret range
  assert.ok(!marker.test('127.0.0.1') && !marker.test('^0.3.1') && !marker.test('~0.3.1') && !marker.test('pkg@0.3.1'))
  assert.ok(marker.test('(0.4.3)') && marker.test('from 0.3.0') && marker.test(', 0.4.0'))
})

test('real-data 5: every in-doc anchor resolves to a heading slug', () => {
  const seen = new Map<string, number>()
  const slugs = new Set<string>()
  for (const h of headings()) {
    const s = slug(h)
    const n = seen.get(s) ?? 0
    seen.set(s, n + 1)
    slugs.add(n === 0 ? s : `${s}-${n}`)
  }
  const missing: string[] = []
  let fenced = false
  for (const line of docLines()) {
    if (FENCE.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    for (const m of line.matchAll(/\]\(#([^)\s]+)\)/g)) if (!slugs.has(decodeURIComponent(m[1]!).toLowerCase())) missing.push(m[1]!)
  }
  assert.deepEqual(missing, [])
})

test('real-data 5: every pre-build heading is still present', () => {
  const listed = fs.readFileSync(path.join(rawFixture, 'arch-headings.txt'), 'utf8').split('\n').filter((l) => l !== '')
  assert.ok(listed.length > 0)
  const have = new Set(headings().map(stripSuffix))
  const lost = listed.filter((l) => !have.has(l))
  assert.deepEqual(lost, [])
})

test('real-data 5: three Seams headings remain', () => {
  const seams = headings().map(stripSuffix).filter((h) => h === '### Seams')
  assert.equal(seams.length, 3)
})
