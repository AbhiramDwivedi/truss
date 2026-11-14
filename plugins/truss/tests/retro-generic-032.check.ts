// Truss 0.32.0 retro-generic acceptance test (ADR-0051, R-128..R-130, R-147, R-148). The counting step `problems()` in retro/counts.ts
// ranks findings by measured cost, keeps any category and reads no transcript; retro/cli.ts parses the judge's findings and the triage
// lines; a rubric grader in code grades a recording of the judge and triage on the scrubbed wave-4 fixture. The titles are pinned by
// the crew's acceptance command, so do not reword one. Fixtures are built in mkdtemp dirs; the default suite needs only node and git.
// Contracts this test pins that ADR-0051 leaves open (a builder follows them, or amends the test with a reason):
//   parseFindings(report, measures) returns {kept: [{n, finding}], dropped: [{n, reason}]}, as before the ADR.
//   parseTriage(text, findings) returns {decisions: [{id, decision, reason}], fixGoal: [id], proposedGoals: [id], dropped: [{line, reason}]}.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as cli from '../retro/cli.ts'
import * as counts from '../retro/counts.ts'
import { analyze } from '../retro/timing.ts'
import { citationDocs, lineCitations } from './fixtures/citations/line-citations.ts'
import { loadWave4 } from './fixtures/retro-generic/load.ts'
import { makeNonTruss } from './fixtures/retro-generic/non-truss.ts'
import { findingBlocks, grade } from './fixtures/retro-generic/rubric.ts'
import { makeSizeFixture, SIZE_CREWS, SIZE_EVENTS, SIZE_USAGE, TRANSCRIPT_FILES, TRANSCRIPT_MIN_BYTES } from './fixtures/retro-generic/size-fixture.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const MIN = 60000
type Json = Record<string, any>

const KINDS = ['plugin', 'project-config', 'proposed-goal']
const SIX = ['time', 'code structure', 'tests', 'quality loop', 'rules and gates', 'cost']

// the counting step, through a namespace import so a missing export fails its own case with a clear symptom
const problemsOf = (dir: string): Json => {
  assert.equal(typeof (counts as Json).problems, 'function', 'retro/counts.ts does not export problems()')
  return (counts as Json).problems(dir)
}
const cliFn = (name: string): ((...a: any[]) => any) => {
  assert.equal(typeof (cli as Json)[name], 'function', `retro/cli.ts does not export ${name}()`)
  return (cli as Json)[name]
}

let W: ReturnType<typeof loadWave4> | undefined
let P4: Json | undefined
const wave4 = (): ReturnType<typeof loadWave4> => (W ??= loadWave4())
const wave4Problems = (): Json => (P4 ??= problemsOf(wave4().dir))
after(() => W?.cleanup())

// ADR-0051 Decision 3: wallMs descending (null last), then tokens descending (null last), then id
const desc = (a: number | null, b: number | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a)
const rankCmp = (a: Json, b: Json): number => desc(a.cost.wallMs, b.cost.wallMs) || desc(a.cost.tokens, b.cost.tokens) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const isRanked = (fs: Json[]): boolean => fs.every((f, i) => i === 0 || rankCmp(fs[i - 1]!, f) <= 0)

