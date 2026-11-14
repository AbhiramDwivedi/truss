// @ts-nocheck
// truss 0.32.0, closeout crew (R-125, R-126): the two hand-merged 0.30.0 crews (run-lifecycle, crew-decisions) get QC and a review after the
// fact, and R-85..R-98 carry a status verified from evidence. The cases read plugins/truss/docs/goals/0.32.0-closeout.md and the wave-4 run
// dir named by TRUSS_WAVE4_DIR (read-only); they run every test file the doc cites in a child `node --test` process.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const DOC = path.join(ROOT, 'plugins', 'truss', 'docs', 'goals', '0.32.0-closeout.md')
const REQS = path.join(ROOT, 'plugins', 'truss', 'docs', 'requirements.md')
const SELF = 'plugins/truss/tests/closeout-032.check.ts'
const RIDS = Array.from({ length: 14 }, (_, i) => `R-${85 + i}`)

const readDoc = () => {
  assert.ok(existsSync(DOC), 'plugins/truss/docs/goals/0.32.0-closeout.md does not exist')
  return readFileSync(DOC, 'utf8')
}

// The text under a heading, up to the next heading of the same or a higher level.
const section = (md, heading) => {
  const lines = md.split('\n')
  const at = lines.findIndex((l) => l.trim() === heading)
  assert.ok(at >= 0, `the closeout doc has no "${heading}" section`)
  const level = heading.match(/^#+/)[0].length
  const out = []
  for (const l of lines.slice(at + 1)) {
    const m = l.match(/^(#+)\s/)
    if (m && m[1].length <= level) break
    out.push(l)
  }
  return out.join('\n')
}

// Table rows under a header line starting with `| <first> |`; the separator row is dropped.
const rows = (text, header) => {
  const lines = text.split('\n').map((l) => l.trim())
  const at = lines.findIndex((l) => l.startsWith('|') && l.replace(/\s+/g, ' ').startsWith(header))
  assert.ok(at >= 0, `no table with the header ${header}`)
  const out = []
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('|')) break
    if (/^\|[\s:|-]+\|?$/.test(l)) continue
    out.push(l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
  }
  return out
}

const unquote = (s) => s.replace(/^`+|`+$/g, '').trim()

// The wave-4 gaps, by the fixed rule of the goal file.
const waveGaps = () => {
  const dir = process.env.TRUSS_WAVE4_DIR
  assert.ok(dir, 'TRUSS_WAVE4_DIR is not set')
  assert.ok(existsSync(dir), `TRUSS_WAVE4_DIR does not exist: ${dir}`)
  const files = readdirSync(dir).filter((f) => /^stage-result-(run-lifecycle|crew-decisions)-.*\.json$/.test(f)).sort()
  assert.ok(files.length > 0, 'the wave-4 dir holds no run-lifecycle or crew-decisions stage results')
  const keys = []
  for (const f of files) {
    const j = JSON.parse(readFileSync(path.join(dir, f), 'utf8'))
    for (const r of Object.values(j)) {
      String(r?.text ?? '').split('\n').forEach((line, i) => { if (/GAP|[Dd]efer/.test(line)) keys.push(`${f}#${i}`) })
      ;(Array.isArray(r?.unrecorded) ? r.unrecorded : []).forEach((_, n) => keys.push(`${f}#unrecorded[${n}]`))
    }
  }
  return keys
}

// `<test file> :: <test title>`, the file under plugins/truss/tests.
const parseRef = (s) => {
  const m = unquote(s).match(/^(plugins\/truss\/tests\/[A-Za-z0-9._\/-]+\.ts) :: (.+)$/)
  if (!m || m[1].includes('..')) return null
  return { file: m[1], title: m[2].trim() }
}

const runs = new Map()
const taps = (file) => {
  if (!runs.has(file)) {
    assert.notEqual(file, SELF, 'a row cannot cite the closeout test itself as its evidence')
    assert.ok(existsSync(path.join(ROOT, file)), `${file} does not exist`)
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(ROOT, file)], { cwd: ROOT, env, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    runs.set(file, r.stdout ?? '')
  }
  return runs.get(file)
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const passes = (ref) => new RegExp(`^\\s*ok \\d+ - ${esc(ref.title)}(\\s+#.*)?$`, 'm').test(taps(ref.file))
const failsToo = (ref) => new RegExp(`^\\s*not ok \\d+ - ${esc(ref.title)}(\\s+#.*)?$`, 'm').test(taps(ref.file))

// An Outcome cell: `fixed: <file> :: <title>` (the test must print ok) or `deferred: <reason>`.
const checkOutcome = (what, outcome, problems) => {
  const fixed = outcome.match(/^fixed:\s*(.+)$/)
  if (fixed) {
    const ref = parseRef(fixed[1])
    if (!ref) return problems.push(`${what}: fixed outcome is not "<test file> :: <title>": ${outcome}`)
    if (!passes(ref)) problems.push(`${what}: the test "${ref.title}" in ${ref.file} does not print ok`)
    return
  }
  const deferred = outcome.match(/^deferred:\s*(.+)$/)
  if (!deferred || deferred[1].trim().length < 8) problems.push(`${what}: outcome is neither "fixed: <file> :: <title>" nor "deferred: <reason>": ${outcome}`)
}

const evidenceRows = () => {
  const table = rows(section(readDoc(), '## Requirement evidence'), '| Req | Status | Evidence | Hand-merged only |')
  const byReq = new Map()
  for (const c of table) {
    assert.equal(c.length, 4, `an evidence row has ${c.length} cells, not 4: ${c.join(' | ')}`)
    assert.ok(!byReq.has(c[0]), `${c[0]} has two rows in the closeout evidence table`)
    byReq.set(c[0], { status: c[1], evidence: c[2], only: c[3] })
  }
  const missing = RIDS.filter((r) => !byReq.has(r))
  assert.deepEqual(missing, [], `the closeout evidence table has no row for: ${missing.join(', ')}`)
  return byReq
}

// The wave-4 run dir is outside the repo; without TRUSS_WAVE4_DIR the case skips with a message instead of failing the full suite.
const WAVE4_SKIP = process.env.TRUSS_WAVE4_DIR ? false : 'TRUSS_WAVE4_DIR is not set; export it to the wave-4 run dir to run this case'

test('every finding of the run-lifecycle and crew-decisions reviews and each deferred gap in the wave-4 stage results is fixed with a named test or deferred with a reason in 0.32.0-closeout.md', { skip: WAVE4_SKIP }, () => {
  const md = readDoc()
  const keys = waveGaps()
  const problems = []

  const gapRows = rows(section(md, '## Deferred gaps'), '| Gap | Text | Outcome |')
  const byKey = new Map(gapRows.map((c) => [unquote(c[0]), c]))
  for (const k of keys) {
    const c = byKey.get(k)
    if (!c) { problems.push(`no Deferred gaps row for ${k}`); continue }
    checkOutcome(`gap ${k}`, c[2] ?? '', problems)
  }

  const review = section(md, '## Review findings')
  for (const [sub, label] of [['### QC pass', 'QC'], ['### Reviewer pass', 'Reviewer']]) {
    let body
    try { body = section(review, sub) } catch { problems.push(`Review findings has no "${sub}" subsection`); continue }
    for (const persona of ['truss-plugin-node', 'truss-workflow-scripts']) {
      if (!new RegExp(`^Verdict \\(${persona}\\): (PASS|FAIL)\\s*$`, 'm').test(body)) problems.push(`${label} pass has no "Verdict (${persona}): PASS|FAIL" line`)
    }
    let table = []
    try { table = rows(body, '| Finding | Area | Outcome |') } catch { problems.push(`${label} pass has no "| Finding | Area | Outcome |" table`) }
    for (const c of table) checkOutcome(`${label} finding "${c[0]}"`, c[2] ?? '', problems)
  }
  assert.deepEqual(problems, [], `${keys.length} wave-4 gaps found by the rule; problems:\n${problems.join('\n')}`)
})

test('each of R-85 to R-98 has status met or open and a row in the closeout evidence table', () => {
  const byReq = evidenceRows()
  const reqs = readFileSync(REQS, 'utf8')
  const problems = []
  for (const r of RIDS) {
    const row = byReq.get(r)
    if (row.status !== 'met' && row.status !== 'open') problems.push(`${r}: row status is "${row.status}", not met or open`)
    const m = reqs.match(new RegExp(`^## ${r}:[^\\n]*\\n(?:[^\\n#][^\\n]*\\n)*?Status: ([^\\n]+)`, 'm'))
    if (!m) { problems.push(`${r}: no Status line in requirements.md`); continue }
    if (m[1].trim() !== row.status) problems.push(`${r}: requirements.md says "${m[1].trim()}", the evidence row says "${row.status}"`)
  }
  assert.deepEqual(problems, [])
})

test('every met row in the closeout evidence table names a test title that passes when its test file runs in this run', () => {
  const byReq = evidenceRows()
  const problems = []
  for (const r of RIDS) {
    const row = byReq.get(r)
    if (row.status !== 'met') continue
    const ref = parseRef(row.evidence)
    if (!ref) { problems.push(`${r}: met evidence is not "<test file> :: <title>": ${row.evidence}`); continue }
    if (!passes(ref)) problems.push(`${r}: "${ref.title}" does not print ok in ${ref.file}`)
  }
  assert.deepEqual(problems, [])
})

test('every open row in the closeout evidence table names the failing test or command that shows it open', () => {
  const byReq = evidenceRows()
  const problems = []
  for (const r of RIDS) {
    const row = byReq.get(r)
    if (row.status !== 'open') continue
    const ref = parseRef(row.evidence)
    if (ref) {
      if (!failsToo(ref)) problems.push(`${r}: "${ref.title}" does not print not ok in ${ref.file}`)
    } else if (!/^`[^`]+`$/.test(row.evidence.trim())) {
      problems.push(`${r}: open evidence is neither "<test file> :: <failing title>" nor a backticked command: ${row.evidence}`)
    }
  }
  assert.deepEqual(problems, [])
})

test('every row in the closeout evidence table says whether only the hand-merged crews cover it', () => {
  const byReq = evidenceRows()
  const bad = RIDS.filter((r) => !/^(yes|no)$/.test(byReq.get(r).only))
  assert.deepEqual(bad, [], `Hand-merged only must be yes or no for: ${bad.join(', ')}`)
})
