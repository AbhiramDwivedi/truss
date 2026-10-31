// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0012 Decisions 9 and 10 (Seams: factory doctor, check's `catalog` key, finish's extract write).
// Written from the ADR and docs/*.schema.json before `factory.ts doctor` and retro/ exist.
//
// Run with: node --test tests/doctor-contract.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs.
//
// Gameability (plan-retro-judge.md, checker-7): every name, rule, download, ruling and planted token is generated per run, so a
// doctor that prints a fixed answer, or one that ignores `needs`, fails the name and bundle assertions; a finish that writes an
// empty extract fails the planted-token assertions. The catalog is read from retro/catalog.json at run time and a missing
// catalog fails its own cases; nothing from retro/ is imported, so a missing retro/ never crashes the file before the
// `producer missing: factory doctor` cases run.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { REAL_PLUGIN, appendEvent, assertOneLine, crew, factorySpawn, git, mkEnv, mkRun, planObj, tmp, writePlan } from './fixtures/workflow-run/harness.ts'

const CFG = { merge: 'sequential', target: 'main' }
const FINISH_KEYS = ['merged', 'rework', 'blocked', 'refused', 'audit', 'incomplete', 'stopped']
const hex = (): string => randomBytes(4).toString('hex')
const dirListing = (d: string): string[] => (existsSync(d) ? readdirSync(d, { recursive: true }).map(String).sort() : [])

// ---------- the catalog, read at run time ----------

const CATALOG_PATH = `${REAL_PLUGIN}/retro/catalog.json`
function catalogEntries(): any[] {
  let text: string
  try {
    text = readFileSync(CATALOG_PATH, 'utf8')
  } catch {
    assert.fail('producer missing: retro/catalog.json')
  }
  const c = JSON.parse(text)
  assert.equal(c.v, 1, 'catalog v')
  assert.ok(Array.isArray(c.entries) && c.entries.length > 0, 'catalog has entries')
  return c.entries
}
// ADR-0012 Decision 3: a line hits an entry when it holds the anchor literally and at least one pattern (no flags) matches it.
const hits = (e: any, line: string): boolean => line.includes(e.anchor) && e.patterns.some((p: string) => new RegExp(p).test(line))

// Realistic lines for the seed ids (ADR-0012 Decision 3); a hit is tried on each until the entry's own patterns accept one.
const SAMPLES: Record<string, string[]> = {
  'webkit-host-libs': [
    'error while loading shared libraries: libicudata.so.66: cannot open shared object file: No such file or directory',
    'Host system is missing dependencies to run browsers. Missing libraries: libicudata.so.74',
    '  libicudata.so.74 => not found',
    'browserType.launch: Target page, context or browser has been closed (libicudata.so.74)',
  ],
  'settings-local-not-in-worktrees': [
    "Error: ENOENT: no such file or directory, open '/repo/.claude/worktrees/truss-x/.claude/settings.local.json'",
    '.claude/settings.local.json is not in the worktree, so the allow rules did not apply',
    'Permission to use Bash has been denied: settings.local.json is untracked and missing in this worktree',
    'settings.local.json is not committed, so a worktree does not see it',
  ],
  'worktree-guard-shell-shape': [
    "This session is isolated in the worktree /repo/.claude/worktrees/x but this command cd's into /repo. Refusing to run it",
    'This session is isolated in the worktree /repo/.claude/worktrees/x but its working directory is /repo. Refusing to run it',
    'This session is isolated in the worktree /w but this command uses a heredoc it cannot show stays inside. Refusing to run it',
  ],
  'harness-only-claude-code': [
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'claude-code' imported from /repo/tests/x.check.ts",
    "Cannot find package 'claude-code' imported from /repo/hooks/register.ts",
  ],
  'node-modules-missing': [
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express' imported from /repo/ui/server/index.ts",
    "Cannot find package 'zod' imported from /repo/ui/server/state.ts",
  ],
  'tracked-pyc': [
    '\ttests/__pycache__/retro.cpython-312.pyc',
    '?? tests/__pycache__/',
    ' M tests/__pycache__/retro.cpython-312.pyc',
    'Untracked files: tests/__pycache__/x.pyc',
  ],
}