/** Why one finding of the counting step breaks the shape of ADR-0051 Decision 2 against `measures`, or null. */
const shapeProblem = (f: Json, measures: Record<string, number>): string | null => {
  if (typeof f.id !== 'string' || f.id === '') return 'id is not a non-empty string'
  if (typeof f.category !== 'string' || f.category === '') return 'category is not a non-empty string'
  if (typeof f.title !== 'string' || f.title === '') return 'title is not a non-empty string'
  if (!Array.isArray(f.evidence) || f.evidence.length === 0) return 'no evidence'
  for (const e of f.evidence) {
    if (!Object.hasOwn(measures, e.measure)) return `evidence measure ${e.measure} is not a key of measures`
    if (!Number.isFinite(e.value) || e.value !== measures[e.measure]) return `evidence ${e.measure} is ${e.value}, measures has ${measures[e.measure]}`
  }
  const c = f.cost
  if (!c || typeof c !== 'object' || !['wallMs', 'tokens', 'usd'].every((k) => c[k] === null || Number.isFinite(c[k]))) return 'cost is not {wallMs, tokens, usd} of numbers or null'
  if (c.wallMs === null && c.tokens === null && c.usd === null) return 'cost has no number'
  if (typeof f.fix !== 'string' || f.fix.trim() === '') return 'fix is empty'
  if (!f.target || !KINDS.includes(f.target.kind)) return `target.kind ${f.target?.kind} is not one of ${KINDS.join(', ')}`
  return null
}

