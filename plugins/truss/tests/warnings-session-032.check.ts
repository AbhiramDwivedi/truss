// @ts-nocheck
// 0.32.0 deferred-fixes, program manager ruling on the newer-than-session warnings (bin/factory/warnings.ts). The warnings said an
// agent file changed after the session loaded its agents, measuring from the process that ran the command (CLAUDE_PID) and not from the
// session that `start --transcript` names. Given --transcript, the session start is the first record's timestamp in that session's
// main transcript <transcripts root>/<project>/<sid>.jsonl, where the run dir is <transcripts root>/<project>/<sid>/workflows/<runId>.
// Without --transcript the CLAUDE_PID path stays.
//
// The running process is this test process (CLAUDE_PID), which started a moment before T0. Times are set against T0, so no case sleeps.

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { assertOneLine, crew, mkEnv, mkRun, planObj, pluginCopy, runCli, tmp, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const T0 = Date.now()
const HOUR = 3_600_000
const iso = (ms: number): string => new Date(ms).toISOString()
const CHANGED = /changed after this session loaded its agents/

/** Runs `start --stage next --transcript <run dir>` with every agent file at mtime `fileMs` and the session transcript starting at `sessionMs`. */
function warningsOf(sessionMs: number, fileMs: number): string[] {
  const env = mkEnv()
  writePlan(env.dir, planObj([crew('s')]))
  writeGoal(env.dir, 's')
  const plugin = tmp('wsess-plugin-')
  cpSync(pluginCopy(), plugin, { recursive: true })
  for (const f of readdirSync(`${plugin}/agents`)) utimesSync(`${plugin}/agents/${f}`, fileMs / 1000, fileMs / 1000)
  const troot = tmp('wsess-tr-')
  const sid = 'sess-warn-032'
  mkdirSync(`${troot}/proj/${sid}/workflows`, { recursive: true })
  writeFileSync(`${troot}/proj/${sid}.jsonl`, [JSON.stringify({ type: 'user', timestamp: iso(sessionMs), message: { role: 'user', content: 'hi' } }), JSON.stringify({ type: 'assistant', timestamp: iso(T0), message: { role: 'assistant', content: [] } })].join('\n') + '\n')
  const run = mkRun(`${troot}/proj/${sid}/workflows`, 'run1', [])
  const res = runCli(`${plugin}/bin/factory.ts`, 'start', ['--dir', env.dir, '--repo', env.repo, '--stage', 'next', '--transcript', run.dir], env.repo, { TRUSS_TRANSCRIPTS_ROOT: troot, CLAUDE_PID: String(process.pid), TRUSS_SESSION_START: '' })
  assert.equal(res.status, 0, `exit ${res.status}; ${String(res.stdout).slice(0, 500)}; ${String(res.stderr).slice(0, 300)}`)
  return assertOneLine(res).warnings
}

test('start measures the session from --transcript: a running process that started after that session does not hide a real agent file change', () => {
  // the session began 3 h ago, the agent files changed 1 h ago, this process started after both: the change is real and must be warned
  const w = warningsOf(T0 - 3 * HOUR, T0 - HOUR)
  assert.ok(w.some((x) => CHANGED.test(x) && x.includes('agents/qc-engineer.md')), `no warning for agents/qc-engineer.md: ${JSON.stringify(w)}`)
})

test('start measures the session from --transcript: a running process that started before that session does not raise a false warning', () => {
  // the agent files changed 5 s after this process started but before the session began (60 s on): nothing changed after the session loaded its agents
  const w = warningsOf(T0 + 60_000, T0 + 5_000)
  const bad = w.filter((x) => CHANGED.test(x) || /can't tell/.test(x))
  assert.deepEqual(bad, [], `false warnings: ${JSON.stringify(bad)}`)
})