/** A line that hits entry `e`: a realistic sample (or the bare anchor) with a per-run token on its end when that still hits. */
function lineFor(e: any, token: string): { line: string; tokened: boolean } | undefined {
  const cands = [...(SAMPLES[e.id] ?? []), e.anchor, `${e.anchor} failed`]
  for (const c of cands) {
    if (hits(e, `${c} ${token}`)) return { line: `${c} ${token}`, tokened: true }
    if (hits(e, `${token} ${c}`)) return { line: `${token} ${c}`, tokened: true }
    if (hits(e, c)) return { line: c, tokened: false }
  }
  return undefined
}

// ---------- doctor ----------

/** Runs doctor; a missing command (or any answer that is no doctor body) fails as `producer missing: factory doctor`. */
function doctor(env: any, flags: Record<string, unknown> = {}, extra: string[] = []): { res: any; j: any } {
  const res = env.run('doctor', flags, extra)
  const j = res.json
  if (j === undefined || j === null || !Array.isArray(j.probes)) {
    assert.fail(`producer missing: factory doctor (exit ${res.status}; stdout ${res.stdout.slice(0, 200)}; stderr ${res.stderr.slice(0, 200)})`)
  }
  return { res, j }
}

/** A catalog file for --catalog: entries are [{id, fix, probe?}]. */
function writeCatalog(entries: { id: string; fix: string; probe?: unknown }[]): string {
  const p = `${tmp('doctor-cat-')}/catalog.json`
  const body = entries.map((e) => ({ id: e.id, kind: 'friction', title: `title ${e.id}`, anchor: `anchor-${e.id}`, patterns: [`anchor-${e.id}`], fix: e.fix, ...(e.probe === undefined ? {} : { probe: e.probe }), fixedBy: null }))
  writeFileSync(p, JSON.stringify({ v: 1, entries: body }, null, 2) + '\n')
  return p
}

/** One world with two crews holding needs, every name generated per run. */
function needsWorld() {
  const env = mkEnv({ config: CFG, useRealPlugin: true })
  const t = hex()
  const w = {
    env, t,
    crewA: `crew-a-${t}`, crewB: `crew-b-${t}`,
    cmdPass: `cmd-pass-${t}`, cmdFail: `cmd-fail-${t}`, filePass: `file-pass-${t}`, fileFail: `file-fail-${t}`,
    sharedAllow: `Bash(shared-${t}:*)`, allowFail: `Bash(failing-${t}:*)`, allowFile: `Bash(filefail-${t}:*)`,
    dlCmd: `npx fetch-cmd-${t}`, dlFile: `npx fetch-file-${t}`, dlNever: `npx never-needed-${t}`,
    missing: `no/such/path-${t}`, marker: `marker-${t}`,
  }
  writePlan(env.dir, planObj([
    crew(w.crewA, { needs: [
      { id: w.cmdPass, why: 'passes', probe: { kind: 'command', run: 'test -f README.md' }, allow: [w.sharedAllow], download: w.dlNever },
      { id: w.cmdFail, why: 'fails', probe: { kind: 'command', run: `echo ${w.marker}; exit 3` }, allow: [w.allowFail, w.sharedAllow], download: w.dlCmd },
    ] }),
    crew(w.crewB, { stage: 2, needs: [
      { id: w.filePass, why: 'passes', probe: { kind: 'file', path: 'README.md' }, allow: [w.sharedAllow] },
      { id: w.fileFail, why: 'fails', probe: { kind: 'file', path: w.missing }, allow: [w.allowFile], download: w.dlFile },
    ] }),
  ], { version: 3 }))
  return w
}

