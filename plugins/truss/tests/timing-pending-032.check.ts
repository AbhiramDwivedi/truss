// timing.ts and a runner report of a pending background heavy job (0.32.0 heavy slots): the call's waitedMs is the time the call
// waited for the job, which for a pending job is mostly the job running the tests, not a wait for a heavy slot.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { analyze } from '../retro/timing.ts'

const T0 = Date.parse('2026-11-12T00:00:00Z')
const at = (min: number): string => new Date(T0 + min * 60000).toISOString()
const MIN = 60000

/** One crew, `alpha`: runner 1 prints a pending report after 9 min (540 s) in the background; runner 2 waited 5 min for a slot, then ran 10 min. */
function fixture(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'timing-pending-032-')))
  mkdirSync(join(d, 'reports/alpha'), { recursive: true })
  const ev = [
    { event: 'spawn', crew: 'alpha', agent: 'alpha', agentId: null, type: 'workflow-crew', by: 'factory', ts: at(0) },
    { event: 'spawn', crew: 'alpha', agent: 'alpha-runner', agentId: 'r1', type: 'general-purpose', by: 'workflow:wf_1', ts: at(40) },
    { event: 'spawn', crew: 'alpha', agent: 'alpha-runner-2', agentId: 'r2', type: 'general-purpose', by: 'workflow:wf_1', ts: at(40) },
    { event: 'tag', crew: 'alpha', tag: 'BLOCKED', run: 'wf_1', ts: at(40) },
  ]
  writeFileSync(join(d, 'events.jsonl'), ev.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const u = (id: string, a: number, b: number) => [{ agentId: id, ts: at(a) }, { agentId: id, ts: at(a + 1) }, { agentId: id, ts: at(b) }]
  const rows = [...u('r1', 0, 9), ...u('r2', 10, 25)]
  writeFileSync(join(d, 'usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const pending = JSON.stringify({ heavy: { label: 'alpha-check', pending: true, job: 'e73f2fb8ddc3e7e9', waitedMs: 9 * MIN, ageMs: 9 * MIN, budgetMs: 18 * MIN, why: 'still running after 540 s in the background (job e73f2fb8ddc3e7e9); run the same command again to wait for its result' } })
  writeFileSync(join(d, 'reports/alpha/alpha-runner.md'), JSON.stringify({ exit: 1, stdout: pending }))
  const done = JSON.stringify({ ok: true, heavy: { label: 'alpha-check', waitedMs: 5 * MIN, exit: 0, slots: 1 } })
  writeFileSync(join(d, 'reports/alpha/alpha-runner-2.md'), JSON.stringify({ exit: 0, stdout: done }))
  return d
}

test('timing 032: a pending heavy job counts as test run, a real slot wait stays slot wait', () => {
  const c = analyze(fixture()).crews[0]
  assert.equal(c.slug, 'alpha')
  // runner 1 (9 min, pending): all test run. runner 2: 5 min slot wait, 10 min test run. The 1 min between them is idle.
  assert.equal(c.heavyWaitMs, 5 * MIN)
  assert.equal(c.testRunMs, 19 * MIN)
  assert.equal(c.idleMs, 1 * MIN)
  assert.equal(c.agentWorkMs, 0)
  assert.equal(c.stampLagMs, 15 * MIN) // last usage row 25, tag stamped 40
  assert.equal(c.wallMs, 40 * MIN)
  const sum = c.stampLagMs + c.agentWorkMs + c.heavyWaitMs + c.testRunMs + c.qcMs + c.conflictMs + c.waitRulingMs + c.restartLagMs + c.idleMs + c.noUsageMs + c.noSessionMs
  assert.equal(sum, c.wallMs)
})

test('timing 032: the report totals and heavy run rows agree with the split', () => {
  const r = analyze(fixture())
  const c = r.crews[0]
  assert.equal(c.reportTotals.slotWaitMs, 5 * MIN)
  assert.equal(c.reportTotals.slotRuns, 2)
  assert.equal(c.reportTotals.slotGaveUp, 0)
  const rows = r.heavyRuns.slice().sort((a: any, b: any) => (a.agent < b.agent ? -1 : 1))
  assert.deepEqual(rows.map((h: any) => [h.agent, h.waitedMs, h.runMs, h.ran]), [['alpha-runner', 0, 9 * MIN, true], ['alpha-runner-2', 5 * MIN, 10 * MIN, true]])
})