/** A small truss dir, built like timing-031's fixtures: one crew that runs six hours on many tokens, one with a short slot wait. */
function rankDir(): string {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'retro-rank-')))
  const T0 = Date.parse('2026-11-12T00:00:00Z')
  const at = (min: number): string => new Date(T0 + min * MIN).toISOString()
  for (const sub of ['reports/small', 'answers']) mkdirSync(path.join(d, sub), { recursive: true })
  const ev: Json[] = []
  for (const c of ['big', 'small']) ev.push({ v: 1, ts: at(0), event: 'spawn', crew: c, agent: c, agentId: null, type: 'workflow-crew', model: 'opus', effort: 'medium', by: 'factory' })
  ev.push({ v: 1, ts: at(1), event: 'spawn', crew: 'big', agent: 'big-builder', agentId: 'g1', type: 'kit:builder', model: 'opus', effort: 'medium', by: 'workflow:wf_1' })
  ev.push({ v: 1, ts: at(1), event: 'spawn', crew: 'small', agent: 'small-runner', agentId: 's1', type: 'general-purpose', model: 'sonnet', effort: 'medium', by: 'workflow:wf_1' })
  ev.push({ v: 1, ts: at(400), event: 'tag', crew: 'big', agent: 'big', tag: 'BLOCKED', run: 'wf_1' })
  ev.push({ v: 1, ts: at(60), event: 'tag', crew: 'small', agent: 'small', tag: 'BLOCKED', run: 'wf_1' })
  writeFileSync(path.join(d, 'events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const rows: Json[] = []
  for (let m = 2; m <= 360; m += 6) rows.push({ v: 1, ts: at(m), sid: 's', agentId: 'g1', model: 'model-a', in: 10, out: 5000, cr: 400000, cw5m: 0, cw1h: 90000 })
  for (const m of [3, 4, 50]) rows.push({ v: 1, ts: at(m), sid: 's', agentId: 's1', model: 'model-a', in: 2, out: 100, cr: 1000, cw5m: 0, cw1h: 100 })
  writeFileSync(path.join(d, 'usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const heavy = JSON.stringify({ ok: true, heavy: { label: 'small-check', waitedMs: 5 * MIN, exit: 0 } }) + '\ntruss-status: {}'
  writeFileSync(path.join(d, 'reports/small/small-runner.md'), JSON.stringify({ exit: 0, stdout: heavy }))
  return d
}

test('counts.ts ranks findings by measured cost, not by category order', () => {
  const real = wave4Problems()
  assert.ok(real.findings.length >= 2, 'the wave-4 fixture gives at least two findings')
  assert.ok(isRanked(real.findings), `wave-4 findings are not in cost order: ${JSON.stringify(real.findings.map((f: Json) => [f.id, f.category, f.cost.wallMs, f.cost.tokens]))}`)
  // category never orders them: some finding comes before another that sits earlier in the checklist
  const idx = real.findings.map((f: Json) => SIX.indexOf(f.category)).filter((i: number) => i >= 0)
  assert.ok(idx.some((a: number, i: number) => idx.slice(i + 1).some((b: number) => a > b)), `the findings follow the checklist order: ${idx.join(',')}`)
  const synthetic = problemsOf(rankDir())
  assert.ok(synthetic.findings.length >= 1, 'the synthetic dir gives a finding')
  assert.ok(isRanked(synthetic.findings), `synthetic findings are not in cost order: ${JSON.stringify(synthetic.findings.map((f: Json) => [f.id, f.category, f.cost]))}`)
  // a finding that costs more wall-clock than a time finding comes before it, whatever its category
  const t = synthetic.findings.filter((f: Json) => f.category === 'time' && f.cost.wallMs !== null)
  const o = synthetic.findings.filter((f: Json) => f.category !== 'time' && f.cost.wallMs !== null)
  for (const a of t) for (const b of o) if (b.cost.wallMs > a.cost.wallMs) assert.ok(synthetic.findings.indexOf(b) < synthetic.findings.indexOf(a), `${b.id} (${b.category}) costs more than ${a.id} (time) but is listed after it`)
})

test('every finding counts.ts emits carries counted evidence, its cost, a proposed fix and a target', () => {
  for (const [name, p] of [['wave-4', wave4Problems()], ['synthetic', problemsOf(rankDir())]] as [string, Json][]) {
    assert.equal(p.retro, 2, `${name}: retro is 2`)
    assert.ok(p.measures && typeof p.measures === 'object', `${name}: measures is an object`)
    for (const [k, v] of Object.entries(p.measures)) assert.ok(Number.isFinite(v), `${name}: measure ${k} is not a finite number`)
    assert.ok(p.findings.length > 0, `${name}: no findings`)
    const ids = new Set<string>()
    for (const f of p.findings) {
      assert.equal(shapeProblem(f, p.measures), null, `${name}: ${f.id}: ${shapeProblem(f, p.measures)}`)
      assert.ok(!ids.has(f.id), `${name}: duplicate id ${f.id}`)
      ids.add(f.id)
    }
  }
})

test('cli.ts marks a product-code finding as a proposed goal and never auto-fixes it', () => {
  const parseFindings = cliFn('parseFindings')
  const measures = { 'time.slotWaitMs.alpha': 1000 }
  const block = (target: Json): string =>
    '```finding\n' + JSON.stringify({ category: 'time', title: 'A slot wait', evidence: [{ measure: 'time.slotWaitMs.alpha', value: 1000 }], cost: { wallMs: 1000, tokens: null, usd: null }, fix: 'Shorten the wait.', target }) + '\n```\n'
  const report = [
    block({ kind: 'project-config', path: 'src/billing/invoice.ts' }),
    block({ kind: 'plugin', path: 'plugins/truss/agents/retro-judge.md' }),
    block({ kind: 'project-config', path: 'CLAUDE.md' }),
    block({ kind: 'project-config', path: '.claude/truss.json' }),
    block({ kind: 'proposed-goal', path: 'src/app.ts' }),
  ].join('\n')
  const r = parseFindings(report, measures)
  assert.deepEqual(r.dropped, [], `no block is dropped: ${JSON.stringify(r.dropped)}`)
  assert.deepEqual(r.kept.map((k: Json) => k.finding.target.kind), ['proposed-goal', 'plugin', 'project-config', 'project-config', 'proposed-goal'])
  // fix now on every one: product code becomes a proposed goal outside the fix goal, the rest go into the fix goal
  const findings = r.kept.map((k: Json, i: number) => ({ id: `F-${i + 1}`, judge: 'j', ...k.finding }))
  const t = cliFn('parseTriage')(findings.map((f: Json) => `TRIAGE: ${f.id} | fix now | cheap`).join('\n'), findings)
  const ids = (xs: unknown[]): string[] => xs.map((x) => (typeof x === 'string' ? x : (x as Json).id)).sort()
  assert.deepEqual(ids(t.fixGoal), ['F-2', 'F-3', 'F-4'], 'the fix goal holds only plugin and project-config findings')
  assert.deepEqual(ids(t.proposedGoals), ['F-1', 'F-5'], 'product-code findings are proposed goals')
  assert.equal(t.decisions.length, 5, 'every finding keeps its triage decision')
})

test('counts.ts reports time, code structure, tests, quality loop, rules and gates, and cost findings on the recorded wave-4 fixture', () => {
  assert.deepEqual((counts as Json).CHECKLIST, SIX, 'counts.ts exports CHECKLIST with the six categories')
  const p = wave4Problems()
  const seen = new Map<string, number>()
  for (const f of p.findings) seen.set(f.category, (seen.get(f.category) ?? 0) + 1)
  for (const c of SIX) assert.ok((seen.get(c) ?? 0) >= 1, `no ${c} finding on wave 4; categories seen: ${JSON.stringify([...seen])}`)
})

test('counts.ts on a small non-truss project fixture gives findings whose target is project config or a proposed goal', () => {
  const f = makeNonTruss()
  try {
    const p = problemsOf(f.dir)
    assert.ok(p.findings.length > 0, 'a non-truss project still gets findings from its events, usage and git')
    for (const x of p.findings) {
      assert.equal(shapeProblem(x, p.measures), null, `${x.id}: ${shapeProblem(x, p.measures)}`)
      assert.ok(['project-config', 'proposed-goal'].includes(x.target.kind), `${x.id} targets ${x.target.kind}, but there is no plugin file to fix`)
    }
    assert.ok(isRanked(p.findings), 'the findings are in cost order')
  } finally {
    f.cleanup()
  }
})

test('the counting step on a fixture with wave-4\'s event, usage and crew counts opens none of its transcript files and ends within the 300 s test timeout', { timeout: 300_000 }, () => {
  const f = makeSizeFixture()
  try {
    const lineCount = (p: string): number => readFileSync(p, 'utf8').split('\n').filter((l) => l !== '').length
    assert.equal(lineCount(path.join(f.dir, 'events.jsonl')), SIZE_EVENTS)
    assert.equal(lineCount(path.join(f.dir, 'usage.jsonl')), SIZE_USAGE)
    const crews = new Set(readFileSync(path.join(f.dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'spawn' && e.by === 'factory').map((e) => e.crew))
    assert.equal(crews.size, SIZE_CREWS)
    assert.equal(f.transcripts.length, TRANSCRIPT_FILES)
    assert.ok(f.transcripts.reduce((n, t) => n + readFileSync(t).length, 0) >= TRANSCRIPT_MIN_BYTES, 'the transcripts total at least 8.5 MB')
    // a preload patches the node:fs open and read functions (and child_process spawns) before retro/counts.ts is imported, and logs every path
    const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'retro-spy-')))
    const log = path.join(tmp, 'opened.json')
    const pre = path.join(tmp, 'pre.mjs')
    const run = path.join(tmp, 'run.mjs')
    writeFileSync(pre, [
      `import { createRequire, syncBuiltinESMExports } from 'node:module'`,
      `const require = createRequire(import.meta.url)`,
      `const fs = require('node:fs')`,
      `const cp = require('node:child_process')`,
      `const write = fs.writeFileSync`,
      `const opened = []`,
      `const rec = (k, p) => { if (typeof p === 'string' || Buffer.isBuffer(p)) opened.push(k + ' ' + String(p)); else if (p instanceof URL) opened.push(k + ' ' + p.pathname) }`,
      `for (const n of ['readFileSync', 'openSync', 'readFile', 'open', 'createReadStream']) { const o = fs[n]; fs[n] = function (p, ...a) { rec(n, p); return o.call(this, p, ...a) } }`,
      `for (const n of ['readFile', 'open']) { const o = fs.promises[n]; fs.promises[n] = function (p, ...a) { rec('promises.' + n, p); return o.call(this, p, ...a) } }`,
      `for (const n of ['spawnSync', 'execFileSync', 'spawn', 'execFile', 'execSync', 'exec']) { const o = cp[n]; cp[n] = function (c, ...a) { opened.push('spawn ' + String(c) + ' ' + (Array.isArray(a[0]) ? a[0].join(' ') : '')); return o.call(this, c, ...a) } }`,
      `syncBuiltinESMExports()`,
      `process.on('exit', () => write(process.env.SPY_LOG, JSON.stringify(opened)))`,
      '',
    ].join('\n'))
    writeFileSync(run, [
      `const t0 = Date.now()`,
      `const m = await import(process.env.COUNTS_URL)`,
      `if (typeof m.problems !== 'function') { console.log(JSON.stringify({ error: 'retro/counts.ts does not export problems()' })); process.exit(0) }`,
      `const r = m.problems(process.argv[2])`,
      `console.log(JSON.stringify({ returned: r?.retro === 2 && Array.isArray(r.findings), findings: r.findings.length, ms: Date.now() - t0 }))`,
      '',
    ].join('\n'))
    const env = { ...process.env, HOME: f.home, USERPROFILE: f.home, TRUSS_TRANSCRIPTS_ROOT: f.transcriptRoot, SPY_LOG: log, COUNTS_URL: pathToFileURL(path.join(HERE, '..', 'retro', 'counts.ts')).href }
    delete (env as Json).NODE_TEST_CONTEXT
    const t0 = Date.now()
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(pre).href, run, f.dir], { windowsHide: true, encoding: 'utf8', env, timeout: 290_000 })
    const ms = Date.now() - t0
    assert.equal(r.status, 0, `the counting step failed: ${r.stdout}${r.stderr}`)
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!)
    assert.equal(out.error, undefined, out.error)
    const opened: string[] = JSON.parse(readFileSync(log, 'utf8'))
    assert.ok(opened.some((o) => o.endsWith('events.jsonl')), 'the spy saw the counting step read events.jsonl, so it works')
    const hits = opened.filter((o) => o.includes(f.transcriptRoot) || o.includes(f.sessionDir) || f.transcripts.some((t) => o.includes(t)) || o.includes('/subagents/'))
    assert.deepEqual(hits, [], 'the counting step opened a transcript path')
    assert.equal(out.returned, true, 'problems() returned its result')
    assert.ok(ms < 300_000, `the counting step took ${ms} ms`)
  } finally {
    f.cleanup()
  }
})