describe('factory.ts doctor: needs and the bundle', () => {
  test('names each failing probe per run, with detail, and splits passed from failed', () => {
    const w = needsWorld()
    const cat = writeCatalog([])
    const { res, j } = doctor(w.env, {}, ['--catalog', cat])
    assert.equal(res.status, 1, 'a failing need refuses (exit 1)')
    assert.equal(j.ok, false)
    const names = j.probes.map((p: any) => p.name)
    assert.deepEqual(names.sort(), [`${w.crewA}/${w.cmdFail}`, `${w.crewA}/${w.cmdPass}`, `${w.crewB}/${w.fileFail}`, `${w.crewB}/${w.filePass}`].sort())
    assert.deepEqual([...j.failed].sort(), [`${w.crewA}/${w.cmdFail}`, `${w.crewB}/${w.fileFail}`].sort())
    assert.deepEqual([...j.passed].sort(), [`${w.crewA}/${w.cmdPass}`, `${w.crewB}/${w.filePass}`].sort())
    const by = (n: string) => j.probes.find((p: any) => p.name === n)
    assert.deepEqual([by(`${w.crewA}/${w.cmdFail}`).kind, by(`${w.crewA}/${w.cmdFail}`).pass], ['command', false])
    assert.deepEqual([by(`${w.crewA}/${w.cmdPass}`).kind, by(`${w.crewA}/${w.cmdPass}`).pass], ['command', true])
    assert.deepEqual([by(`${w.crewB}/${w.fileFail}`).kind, by(`${w.crewB}/${w.fileFail}`).pass], ['file', false])
    assert.deepEqual([by(`${w.crewB}/${w.filePass}`).kind, by(`${w.crewB}/${w.filePass}`).pass], ['file', true])
    assert.ok(by(`${w.crewA}/${w.cmdFail}`).detail.includes(w.marker), `detail is the first line of output: ${by(`${w.crewA}/${w.cmdFail}`).detail}`)
    assert.ok(by(`${w.crewB}/${w.fileFail}`).detail.includes(w.missing), 'detail is the missing path')
  })

  test('the bundle: every need allow rule once in first-seen order, downloads of failed needs only, no rulings without a failing catalog probe', () => {
    const w = needsWorld()
    const { j } = doctor(w.env, {}, ['--catalog', writeCatalog([])])
    assert.deepEqual(j.bundle.allow, [w.sharedAllow, w.allowFail, w.allowFile], 'allow rules of failed and passed needs, deduplicated')
    assert.deepEqual(j.bundle.downloads, [w.dlCmd, w.dlFile], 'only a failed probe contributes its download')
    assert.ok(!j.bundle.downloads.includes(w.dlNever))
    assert.deepEqual(j.bundle.rulings, [])
  })

  test('a catalog probe that fails puts its id and fix in the bundle rulings, and alone it does not refuse', () => {
    const env = mkEnv({ config: CFG, useRealPlugin: true })
    const t = hex()
    const crewSlug = `crew-${t}`
    writePlan(env.dir, planObj([crew(crewSlug, { needs: [{ id: `ok-${t}`, why: 'passes', probe: { kind: 'command', run: 'true' } }] })], { version: 3 }))
    const failId = `known-fail-${t}`
    const passId = `known-pass-${t}`
    const fix = `standing ruling ${t}`
    const cat = writeCatalog([
      { id: failId, fix, probe: { kind: 'command', run: 'exit 1' } },
      { id: passId, fix: `never shown ${t}`, probe: { kind: 'command', run: 'true' } },
      { id: `noprobe-${t}`, fix: `no probe ${t}` },
    ])
    const { res, j } = doctor(env, {}, ['--catalog', cat])
    assert.equal(res.status, 0, 'a failing catalog probe alone does not refuse')
    assert.deepEqual(j.bundle.rulings, [{ id: failId, fix }])
    assert.deepEqual(j.known.find((k: any) => k.id === failId), { id: failId, pass: false })
    assert.deepEqual(j.known.find((k: any) => k.id === passId), { id: passId, pass: true })
    assert.deepEqual(j.failed, [], 'catalog probes are not in the needs failed list')
  })

  test('without --catalog the plugin catalog is used: known holds an entry for each probed catalog entry and tracked-pyc passes in a clean repo', () => {
    const entries = catalogEntries()
    const env = mkEnv({ config: CFG, useRealPlugin: true })
    writePlan(env.dir, planObj([crew(`c-${hex()}`)], { version: 3 }))
    const { res, j } = doctor(env)
    assert.equal(res.status, 0)
    const probed = entries.filter((e) => e.probe !== undefined).map((e) => e.id)
    assert.ok(probed.includes('tracked-pyc'), 'the catalog seeds tracked-pyc with a probe')
    assert.deepEqual(j.known.map((k: any) => k.id).filter((id: string) => probed.includes(id)).sort(), [...probed].sort())
    assert.equal(j.known.find((k: any) => k.id === 'tracked-pyc').pass, true, 'a temp repo tracks no .pyc file')
  })

  test('tracked-pyc probe fails in a repo that tracks a .pyc file, and the bundle carries that entry fix', () => {
    const entries = catalogEntries()
    const pyc = entries.find((e) => e.id === 'tracked-pyc')
    assert.ok(pyc, 'the catalog seeds tracked-pyc')
    const env = mkEnv({ config: CFG, useRealPlugin: true, files: { [`pkg-${hex()}/__pycache__/m.cpython-312.pyc`]: 'x\n' } })
    writePlan(env.dir, planObj([crew(`c-${hex()}`)], { version: 3 }))
    const { res, j } = doctor(env)
    assert.equal(res.status, 0, 'a failing catalog probe alone does not refuse')
    assert.equal(j.known.find((k: any) => k.id === 'tracked-pyc').pass, false)
    assert.ok(j.bundle.rulings.some((r: any) => r.id === 'tracked-pyc' && r.fix === pyc.fix))
  })

  test('a plan with no needs anywhere is an empty list: exit 0, empty probe list, empty bundle', () => {
    const env = mkEnv({ config: CFG, useRealPlugin: true })
    writePlan(env.dir, planObj([crew(`a-${hex()}`), crew(`b-${hex()}`, { stage: 2 })], { version: 3 }))
    const { res, j } = doctor(env, {}, ['--catalog', writeCatalog([])])
    assert.equal(res.status, 0)
    assert.equal(j.ok, true)
    assert.deepEqual(j.probes, [])
    assert.deepEqual(j.passed, [])
    assert.deepEqual(j.failed, [])
    assert.deepEqual(j.bundle.allow, [])
    assert.deepEqual(j.bundle.downloads, [])
    assert.deepEqual(j.bundle.rulings, [])
  })

  test('an explicit empty needs list, and a crew without needs beside one that has some, both read as empty', () => {
    const env = mkEnv({ config: CFG, useRealPlugin: true })
    const t = hex()
    const withNeeds = `has-${t}`
    writePlan(env.dir, planObj([
      crew(`none-${t}`),
      crew(`empty-${t}`, { needs: [] }),
      crew(withNeeds, { needs: [{ id: `only-${t}`, why: 'w', probe: { kind: 'command', run: 'true' } }] }),
    ], { version: 3 }))
    const { res, j } = doctor(env, {}, ['--catalog', writeCatalog([])])
    assert.equal(res.status, 0)
    assert.deepEqual(j.probes.map((p: any) => p.name), [`${withNeeds}/only-${t}`])
  })

  test('doctor writes nothing: the truss dir and the repo are as they were', () => {
    const w = needsWorld()
    const before = { dir: dirListing(w.env.dir), repo: dirListing(w.env.repo).filter((p) => !p.startsWith('.git/')), status: git(w.env.repo, ['status', '--porcelain']) }
    const planText = readFileSync(`${w.env.dir}/plan.json`, 'utf8')
    doctor(w.env, {}, ['--catalog', writeCatalog([])])
    assert.deepEqual(dirListing(w.env.dir), before.dir)
    assert.deepEqual(dirListing(w.env.repo).filter((p) => !p.startsWith('.git/')), before.repo)
    assert.equal(git(w.env.repo, ['status', '--porcelain']), before.status)
    assert.equal(readFileSync(`${w.env.dir}/plan.json`, 'utf8'), planText)
  })

  test('a usage error (no --dir) exits 2 with an error that is not "unknown command"', () => {
    const env = mkEnv({ config: CFG, useRealPlugin: true })
    const res = env.run('doctor', { dir: null })
    const j = res.json
    if (res.status !== 2 || j === undefined || typeof j.error !== 'string' || /unknown command/.test(j.error)) {
      assert.fail(`producer missing: factory doctor (usage error expected: exit ${res.status}; stdout ${res.stdout.slice(0, 200)})`)
    }
  })
})

