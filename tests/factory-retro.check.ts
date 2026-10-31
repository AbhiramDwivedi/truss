// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0012 Decisions 3, 9 and 10: the stress cases and the stage.js seam that tests/doctor-contract.check.ts does not cover.
// Written from the ADR and docs/*.schema.json before `factory.ts doctor`, the `catalog` key, the extract write and stage.js's
// `known problem` text exist.
//
// Run with: node --test tests/factory-retro.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs.
//
// Gameability: every id, fix, token and name is generated per run, and hit lines are built from retro/catalog.json at run time, so a
// fixed answer fails. Nothing from retro/ is imported, and no check file is imported (it would run its tests): the stage.js exec
// harness below is a copy of tests/workflows.check.ts's.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { REAL_PLUGIN, appendEvent, assertOneLine, crew, factorySpawn, git, mkEnv, planObj, tmp, writePlan } from './fixtures/workflow-run/harness.ts'

const CFG = { merge: 'sequential', target: 'main' }
const FINISH_KEYS = ['merged', 'rework', 'blocked', 'refused', 'audit', 'incomplete', 'stopped']
const hex = (): string => randomBytes(4).toString('hex')

// ---------- the catalog, read at run time ----------

function catalogEntries(): any[] {
  let text: string
  try {
    text = readFileSync(`${REAL_PLUGIN}/retro/catalog.json`, 'utf8')
  } catch {
    assert.fail('producer missing: retro/catalog.json')
  }
  const c = JSON.parse(text)
  assert.ok(Array.isArray(c.entries) && c.entries.length > 0, 'catalog has entries')
  return c.entries
}
// ADR-0012 Decision 3: a line hits an entry when it holds the anchor literally and at least one pattern (no flags) matches it.
const hits = (e: any, line: string): boolean => line.includes(e.anchor) && e.patterns.some((p: string) => new RegExp(p).test(line))

const SAMPLES: Record<string, string[]> = {
  'webkit-host-libs': ['error while loading shared libraries: libicudata.so.66: cannot open shared object file: No such file or directory', '  libicudata.so.74 => not found', 'Missing libraries: libicudata.so.74'],
  'settings-local-not-in-worktrees': ["Error: ENOENT: no such file or directory, open '/repo/.claude/worktrees/truss-x/.claude/settings.local.json'", '.claude/settings.local.json is not in the worktree, so the allow rules did not apply'],
  'worktree-guard-shell-shape': ["This session is isolated in the worktree /repo/.claude/worktrees/x but this command cd's into /repo. Refusing to run it"],
  'harness-only-claude-code': ["Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'claude-code' imported from /repo/tests/x.check.ts"],
  'node-modules-missing': ["Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express' imported from /repo/ui/server/index.ts"],
  'tracked-pyc': ['\ttests/__pycache__/retro.cpython-312.pyc', '?? tests/__pycache__/'],
}

/** A line that hits entry `e` and carries the per-run token on its end; undefined when no candidate can carry one. */
function tokenedLine(e: any, token: string): string | undefined {
  for (const c of [...(SAMPLES[e.id] ?? []), e.anchor, `${e.anchor} failed`]) {
    if (hits(e, `${c} ${token}`)) return `${c} ${token}`
    if (hits(e, `${token} ${c}`)) return `${token} ${c}`
  }
  return undefined
}

/** Entries that a tokened line hits and no other entry hits, in catalog order. */
function soloEntries(): any[] {
  const all = catalogEntries()
  return all.filter((e) => {
    const l = tokenedLine(e, 'solo-probe-token')
    return l !== undefined && all.filter((o) => hits(o, l)).length === 1
  })
}

// ---------- doctor ----------

function doctor(env: any, extra: string[] = []): { res: any; j: any } {
  const res = env.run('doctor', {}, extra)
  const j = res.json
  if (j === undefined || j === null || !Array.isArray(j.probes)) {
    assert.fail(`producer missing: factory doctor (exit ${res.status}; stdout ${res.stdout.slice(0, 200)}; stderr ${res.stderr.slice(0, 200)})`)
  }
  return { res, j }
}