test('the retro judge brief says it is empowered and expected to find problems outside the checklist and may name a new category', () => {
  const brief = readFileSync(path.join(ROOT, 'plugins', 'truss', 'agents', 'retro-judge.md'), 'utf8').replace(/\s+/g, ' ')
  const sentences = brief.split(/(?<=[.!?])\s+/)
  assert.ok(sentences.some((s) => /empowered/i.test(s) && /expected/i.test(s) && /outside the checklist/i.test(s) && /problem/i.test(s)), 'no sentence says the judge is empowered and expected to find problems outside the checklist')
  assert.ok(sentences.some((s) => /new categor/i.test(s) && /\b(?:may|can)\b/i.test(s) && /\bname\b/i.test(s)), 'no sentence says the judge may name a new category')
  assert.doesNotMatch(brief, /exactly, and no other/, 'the brief still closes the list of kinds')
})

test('cli.ts triage parsing keeps a finding whose category is not in the checklist', () => {
  const parseFindings = cliFn('parseFindings')
  const measures = { 'time.slotWaitMs.alpha': 1000, 'cost.tokens.alpha.builder': 2000000 }
  const block = (o: Json): string => '```finding\n' + JSON.stringify({ title: 'A problem', cost: { wallMs: 1000, tokens: null, usd: null }, fix: 'Fix it.', target: { kind: 'plugin', path: 'plugins/truss/bin/factory.ts' }, ...o }) + '\n```\n'
  const report = [
    block({ category: 'build cache misses', evidence: [{ measure: 'cost.tokens.alpha.builder', value: 2000000 }], cost: { wallMs: null, tokens: 2000000, usd: null } }),
    block({ category: 'time', evidence: [{ measure: 'time.slotWaitMs.alpha', value: 1000 }] }),
    block({ category: 'time', evidence: [{ measure: 'time.slotWaitMs.alpha', value: 999 }] }),
    block({ category: 'time', evidence: [{ measure: 'time.slotWaitMs.ghost', value: 1 }] }),
  ].join('\n')
  const r = parseFindings(report, measures)
  assert.deepEqual(r.kept.map((k: Json) => k.finding.category), ['build cache misses', 'time'], 'a category outside the checklist is kept')
  assert.equal(r.dropped.length, 2)
  assert.match(r.dropped.find((d: Json) => d.n === 3)!.reason, /time\.slotWaitMs\.alpha/, 'the reason names the measure whose value differs')
  assert.match(r.dropped.find((d: Json) => d.n === 4)!.reason, /time\.slotWaitMs\.ghost/, 'the reason names the measure that is not counted')
  const findings = r.kept.map((k: Json, i: number) => ({ id: `F-${i + 1}`, judge: 'j', ...k.finding }))
  const t = cliFn('parseTriage')('noise\nTRIAGE: F-1 | defer | a new kind of problem\nTRIAGE: F-2 | drop | known\nTRIAGE: F-9 | defer | no such finding\n', findings)
  const d = t.decisions.find((x: Json) => x.id === 'F-1')
  assert.ok(d, `triage dropped the finding of the new category: ${JSON.stringify(t)}`)
  assert.equal(d.decision, 'defer')
  assert.equal(d.reason, 'a new kind of problem')
  assert.deepEqual(t.decisions.map((x: Json) => x.id).sort(), ['F-1', 'F-2'], 'a line naming an unknown id is not a decision')
  assert.equal(t.dropped.length, 1, 'the unknown id is reported as dropped')
})