describe('producer missing: factory doctor', () => {
  test('factory.ts has a doctor command', () => {
    const env = mkEnv({ config: CFG, useRealPlugin: true })
    writePlan(env.dir, planObj([crew(`c-${hex()}`)], { version: 3 }))
    const res = env.run('doctor')
    if (/unknown command/.test(res.stdout)) assert.fail(`producer missing: factory doctor (${res.stdout.trim().slice(0, 200)})`)
    assert.ok(res.json && Array.isArray(res.json.probes), `doctor prints a body with probes: ${res.stdout.slice(0, 200)}`)
  })
})

// ---------- check: the catalog key ----------

/** Runs `check` on a crew whose acceptance test prints `line` and exits `exit`; returns the body and the check record. */
function checkWith(line: string, exit: number): { res: any; body: any; record: any } {
  const env = mkEnv({ config: CFG, useRealPlugin: true })
  writeFileSync(`${env.repo}/sample.txt`, line + '\n')
  writePlan(env.dir, planObj([crew('s', { acceptanceTest: `cat sample.txt; exit ${exit}` })], { version: 3 }))
  // expect green: a non-zero exit refuses with the body on stdout, whether or not the line also counts as an environment failure
  const res = env.run('check', { slug: 's', cwd: env.repo, expect: 'green' })
  const body = assertOneLine(res)
  const record = JSON.parse(readFileSync(`${env.dir}/checks/s-1.json`, 'utf8'))
  return { res, body, record }
}