function writeCatalog(entries: { id: string; fix: string; probe?: unknown }[]): string {
  const p = `${tmp('retro-cat-')}/catalog.json`
  const body = entries.map((e) => ({ id: e.id, kind: 'friction', title: `title ${e.id}`, anchor: `anchor-${e.id}`, patterns: [`anchor-${e.id}`], fix: e.fix, ...(e.probe === undefined ? {} : { probe: e.probe }), fixedBy: null }))
  writeFileSync(p, JSON.stringify({ v: 1, entries: body }, null, 2) + '\n')
  return p
}

describe('factory.ts doctor: stress cases', () => {
  test('a plan with no needs and a --catalog with no probes: probes [], exit 0', () => {
    const env = mkEnv({ config: CFG, useRealPlugin: true })
    const t = hex()
    writePlan(env.dir, planObj([crew(`a-${t}`), crew(`b-${t}`, { stage: 2 })], { version: 3 }))
    const cat = writeCatalog([{ id: `noprobe-${t}`, fix: `fix ${t}` }, { id: `noprobe2-${t}`, fix: `fix2 ${t}` }])
    const { res, j } = doctor(env, ['--catalog', cat])
    assert.equal(res.status, 0)
    assert.equal(j.ok, true)
    assert.deepEqual(j.probes, [])
    assert.deepEqual(j.failed, [])
    assert.deepEqual(j.bundle.rulings, [])
  })

  test('failing, signal-killed and missing-binary command probes each come back pass false by name, exit 1, no crash, and the passing probe still runs', () => {
    const env = mkEnv({ config: CFG, useRealPlugin: true })
    const t = hex()
    const slug = `crew-${t}`
    const missingBin = `no-such-binary-${t}`
    writePlan(env.dir, planObj([crew(slug, { needs: [
      { id: `exit-${t}`, why: 'w', probe: { kind: 'command', run: `echo out-${t}; exit 7` } },
      { id: `sig-${t}`, why: 'w', probe: { kind: 'command', run: 'kill -9 $$' } },
      { id: `nobin-${t}`, why: 'w', probe: { kind: 'command', run: missingBin } },
      { id: `ok-${t}`, why: 'w', probe: { kind: 'command', run: 'true' } },
    ] })], { version: 3 }))
    const { res, j } = doctor(env, ['--catalog', writeCatalog([])])
    assert.equal(res.status, 1, `exit 1, got ${res.status}; stderr ${res.stderr.slice(0, 200)}`)
    assert.equal(j.ok, false)
    const by = (id: string) => j.probes.find((p: any) => p.name === `${slug}/${id}`)
    for (const id of [`exit-${t}`, `sig-${t}`, `nobin-${t}`]) {
      assert.ok(by(id), `${id} is in probes: ${JSON.stringify(j.probes)}`)
      assert.equal(by(id).pass, false, `${id} fails`)
      assert.equal(by(id).kind, 'command')
      assert.equal(typeof by(id).detail, 'string')
      assert.ok(j.failed.includes(`${slug}/${id}`), `${id} is in failed`)
    }
    assert.ok(by(`exit-${t}`).detail.includes(`out-${t}`), 'detail is the first line of output')
    assert.equal(by(`ok-${t}`).pass, true)
    assert.deepEqual(j.passed, [`${slug}/ok-${t}`])
    assert.equal(j.failed.length, 3)
  })

  test('a file probe on a missing path names the path in detail; an existing path passes', () => {
    const env = mkEnv({ config: CFG, useRealPlugin: true })
    const t = hex()
    const missing = `no/such/dir-${t}/file.txt`
    writePlan(env.dir, planObj([crew(`c-${t}`, { needs: [
      { id: `gone-${t}`, why: 'w', probe: { kind: 'file', path: missing } },
      { id: `here-${t}`, why: 'w', probe: { kind: 'file', path: 'README.md' } },
    ] })], { version: 3 }))
    const { res, j } = doctor(env, ['--catalog', writeCatalog([])])
    assert.equal(res.status, 1)
    const gone = j.probes.find((p: any) => p.name === `c-${t}/gone-${t}`)
    assert.ok(gone, JSON.stringify(j.probes))
    assert.equal(gone.pass, false)
    assert.equal(gone.kind, 'file')
    assert.ok(gone.detail.includes(missing), `detail names the path: ${gone.detail}`)
    assert.equal(j.probes.find((p: any) => p.name === `c-${t}/here-${t}`).pass, true)
  })

  test('a need with allow rules but a passing probe contributes its allow rules and no download', () => {
    const env = mkEnv({ config: CFG, useRealPlugin: true })
    const t = hex()
    const allow = [`Bash(first-${t}:*)`, `Bash(second-${t}:*)`]
    const download = `npx never-${t}`
    writePlan(env.dir, planObj([crew(`c-${t}`, { needs: [{ id: `ok-${t}`, why: 'w', probe: { kind: 'command', run: 'true' }, allow, download }] })], { version: 3 }))
    const { res, j } = doctor(env, ['--catalog', writeCatalog([])])
    assert.equal(res.status, 0)
    assert.deepEqual(j.bundle.allow, allow)
    assert.deepEqual(j.bundle.downloads, [])
    assert.ok(!JSON.stringify(j).includes(download), 'the download of a passing need is nowhere in the body')
  })
})

