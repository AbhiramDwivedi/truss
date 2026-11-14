// @ts-nocheck
// Regression cases for the run-survival QC findings: the feature doc's case numbers, and the plan.json `engine` stamp
// that reclaimOrphans leans on (plan.schema.json forbids an undeclared crew field; a crew set running by a start before
// 0.32.0 carries no stamp and must still be left alone).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { docText } from './fixtures/doc-text.ts'
import { crew, flat, mkRepo, planObj, readEvents, readPlan, REAL_FACTORY, runCli, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`
const CFG = { merge: 'sequential', target: 'main' }
const startArgs = (repo: string, dir: string): string[] => ['--repo', repo, '--dir', dir, '--stage', 'next']
const root = (): string => flat(realpathSync(mkdtempSync(join(tmpdir(), 'rsqc-tr-'))))

function session(repo: string, plan: any): string {
  const dir = `${repo}/.git/truss/s-qc`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/decisions.md`, '')
  writeFileSync(`${dir}/events.jsonl`, '')
  writePlan(dir, plan)
  for (const c of plan.crews) writeGoal(dir, String(c.slug), {})
  return dir
}

test('run-survival doc: the case numbers it cites are the cases of that title in run-survival-032.check.ts', () => {
  const src = readFileSync(new URL('./run-survival-032.check.ts', import.meta.url), 'utf8')
  const titles = [...src.matchAll(/^test\((['"`])(.*)\1,/gm)].map((m) => m[2])
  const doc = docText('docs/features.md')
  const sections = doc.split(/^## /m).filter((s) => s.trim())
  const casesOf = (s: string): number[] => {
    const line = s.split('\n').find((l) => l.startsWith('- Tests:')) ?? ''
    return [...line.replace(/`[^`]*`/g, '').matchAll(/\d+/g)].map((m) => Number(m[0]))
  }
  const gate = sections.find((s) => s.startsWith('Cross-session trussFile gate'))
  const find = sections.find((s) => s.startsWith('Find and resume'))
  assert.ok(gate && find, 'both run-survival sections are in the feature doc')
  const gateCases = casesOf(gate)
  const findCases = casesOf(find)
  assert.ok(gateCases.length > 0 && findCases.length > 0, 'both sections cite cases')
  for (const n of gateCases) assert.ok(/trussFile gate/.test(titles[n - 1] ?? ''), `gate section cites case ${n}, titled "${titles[n - 1]}"`)
  for (const n of findCases) assert.ok(!/trussFile gate/.test(titles[n - 1] ?? ''), `find section cites case ${n}, titled "${titles[n - 1]}"`)
  const allGate = titles.map((t, i) => (/trussFile gate/.test(t) ? i + 1 : 0)).filter(Boolean)
  assert.deepEqual(gateCases, allGate, 'the gate section cites every trussFile gate case')
})

test('a start writes no undeclared crew field into plan.json', () => {
  const tr = root()
  const repo = mkRepo({ config: CFG })
  try {
    const dir = session(repo, planObj([crew('x', { stage: 1 })]))
    const r = runCli(REAL_FACTORY, 'start', [...startArgs(repo, dir), '--no-workflow'], repo, { TRUSS_TRANSCRIPTS_ROOT: tr })
    assert.equal(r.status, 0, say(r))
    const base = Object.keys(planObj([crew('x', { stage: 1 })]).crews[0])
    const extra = Object.keys(readPlan(dir).crews[0]).filter((k) => !base.includes(k) && k !== 'status')
    assert.deepEqual(extra, [], 'plan.schema.json forbids extra crew fields')
  } finally {
    for (const d of [tr, repo]) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
  }
})

test('a later start leaves a running project-manager-path crew alone when its plan entry has no engine stamp', () => {
  const tr = root()
  const repo = mkRepo({ config: CFG })
  try {
    const dir = session(repo, planObj([crew('x', { stage: 1 }), crew('y', { stage: 1 })]))
    const first = runCli(REAL_FACTORY, 'start', [...startArgs(repo, dir), '--no-workflow'], repo, { TRUSS_TRANSCRIPTS_ROOT: tr })
    assert.equal(first.status, 0, say(first))
    const p = readPlan(dir)
    for (const c of p.crews) {
      c.status = 'running'
      delete c.engine // a run that a start before 0.32.0 set running
    }
    writePlan(dir, p)
    runCli(REAL_FACTORY, 'start', startArgs(repo, dir), repo, { TRUSS_TRANSCRIPTS_ROOT: tr })
    const spawns = readEvents(dir).filter((e) => e.event === 'spawn' && e.type === 'workflow-crew' && e.by === 'factory')
    assert.equal(spawns.length, 0, 'no workflow crew is started over a project-manager crew')
    assert.deepEqual(readPlan(dir).crews.map((c: any) => c.status), ['running', 'running'], 'both crews stay running')
  } finally {
    for (const d of [tr, repo]) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
  }
})