describe('factory.ts check: a catalog hit reports the entry id', () => {
  test('every catalog entry: a failing run whose output holds a hit line names that entry, with its fix and the line', (t) => {
    const entries = catalogEntries()
    for (const e of entries) {
      const token = `tok-${hex()}`
      const made = lineFor(e, token)
      if (made === undefined) {
        assert.ok(!(e.id in SAMPLES), `no realistic line for seed entry ${e.id} hits its own anchor and patterns`)
        t.diagnostic(`skipped ${e.id}: no line built from its anchor hits it`)
        continue
      }
      const { body, record } = checkWith(made.line, 1)
      assert.ok(Array.isArray(body.catalog), `${e.id}: the body gains catalog: ${JSON.stringify(body)}`)
      const hit = body.catalog.find((c: any) => c.id === e.id)
      assert.ok(hit, `${e.id} is reported; got ${JSON.stringify(body.catalog)}`)
      assert.equal(hit.fix, e.fix, `${e.id}: fix`)
      assert.ok(hit.line.length <= 300)
      if (made.tokened) assert.ok(hit.line.includes(token), `${e.id}: line is the first hit line, got ${hit.line}`)
      assert.deepEqual(record.catalog, body.catalog, `${e.id}: the checks/ record carries the same key`)
      assert.equal(body.ok, false)
      assert.equal(body.exit, 1)
    }
  })

  test('a planted second hit line is cut at 300 characters and the first hit line is reported', () => {
    const e = catalogEntries()[0]
    const token = `tok-${hex()}`
    const made = lineFor(e, token)
    assert.ok(made, `a line hits ${e.id}`)
    const { body } = checkWith(`noise ${token}\n${made.line}${'x'.repeat(400)}`, 1)
    const hit = body.catalog?.find((c: any) => c.id === e.id)
    assert.ok(hit, JSON.stringify(body))
    assert.ok(hit.line.length <= 300, 'cut to 300 characters')
    assert.ok(hit.line.startsWith(made.line.slice(0, 20)))
  })

  test('the claude-code seed hits harness-only-claude-code and not node-modules-missing', () => {
    const entries = catalogEntries()
    const harness = entries.find((e) => e.id === 'harness-only-claude-code')
    const modules = entries.find((e) => e.id === 'node-modules-missing')
    assert.ok(harness && modules, 'both seeds are in the catalog')
    const made = lineFor(harness, `tok-${hex()}`)
    assert.ok(made, 'a claude-code line hits harness-only-claude-code')
    const { body } = checkWith(made.line, 1)
    const ids = (body.catalog ?? []).map((c: any) => c.id)
    assert.ok(ids.includes('harness-only-claude-code'), JSON.stringify(body.catalog))
    assert.ok(!ids.includes('node-modules-missing'), 'a negative lookahead keeps the claude-code line out of node-modules-missing')
  })

  test('no hit, no key: a failing run with a clean line gains no catalog key, in the body or the record', () => {
    const { body, record } = checkWith(`plain assertion failure ${hex()}`, 1)
    assert.equal(body.ok, false)
    assert.ok(!('catalog' in body), JSON.stringify(body))
    assert.ok(!('catalog' in record), JSON.stringify(record))
  })

  test('a passing run (exit 0) with a hit line gains no catalog key', () => {
    const e = catalogEntries()[0]
    const made = lineFor(e, `tok-${hex()}`)
    assert.ok(made, `a line hits ${e.id}`)
    const env = mkEnv({ config: CFG, useRealPlugin: true })
    writeFileSync(`${env.repo}/sample.txt`, made.line + '\n')
    writePlan(env.dir, planObj([crew('s', { acceptanceTest: 'cat sample.txt; exit 0' })], { version: 3 }))
    const res = env.run('check', { slug: 's', cwd: env.repo, expect: 'green' })
    const body = assertOneLine(res)
    assert.equal(res.status, 0)
    assert.equal(body.ok, true)
    assert.ok(!('catalog' in body), JSON.stringify(body))
  })
})