// ---------- check: several matches ----------

function checkWith(output: string, exit: number): { res: any; body: any; record: any } {
  const env = mkEnv({ config: CFG, useRealPlugin: true })
  writeFileSync(`${env.repo}/sample.txt`, output + '\n')
  writePlan(env.dir, planObj([crew('s', { acceptanceTest: `cat sample.txt; exit ${exit}` })], { version: 3 }))
  const res = env.run('check', { slug: 's', cwd: env.repo, expect: 'green' })
  const body = assertOneLine(res)
  const record = JSON.parse(readFileSync(`${env.dir}/checks/s-1.json`, 'utf8'))
  return { res, body, record }
}

describe('factory.ts check: several catalog matches', () => {
  test('hit lines for two different entries gain both, in catalog order, each with its own first hit line', () => {
    const solo = soloEntries()
    assert.ok(solo.length >= 2, `the catalog holds two entries a tokened line hits alone (got ${solo.length})`)
    const [a, b] = solo
    const ta = `tok-a-${hex()}`
    const tb = `tok-b-${hex()}`
    const la = tokenedLine(a, ta)
    const lb = tokenedLine(b, tb)
    // b's line comes first in the output, a's second: the key still follows catalog order (a before b)
    const { res, body, record } = checkWith(`noise ${hex()}\n${lb}\nmore noise\n${la}\nend`, 1)
    assert.ok(Array.isArray(body.catalog), `the body gains catalog: ${JSON.stringify(body)}`)
    assert.deepEqual(body.catalog.map((c: any) => c.id), [a.id, b.id], 'catalog order')
    assert.deepEqual(body.catalog.map((c: any) => c.fix), [a.fix, b.fix])
    assert.ok(body.catalog[0].line.includes(ta), `entry ${a.id} carries its own line: ${body.catalog[0].line}`)
    assert.ok(body.catalog[1].line.includes(tb), `entry ${b.id} carries its own line: ${body.catalog[1].line}`)
    assert.ok(!body.catalog[0].line.includes(tb) && !body.catalog[1].line.includes(ta))
    assert.deepEqual(record.catalog, body.catalog, 'the checks/ record matches the body')
    assert.equal(body.ok, false)
    assert.equal(body.exit, 1)
    assert.equal(res.status, 1)
  })

  test('two hit lines for the same entry report only the first', () => {
    const e = soloEntries()[0]
    assert.ok(e, 'the catalog holds an entry a tokened line hits alone')
    const t1 = `first-${hex()}`
    const t2 = `second-${hex()}`
    const { body, record } = checkWith(`${tokenedLine(e, t1)}\nbetween\n${tokenedLine(e, t2)}`, 1)
    assert.ok(Array.isArray(body.catalog), JSON.stringify(body))
    assert.equal(body.catalog.length, 1, JSON.stringify(body.catalog))
    assert.equal(body.catalog[0].id, e.id)
    assert.ok(body.catalog[0].line.includes(t1))
    assert.ok(!body.catalog[0].line.includes(t2))
    assert.deepEqual(record.catalog, body.catalog)
  })

  test('a hit line that needs its leading tab (real git status output) still hits', () => {
    const e = catalogEntries().find((c: any) => c.id === 'tracked-pyc')
    assert.ok(e, 'the catalog holds tracked-pyc')
    const dir = `tools-${hex()}`
    const line = `\t${dir}/__pycache__/`
    assert.ok(hits(e, line), 'the untrimmed line hits the entry')
    assert.ok(!hits(e, line.trim()), 'the trimmed line does not, so the test sees the tab')
    const { body, record } = checkWith(`On branch main\nUntracked files:\n${line}\n`, 1)
    assert.ok(Array.isArray(body.catalog), JSON.stringify(body))
    assert.deepEqual(body.catalog.map((c: any) => c.id), ['tracked-pyc'])
    assert.equal(body.catalog[0].line, line.trim(), 'the shown line is trimmed')
    assert.deepEqual(record.catalog, body.catalog)
  })
})