const recording = (name: string): string => readFileSync(path.join(ROOT, 'plugins', 'truss', 'retro', 'evals', name), 'utf8')

test('the rubric grader passes the recorded judge and triage output on the wave-4 fixture', () => {
  const g = grade(recording('wave4-judge.md'), recording('wave4-triage.md'), wave4Problems() as { measures: Record<string, number>; findings: { id: string }[] })
  assert.deepEqual(g.failures, [])
  assert.equal(g.pass, true)
  assert.ok(findingBlocks(recording('wave4-judge.md')).length >= 3, 'the recorded judge output holds at least three findings')
})

test('the rubric grader fails a recorded judge output that has a finding with no counted evidence', () => {
  const p = wave4Problems() as { measures: Record<string, number>; findings: { id: string }[] }
  const judge = recording('wave4-judge.md')
  const triage = recording('wave4-triage.md')
  const doctored = (e: Json): string =>
    judge + '\n```finding\n' + JSON.stringify({ category: 'time', title: 'An invented wait', evidence: [e], cost: { wallMs: 1, tokens: null, usd: null }, fix: 'Do something.', target: { kind: 'plugin', path: 'plugins/truss/bin/factory.ts' } }) + '\n```\n'
  const ghost = grade(doctored({ measure: 'time.invented.ghostWaitMs', value: 99 }), triage, p)
  assert.equal(ghost.pass, false, 'a finding whose evidence names a measure that is not counted passes')
  assert.ok(ghost.failures.some((x) => x.includes('time.invented.ghostWaitMs')), `no failure names the measure: ${JSON.stringify(ghost.failures)}`)
  const [key, value] = Object.entries(p.measures)[0]!
  const wrong = grade(doctored({ measure: key, value: value + 1 }), triage, p)
  assert.equal(wrong.pass, false, 'a finding whose evidence value differs from the count passes')
  assert.ok(wrong.failures.some((x) => x.includes(key)), `no failure names the measure: ${JSON.stringify(wrong.failures)}`)
})