// ---------- finish: the extract ----------

/** A finish world: a session dir `<project>/<session>/subagents/workflows/wf_1` holding one crew's builder agent, plus the crew `s`
 * running with an old spawn line (so the liveness rule passes). `plant` lines are appended to the builder's transcript as records. */
function finishWorld(plant: (agentFile: string, id: string) => void) {
  const env = mkEnv({ config: CFG, useRealPlugin: true })
  const project = tmp('doctor-proj-')
  const session = `sess-${hex()}`
  const workflows = `${project}/${session}/subagents/workflows`
  mkdirSync(workflows, { recursive: true })
  writeFileSync(`${project}/${session}.jsonl`, JSON.stringify({ type: 'user', message: { role: 'user', content: 'main' }, timestamp: '2026-10-29T09:00:00.000Z' }) + '\n')
  writePlan(env.dir, planObj([crew('s', { status: 'running' })], { approvedAt: '2026-10-01T00:00:00.000Z', version: 3 }))
  appendEvent(env.dir, factorySpawn('s', new Date(Date.now() - 3 * 3600_000).toISOString()))
  const run = mkRun(workflows, 'wf_1', [{ label: 's-builder', agentType: 'general-purpose', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', result: 'built it' }])
  const id = run.ids['s-builder']
  const agentFile = `${run.dir}/agent-${id}.jsonl`
  plant(agentFile, id)
  // planting touched the transcript: age it again, or the liveness rule (a run touched within the stale window may be live) refuses
  const old = Date.parse('2026-10-29T10:01:00.000Z') / 1000
  for (const p of [agentFile, run.dir]) utimesSync(p, old, old)
  const extractPath = `${env.dir}/retro/extract.json`
  return { env, session, run, id, agentFile, extractPath, finish: () => env.run('finish', { transcript: run.dir }) }
}

const toolErrorRecord = (id: string, text: string): string =>
  JSON.stringify({ parentUuid: null, isSidechain: true, agentId: id, type: 'user', timestamp: '2026-10-29T10:00:30.000Z', userType: 'external', entrypoint: 'cli',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', is_error: true, content: text }] } }) + '\n'

describe('factory.ts finish: the extract', () => {
  test('writes <truss dir>/retro/extract.json holding a token planted in this run, as a toolError quote, with the file listed', () => {
    const token = `planted-${hex()}-${hex()}`
    const w = finishWorld((f, id) => appendFileSync(f, toolErrorRecord(id, `Error: boom ${token}\nsecond line`)))
    const res = w.finish()
    const body = assertOneLine(res)
    assert.deepEqual(Object.keys(body), FINISH_KEYS, 'finish keeps exactly its keys')
    assert.ok(existsSync(w.extractPath), `finish writes ${w.extractPath}; stdout ${res.stdout.slice(0, 200)}`)
    const text = readFileSync(w.extractPath, 'utf8')
    assert.ok(text.endsWith('\n') && text.startsWith('{\n'), 'JSON.stringify(x, null, 2) + newline')
    assert.ok(text.includes(token), 'the planted token is in the extract')
    const x = JSON.parse(text)
    assert.equal(x.v, 1)
    assert.equal(x.session, w.session)
    const item = x.items.find((i: any) => i.kind === 'toolError' && i.quote.includes(token))
    assert.ok(item, `a toolError item quotes the token: ${JSON.stringify(x.items).slice(0, 300)}`)
    assert.ok(item.quote.length <= 200)
    const rel = `${w.session}/subagents/workflows/wf_1/agent-${w.id}.jsonl`
    assert.ok(x.files.some((f: any) => f.path === rel), `files lists ${rel}: ${JSON.stringify(x.files)}`)
    assert.equal(item.file, rel)
    const lines = readFileSync(w.agentFile, 'utf8').split('\n').filter(Boolean).length
    assert.equal(item.line, lines, 'the item cites the planted record by its 1-based line')
    assert.equal(x.files.find((f: any) => f.path === rel).lines, lines)
    assert.ok(x.files.some((f: any) => f.path === `${w.session}/subagents/workflows/wf_1/journal.jsonl`), 'the journal is read')
    assert.ok(x.files.some((f: any) => f.path === `${w.session}.jsonl`), 'the session transcript is read')
  })

  test('a catalog hit line planted in a tool result lands in catalogHits with the entry id and the token', () => {
    const entries = catalogEntries()
    const e = entries.find((x) => x.id === 'webkit-host-libs') ?? entries[0]
    const token = `tok-${hex()}`
    const made = lineFor(e, token)
    assert.ok(made, `a line hits ${e.id}`)
    const w = finishWorld((f, id) => appendFileSync(f, toolErrorRecord(id, `before\n${made.line}\nafter`)))
    w.finish()
    assert.ok(existsSync(w.extractPath), `finish writes ${w.extractPath}`)
    const x = JSON.parse(readFileSync(w.extractPath, 'utf8'))
    const hit = x.catalogHits.find((h: any) => h.id === e.id && h.quote.includes(token))
    assert.ok(hit, `catalogHits names ${e.id}: ${JSON.stringify(x.catalogHits).slice(0, 300)}`)
    assert.equal(hit.file, `${w.session}/subagents/workflows/wf_1/agent-${w.id}.jsonl`)
  })

  test('finish is idempotent: a second run leaves the same bytes and the same body', () => {
    const token = `planted-${hex()}`
    const w = finishWorld((f, id) => appendFileSync(f, toolErrorRecord(id, `Error: ${token}`)))
    const first = w.finish()
    assert.ok(existsSync(w.extractPath), `finish writes ${w.extractPath}`)
    const a = readFileSync(w.extractPath, 'utf8')
    assert.ok(a.includes(token))
    const second = w.finish()
    assert.equal(readFileSync(w.extractPath, 'utf8'), a, 'same bytes')
    assert.equal(second.stdout, first.stdout)
  })

  test('a transcript line that is not JSON is counted under skipped.json and does not stop the extract', () => {
    const token = `planted-${hex()}`
    const w = finishWorld((f, id) => {
      appendFileSync(f, `not json ${hex()}\n`)
      appendFileSync(f, toolErrorRecord(id, `Error: ${token}`))
    })
    w.finish()
    assert.ok(existsSync(w.extractPath), `finish writes ${w.extractPath}`)
    const x = JSON.parse(readFileSync(w.extractPath, 'utf8'))
    assert.ok(x.skipped.json >= 1, JSON.stringify(x.skipped))
    assert.ok(JSON.stringify(x.items).includes(token))
  })
})