// ---------- finish: the extract with no transcripts, and when it cannot be written ----------

/** A finish world with a crew `s` running on an old spawn line (so the liveness rule passes) and a transcript dir made by `mk`. */
function finishWith(mk: (project: string, session: string) => string, opts: { retroIsFile?: boolean } = {}) {
  const env = mkEnv({ config: CFG, useRealPlugin: true })
  const project = tmp('retro-proj-')
  const session = `sess-${hex()}`
  const transcript = mk(project, session)
  const old = Date.parse('2026-10-29T10:01:00.000Z') / 1000
  utimesSync(transcript, old, old)
  writePlan(env.dir, planObj([crew('s', { status: 'running' })], { approvedAt: '2026-10-01T00:00:00.000Z', version: 3 }))
  appendEvent(env.dir, factorySpawn('s', new Date(Date.now() - 3 * 3600_000).toISOString()))
  if (opts.retroIsFile) writeFileSync(`${env.dir}/retro`, 'a plain file where the retro dir should be\n')
  const extractPath = `${env.dir}/retro/extract.json`
  const decisions = () => (existsSync(`${env.dir}/decisions.md`) ? readFileSync(`${env.dir}/decisions.md`, 'utf8') : '')
  return { env, extractPath, decisions, finish: () => env.run('finish', { transcript }) }
}
const emptyRunDir = (project: string): string => {
  const d = `${project}/plain-${hex()}`
  mkdirSync(d, { recursive: true })
  return d
}
const emptyWorkflowRun = (project: string, session: string): string => {
  const d = `${project}/${session}/subagents/workflows/wf_1`
  mkdirSync(d, { recursive: true })
  return d
}

describe('factory.ts finish: no transcripts', () => {
  for (const [name, mk] of [['an empty run dir not under subagents/workflows', emptyRunDir], ['an empty run dir under subagents/workflows', emptyWorkflowRun]] as const) {
    test(`${name}: still writes retro/extract.json with no items, the body keeps its keys, the exit code is the failed-write control's`, () => {
      const w = finishWith(mk)
      const res = w.finish()
      const body = assertOneLine(res)
      assert.deepEqual(Object.keys(body), FINISH_KEYS, 'finish keeps exactly its keys')
      assert.ok(existsSync(w.extractPath), `finish writes ${w.extractPath}; stdout ${res.stdout.slice(0, 200)}`)
      const text = readFileSync(w.extractPath, 'utf8')
      assert.ok(text.startsWith('{\n') && text.endsWith('\n'), 'JSON.stringify(x, null, 2) + newline')
      const x = JSON.parse(text)
      assert.equal(x.v, 1)
      assert.deepEqual(x.items, [], 'no items')
      assert.deepEqual(x.catalogHits, [])
      // the control: the same world where the extract cannot be written. Body and exit do not depend on the extract.
      const control = finishWith(mk, { retroIsFile: true }).finish()
      assert.equal(res.status, control.status, 'exit code unchanged by the extract write')
      assert.deepEqual(body, assertOneLine(control), 'body unchanged by the extract write')
    })
  }
})

describe('factory.ts finish: the extract cannot be written', () => {
  test('<truss dir>/retro is a plain file: one `retro extract failed: <message>` decision line across two runs, body and exit as a normal run', () => {
    const mk = emptyWorkflowRun
    const w = finishWith(mk, { retroIsFile: true })
    const first = w.finish()
    const body = assertOneLine(first)
    assert.deepEqual(Object.keys(body), FINISH_KEYS)
    const lines = (): string[] => w.decisions().split('\n').filter((l) => l.includes('retro extract failed:'))
    assert.equal(lines().length, 1, `one decision line after the first run; decisions.md:\n${w.decisions().slice(0, 600)}`)
    assert.match(lines()[0], /retro extract failed: \S/, 'the line carries a message')
    assert.equal(readFileSync(`${w.env.dir}/retro`, 'utf8'), 'a plain file where the retro dir should be\n', 'the plain file is left as it was')
    const second = w.finish()
    assert.equal(second.status, first.status)
    assert.deepEqual(assertOneLine(second), body)
    assert.equal(lines().length, 1, 'the second run appends nothing more')
    // a normal run (extract written) has the same body and exit
    const normal = finishWith(mk).finish()
    assert.equal(normal.status, first.status, 'exit code as a normal run')
    assert.deepEqual(assertOneLine(normal), body, 'body as a normal run')
    assert.ok(!git(w.env.repo, ['status', '--porcelain']).includes('extract'), 'nothing is written into the repo')
  })
})

