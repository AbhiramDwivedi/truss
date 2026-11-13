// Opt-in live eval of the retro judge and triage (ADR-0051 Decision 10). Outside the `*.check.ts` glob: the default suite never runs it.
// The program manager runs it at release:
//   TRUSS_RETRO_LIVE_EVAL=1 node --test plugins/truss/tests/retro-generic-live.e2e.ts
// It builds the scrubbed wave-4 fixture, runs the counting step, then runs a fresh judge and a fresh triage through the `claude` CLI and
// grades both outputs with the rubric of `fixtures/retro-generic/rubric.ts`. Without the CLI it fails with a clear message; without the
// env var it is skipped. It uses the network and a model, so it costs money and is never part of the default suite.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as counts from '../retro/counts.ts'
import { loadWave4 } from './fixtures/retro-generic/load.ts'
import { findingBlocks, grade } from './fixtures/retro-generic/rubric.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..')
const LIVE = process.env.TRUSS_RETRO_LIVE_EVAL === '1'

const agentBody = (file: string): string => readFileSync(path.join(PLUGIN, 'agents', file), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '')

/** One `claude -p` call: the agent's brief is the system prompt, the task goes in on stdin (it holds data from the fixture, never an argument). */
function ask(system: string, prompt: string, what: string): string {
  const r = spawnSync('claude', ['-p', '--model', 'opus', '--tools', '', '--append-system-prompt', system], { windowsHide: true, encoding: 'utf8', input: prompt, timeout: 900_000, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.error, undefined, `the live eval needs the claude CLI on PATH (${what}): ${r.error?.message}`)
  assert.equal(r.status, 0, `claude failed for the ${what} (exit ${r.status}): ${r.stderr}`)
  return r.stdout
}

let w: ReturnType<typeof loadWave4> | undefined
after(() => w?.cleanup())

test('retro-generic live: a fresh judge and triage on the wave-4 fixture pass the rubric', { skip: LIVE ? false : 'set TRUSS_RETRO_LIVE_EVAL=1 to run the live eval', timeout: 2_400_000 }, () => {
  const version = spawnSync('claude', ['--version'], { windowsHide: true, encoding: 'utf8' })
  assert.equal(version.error, undefined, 'TRUSS_RETRO_LIVE_EVAL=1 needs the claude CLI on PATH, and it was not found')
  assert.equal(version.status, 0, `claude --version failed: ${version.stderr}`)
  w = loadWave4()
  assert.equal(typeof (counts as Record<string, unknown>).problems, 'function', 'retro/counts.ts does not export problems()')
  const problems = (counts as unknown as { problems: (d: string) => { measures: Record<string, number>; findings: { id: string }[] } }).problems(w.dir)
  mkdirSync(path.join(w.dir, 'retro'), { recursive: true })
  writeFileSync(path.join(w.dir, 'retro', 'problems.json'), JSON.stringify(problems, null, 2))
  const judge = ask(agentBody('retro-judge.md'), `Judge this truss session. The counting step's output is retro/problems.json, below. Return your findings as fenced finding blocks.\n\n${JSON.stringify(problems, null, 2)}\n`, 'judge')
  const blocks = findingBlocks(judge)
  assert.ok(blocks.length > 0, `the fresh judge returned no finding block:\n${judge.slice(0, 2000)}`)
  const list = blocks.map((b, i) => `F-${i + 1} | ${b.value?.category} | ${b.value?.title} | ${b.value?.target?.kind}`).join('\n')
  const triage = ask(agentBody('checking-engineer.md'), `Retro triage.\n\nSort each finding into fix now, defer or drop. Findings, one per line as id | category | title | target kind:\n\n${list}\n`, 'triage')
  const g = grade(judge, triage, problems)
  assert.deepEqual(g.failures, [], `the rubric failed the fresh output.\n--- judge ---\n${judge.slice(0, 4000)}\n--- triage ---\n${triage.slice(0, 2000)}`)
  assert.equal(g.pass, true)
})
