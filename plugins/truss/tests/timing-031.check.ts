// @ts-nocheck
// retro/timing.ts (truss 0.31.0, speed goal step 0): splits each crew's wall-clock from a run dir's own timestamps. The fixture run dir is
// built here from a handful of synthetic events, usage rows, reports and file mtimes, so the split arithmetic is pinned to exact minutes.
// Node built-ins only.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { analyze, render } from '../retro/timing.ts'

const T0 = Date.parse('2026-11-12T00:00:00Z')
const at = (min: number): string => new Date(T0 + min * 60000).toISOString()
const MIN = 60000

/** One crew, `alpha`, with a builder, a heavy-slot runner (10 min slot wait, 20 min test run), a failed QC, a ruling and a resolver. */
function fixture(): string {
  const d = mkdtempSync(join(tmpdir(), 'timing-031-'))
  for (const sub of ['reports/alpha', 'answers']) mkdirSync(join(d, sub), { recursive: true })
  const ev = [
    { event: 'spawn', crew: 'alpha', agent: 'alpha', agentId: null, type: 'workflow-crew', by: 'factory', ts: at(0) },
    { event: 'spawn', crew: 'alpha', agent: 'alpha-builder', agentId: 'b1', type: 'kit:builder', by: 'workflow:wf_1', ts: at(70) },
    { event: 'spawn', crew: 'alpha', agent: 'alpha-runner', agentId: 'r1', type: 'general-purpose', by: 'workflow:wf_1', ts: at(70) },
    { event: 'spawn', crew: 'alpha', agent: 'alpha-qc', agentId: 'q1', type: 'truss:qc-engineer', by: 'workflow:wf_1', ts: at(70) },
    { event: 'tag', crew: 'alpha', tag: 'BLOCKED', run: 'wf_1', ts: at(70) },
    { event: 'spawn', crew: 'alpha', agent: 'alpha-resolver', agentId: 'x1', type: 'kit:builder', by: 'workflow:wf_2', ts: at(140) },
  ]
  writeFileSync(join(d, 'events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const u = (id: string, a: number, b: number) => [{ agentId: id, ts: at(a) }, { agentId: id, ts: at(a + 1) }, { agentId: id, ts: at(b) }]
  const rows = [...u('b1', 5, 20), ...u('r1', 20, 50), ...u('q1', 55, 65), ...u('x1', 120, 130), ...u('ghost', 10, 14), { agentId: null, ts: at(3) }]
  writeFileSync(join(d, 'usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const heavy = JSON.stringify({ ok: true, heavy: { label: 'alpha-check', waitedMs: 10 * MIN, exit: 0 } }) + '\ntruss-status: {}'
  writeFileSync(join(d, 'reports/alpha/alpha-runner.md'), JSON.stringify({ exit: 0, stdout: heavy }))
  writeFileSync(join(d, 'reports/alpha/alpha-qc.md'), 'VERDICT: FAIL\n\n## Proof checked\n')
  writeFileSync(join(d, 'answers/alpha-1.json'), JSON.stringify([{ at: 'qc', text: 'ruling' }]))
  utimesSync(join(d, 'answers/alpha-1.json'), new Date(T0 + 90 * MIN), new Date(T0 + 90 * MIN))
  writeFileSync(join(d, 'stage-result-alpha-2.json'), JSON.stringify([{ slug: 'alpha', state: 'passed' }]))
  utimesSync(join(d, 'stage-result-alpha-2.json'), new Date(T0 + 140 * MIN), new Date(T0 + 140 * MIN))
  return d
}

test('the split of one crew adds up to its wall-clock, minute by minute', () => {
  const r = analyze(fixture())
  assert.equal(r.crews.length, 1)
  const c = r.crews[0]
  assert.equal(c.slug, 'alpha')
  assert.equal(c.wallMs, 140 * MIN)
  assert.equal(c.agentWorkMs, 15 * MIN)
  assert.equal(c.heavyWaitMs, 10 * MIN)
  assert.equal(c.testRunMs, 20 * MIN)
  assert.equal(c.qcMs, 10 * MIN)
  assert.equal(c.conflictMs, 10 * MIN)
  assert.equal(c.waitRulingMs, 20 * MIN)
  assert.equal(c.restartLagMs, 30 * MIN)
  assert.equal(c.idleMs, 25 * MIN)
  const sum = c.agentWorkMs + c.heavyWaitMs + c.testRunMs + c.qcMs + c.conflictMs + c.waitRulingMs + c.restartLagMs + c.idleMs
  assert.equal(sum, c.wallMs)
  assert.equal(c.stops, 1)
  assert.deepEqual(c.reportTotals, { runnerReports: 1, slotRuns: 1, slotWaitMs: 10 * MIN, slotGaveUp: 0, qcPass: 0, qcFail: 1, qcOther: 0 })
  assert.equal(c.noUsageMs, 0)
  assert.deepEqual(c.qcRounds.map((q) => [q.agent, q.verdict, q.ms]), [['alpha-qc', 'FAIL', 10 * MIN]])
})

test('a category the data cannot give is null with a reason, never 0', () => {
  const r = analyze(fixture())
  assert.equal(r.crews[0].clientWaitMs, null)
  assert.match(r.notMeasurable.clientWait, /not recorded|no author/i)
  assert.ok(r.notMeasurable.builderTests)
})

test('the run total spans the crews, and agents with no spawn event stay unattributed', () => {
  const r = analyze(fixture())
  assert.equal(r.run.wallMs, 140 * MIN)
  assert.equal(r.run.stops, 1)
  assert.equal(r.run.unattributedAgents, 1)
  assert.equal(r.run.unattributedMs, 4 * MIN)
})

test('render prints a markdown table, and the CLI --json prints the same analysis', () => {
  const d = fixture()
  const md = render(analyze(d))
  assert.match(md, /\| alpha \|/)
  assert.match(md, /not measurable/)
  const p = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'retro', 'timing.ts'), d, '--json'], { encoding: 'utf8' })
  assert.equal(p.status, 0, p.stderr)
  assert.equal(JSON.parse(p.stdout).crews[0].wallMs, 140 * MIN)
})