// ---------- stage.js: `known problem <id>: <fix>` ----------
// The exec harness is a copy of tests/workflows.check.ts (never imported: it would run that file's tests).

const PLUGIN = REAL_PLUGIN
const STAGE_PATH = `${PLUGIN}/workflows/stage.js`
const st = (name, fn) => test(name, { timeout: 20000 }, fn)

const ROLES = {
  designer: { agentType: 'truss:design-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  checker: { agentType: 'truss:checking-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  planner: { agentType: 'truss:planning-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  tester: { agentType: 'proj:tester', model: 'sonnet', effort: 'medium', isolation: 'worktree' },
  builder: { agentType: 'proj:builder', model: 'sonnet', effort: 'low', isolation: 'worktree' },
  resolver: { agentType: 'proj:resolver', model: 'sonnet', effort: 'medium', isolation: 'none' },
  writer: { agentType: 'truss:writer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  rca: { agentType: 'general-purpose', model: 'opus', effort: 'medium', isolation: 'none' },
  stress: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  qc: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  runner: { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'none' },
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const ticks = async (n) => {
  for (let i = 0; i < n; i++) await tick()
}
const rj = (obj, exit = 0) => ({ exit, stdout: JSON.stringify(obj) })

async function exec(args, o = {}) {
  if (!existsSync(STAGE_PATH)) throw new Error(`script missing: ${STAGE_PATH}`)
  const body = readFileSync(STAGE_PATH, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const unscripted = []
  const timeline = []
  const counters = {}
  const agent = async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label, i: calls.length }
    calls.push(call)
    await tick()
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      // heavy first: its line holds the inner `factory.ts check` after ` -- `, so match heavy, then read the real command after the cut
      const mh = prompt.match(/factory\.ts\s+heavy\b([^\n`]*)/)
      let m
      if (mh) {
        const cut = mh[1].indexOf(' -- ')
        m = cut >= 0 ? mh[1].slice(cut + 4).match(/factory\.ts\s+(check|integrate|owns-check|tests-check|sync)\b([^\n`]*)/) : null
      } else {
        m = prompt.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync)\b([^\n`]*)/)
      }
      if (!m) {
        unscripted.push(`${opts.label} (no factory.ts command in prompt)`)
        throw new Error(`unparsable runner prompt for label ${opts.label}`)
      }
      const cmd = m[1]
      const flag = (name) => (m[2].match(new RegExp(`--${name}\\s+([^\\s\`]+)`)) || [])[1]
      const slug = flag('slug')
      const expect = flag('expect')
      const branch = flag('branch')
      const key = cmd === 'check' ? `check:${expect}` : cmd === 'integrate' ? `integrate:${branch}` : cmd
      const name = `runner:${slug}:${key}`
      const heavy = !!mh
      call.runner = { cmd, slug, expect, branch, key, name, heavy }
      const n = (counters[name] = (counters[name] ?? -1) + 1)
      timeline.push(`start:${name}`)
      let out = o.runner ? await o.runner({ cmd, key, slug, expect, branch, n, prompt, call, heavy }) : undefined
      if (out === undefined) {
        const plain = expect === 'red' ? { ok: true } : { ok: true, head: HEAD }
        out =
          cmd === 'admit' ? rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 }) : cmd === 'reap' ? rj({ reaped: [], skipped: [] }) : cmd === 'check' ? rj(heavy ? { ...plain, heavy: { label: `${slug}-check`, waitedMs: 0, exit: 0 } } : plain) : cmd === 'integrate' ? rj({ merged: true }) : cmd === 'owns-check' ? rj({ ok: true, outside: [] }) : cmd === 'tests-check' ? rj({ ok: true, tests: [] }) : rj({ merged: true })
      }
      await ticks(cmd === 'integrate' ? 3 : 1)
      timeline.push(`end:${name}`)
      return out
    }
    const labels = o.labels ?? {}
    if (!Object.hasOwn(labels, opts.label)) {
      unscripted.push(String(opts.label))
      throw new Error(`unscripted label: ${opts.label}`)
    }
    timeline.push(`start:${opts.label}`)
    const h = labels[opts.label]
    let v
    try {
      v = typeof h === 'function' ? await h(call, calls) : h
    } finally {
      await ticks(2)
      timeline.push(`end:${opts.label}`)
    }
    return v === null || v === undefined ? v : structuredClone(v)
  }
  const parallel = async (thunks) => Promise.all(thunks.map(async (th) => { try { return await (typeof th === 'function' ? th() : th) } catch { return null } }))
  const pipeline = async (items, ...stages) =>
    Promise.all(items.map(async (item, i) => {
      try {
        let prev = item
        for (const s of stages) prev = await s(prev, item, i)
        return prev
      } catch {
        return null
      }
    }))
  let result
  let error
  try {
    result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, () => {}, () => {}, structuredClone(args), {})
  } catch (e) {
    error = e
  }
  // admit and reap are their own runner calls around every non-runner spawn; `labels` and `timeline` leave them out
  const isAR = (c) => c.runner?.cmd === 'admit' || c.runner?.cmd === 'reap'
  const arNames = new Set(calls.filter(isAR).map((c) => c.runner.name))
  const notAR = (e) => !arNames.has(e.replace(/^(start|end):/, ''))
  return { result, error, calls, unscripted, timeline: timeline.filter(notAR), allTimeline: timeline, labels: calls.filter((c) => !isAR(c)).map((c) => c.label), allLabels: calls.map((c) => c.label) }
}