test('rubric grader (own check): fails a mis-ranked judge output and a triage line naming an unknown id', () => {
  const p = { measures: { 'time.a': 10, 'time.b': 20 }, findings: [{ id: 'P-1' }] }
  const f = (m: string, wallMs: number): string => '```finding\n' + JSON.stringify({ category: 'time', title: 't', evidence: [{ measure: m, value: p.measures[m as 'time.a'] }], cost: { wallMs, tokens: null, usd: null }, fix: 'f.', target: { kind: 'plugin' } }) + '\n```\n'
  const good = grade(f('time.b', 20) + f('time.a', 10), 'TRIAGE: F-1 | fix now | r\nTRIAGE: P-1 | drop | r\n', p)
  assert.deepEqual(good.failures, [])
  assert.equal(grade(f('time.a', 10) + f('time.b', 20), 'TRIAGE: F-1 | defer | r\n', p).pass, false, 'a cheaper finding listed first passes')
  assert.equal(grade(f('time.b', 20), 'TRIAGE: F-7 | defer | r\n', p).pass, false, 'an unknown finding id passes')
})

test('timing bounds a crew period by its first and last agent activity when its recorded start and end span a long idle gap', () => {
  // Pins existing behaviour of retro/timing.ts (R-148): it passes on the crew branch before any builder runs.
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'retro-r148-')))
  mkdirSync(path.join(d, 'answers'), { recursive: true })
  const T = Date.parse('2026-11-12T00:00:00Z')
  const H = 60 * MIN
  const at = (ms: number): string => new Date(T + ms).toISOString()
  const ev = [
    { event: 'spawn', crew: 'c', agent: 'c', agentId: null, type: 'workflow-crew', by: 'factory', ts: at(0) },
    { event: 'spawn', crew: 'c', agent: 'c-builder', agentId: 'c1', type: 'kit:builder', by: 'workflow:w', ts: at(5 * MIN) },
    { event: 'tag', crew: 'c', agent: 'c', tag: 'BLOCKED', run: 'w', ts: at(10 * H) },
  ]
  writeFileSync(path.join(d, 'events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n')
  writeFileSync(path.join(d, 'usage.jsonl'), [{ agentId: 'c1', ts: at(1 * H) }, { agentId: 'c1', ts: at(2 * H) }].map((e) => JSON.stringify(e)).join('\n') + '\n')
  const c = (analyze(d) as Json).crews[0]
  assert.equal(c.slug, 'c')
  // the recorded span is T to T+10 h; the period runs from the first usage row (T+1 h) to the last (T+2 h)
  assert.equal(c.startLeadMs, 1 * H, 'the time before the first agent activity is outside the period')
  assert.equal(c.agentWorkMs, 1 * H)
  assert.equal(c.idleMs, 0, 'the long gap is not idle time')
  assert.equal(c.stampLagMs, 8 * H, 'the time from the last agent activity to the stop stamp is stop-stamp lag')
  assert.equal(c.wallMs, 9 * H)
  assert.ok(c.wallMs < 10 * H, 'the period is shorter than the recorded start to end')
})

test('skills/retro/SKILL.md and agents/planning-engineer.md hold no path:line citation and the citation lint covers them', () => {
  const files = ['plugins/truss/skills/retro/SKILL.md', 'plugins/truss/agents/planning-engineer.md']
  const covered = citationDocs(ROOT)
  for (const f of files) {
    assert.ok(covered.includes(f), `the citation lint does not cover ${f}`)
    assert.deepEqual(lineCitations(readFileSync(path.join(ROOT, ...f.split('/')), 'utf8')), [], `${f} holds a line citation`)
  }
})