const HEAD = 'a1'.repeat(20)
const BASE = 'd4'.repeat(20)
const PASS = `VERDICT: PASS\n\n## Proof checked\nHead: ${HEAD}\nPatch: ${'e5'.repeat(20)}\n`
const T1 = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], reads: ['src/a.ts'], brief: 'BRIEF-T1: write the tests for a', after: [] }
const B1 = { name: 'build-it', role: 'builder', effort: 'medium', files: ['src/a.ts'], reads: ['tests/a.check.ts'], brief: 'BRIEF-B1: build a', after: ['write-tests'] }
const done = (branch, proof = 'PROOF-' + branch) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof, text: 'finished ' + branch })
const entry = (slug = 'a') => ({
  slug, stage: 1, goalFile: `/proj/.truss/goals/${slug}.md`, goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE-VERBATIM: build a, nothing else',
  worktree: `/wt/${slug}`, branch: `truss/${slug}`, base: BASE, architecture: '/proj/docs/ARCH.md', adrs: ['/proj/docs/adr/0001-x.md'],
  resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {},
})
const base = (slug = 'a') => ({
  [`${slug}-planner`]: { tasks: [T1, B1], stop: null }, [`${slug}-tester`]: done('feat/t', 'PROOF-T'), [`${slug}-builder`]: done('feat/b', 'PROOF-B'), [`${slug}-qc`]: PASS,
})
async function runStage(crews, o = {}) {
  const args = { truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: PLUGIN, target: 'main', reworkAllowance: 2, roles: ROLES, scriptPath: STAGE_PATH, crews } }
  const r = await exec(args, o)
  assert.deepEqual(r.unscripted, [], `unscripted label(s): ${r.unscripted.join(', ')}`)
  if (r.error) throw r.error
  r.res = r.result
  return r
}
const stopped = (r, tag, at) => {
  assert.equal(r.state, 'stopped', JSON.stringify(r))
  assert.equal(r.tag, tag, JSON.stringify(r))
  assert.equal(r.at, at, JSON.stringify(r))
  assert.equal(typeof r.text, 'string')
}
const has = (s, sub) => assert.ok(s.includes(sub), `missing ${JSON.stringify(sub)} in:\n${s.slice(0, 2500)}`)
const lacks = (s, sub) => assert.ok(!s.includes(sub), `unexpected ${JSON.stringify(sub)} in:\n${s.slice(0, 2500)}`)
const greenSeq = (...rs) => ({ key, n }) => (key === 'check:green' ? rs[Math.min(n, rs.length - 1)] : undefined)
const fixers = { 'a-builder-2': done('feat/f1'), 'a-builder-3': done('feat/f2'), 'a-builder-4': done('feat/f3'), 'a-rca': 'RCA-DIAGNOSIS-MARK' }

const hit = (tag) => ({ id: `kp-${tag}-${hex()}`, fix: `install the thing ${tag}-${hex()}`, line: `hit line ${hex()}` })
const known = (h) => `known problem ${h.id}: ${h.fix}`

describe('stage.js: known problem text from check output', () => {
  st('a red check with env and a catalog hit stops BLOCKED at red with `known problem <id>: <fix>`', async () => {
    const h = hit('red')
    const r = await runStage([entry('a')], { labels: base(), runner: ({ key }) => (key === 'check:red' ? rj({ ok: false, exit: 1, env: `ENV-${hex()}`, catalog: [h] }, 1) : undefined) })
    stopped(r.res[0], 'BLOCKED', 'red')
    has(r.res[0].text, known(h))
    assert.deepEqual(r.labels, ['a-runner'], 'whether the crew stops is unchanged: no planner ran')
  })

  st('a red stop with two catalog hits names each one', async () => {
    const h1 = hit('one')
    const h2 = hit('two')
    const r = await runStage([entry('a')], { labels: base(), runner: ({ key }) => (key === 'check:red' ? rj({ ok: false, exit: 1, env: `ENV-${hex()}`, catalog: [h1, h2] }, 1) : undefined) })
    stopped(r.res[0], 'BLOCKED', 'red')
    has(r.res[0].text, known(h1))
    has(r.res[0].text, known(h2))
  })

  st('a green check with env and a catalog hit stops BLOCKED at green with `known problem <id>: <fix>`, no fix builder', async () => {
    const h = hit('green')
    const failing = rj({ ok: false, tail: `TAIL-${hex()}`, env: `ENV-${hex()}`, catalog: [h] }, 1)
    const r = await runStage([entry('a')], { labels: { ...base(), ...fixers }, runner: greenSeq(failing) })
    stopped(r.res[0], 'BLOCKED', 'green')
    has(r.res[0].text, known(h))
    assert.equal(r.timeline.filter((e) => e === 'start:runner:a:check:green').length, 1)
    assert.ok(!r.labels.includes('a-builder-2') && !r.labels.includes('a-rca'), 'env still decides: no fix builder')
  })

  st('a green failure with a catalog hit and no env passes `known problem <id>: <fix>` into the fix builder prompt', async () => {
    const h1 = hit('fixa')
    const h2 = hit('fixb')
    const failing = rj({ ok: false, tail: `TAIL-${hex()}`, catalog: [h1, h2] }, 1)
    const r = await runStage([entry('a')], { labels: { ...base(), ...fixers }, runner: greenSeq(failing, rj({ ok: true, head: HEAD })) })
    const fb = r.calls.find((c) => c.label === 'a-builder-2')
    assert.ok(fb, 'a fix builder ran: env did not decide')
    has(fb.prompt, known(h1))
    has(fb.prompt, known(h2))
    assert.equal(r.res[0].state, 'passed', JSON.stringify(r.res[0]))
  })

  st('a body without catalog puts no `known problem` text anywhere: red stop, green stop and fix builder prompt', async () => {
    const envRed = await runStage([entry('a')], { labels: base(), runner: ({ key }) => (key === 'check:red' ? rj({ ok: false, exit: 1, env: `ENV-${hex()}` }, 1) : undefined) })
    stopped(envRed.res[0], 'BLOCKED', 'red')
    lacks(envRed.res[0].text, 'known problem')
    const envGreen = await runStage([entry('a')], { labels: { ...base(), ...fixers }, runner: greenSeq(rj({ ok: false, tail: 'T', env: `ENV-${hex()}` }, 1)) })
    stopped(envGreen.res[0], 'BLOCKED', 'green')
    lacks(envGreen.res[0].text, 'known problem')
    const fixed = await runStage([entry('a')], { labels: { ...base(), ...fixers }, runner: greenSeq(rj({ ok: false, tail: `TAIL-${hex()}` }, 1), rj({ ok: true, head: HEAD })) })
    for (const c of fixed.calls) lacks(c.prompt, 'known problem')
    assert.equal(fixed.res[0].state, 'passed')
  })
})
