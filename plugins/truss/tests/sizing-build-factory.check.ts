// @ts-nocheck
// ADR-0031 sections 6 and 7 (plan-check rules, start decision line and resume refusal, the land merge gate), written from the ADR
// before the builders' implementation. Complements sizing-contract.check.ts, which pins the happy paths.
// Plain node --test: 0 agents, 0 model calls; fixture repos and truss dirs under os.tmpdir() through the shared harness.
// Titles start with the command word (plan-check, start or land) after the prefix, so builders can select cases by it.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import * as reg from '../hooks/register.ts'
import {
  addCrewWorktree, crew, git, head, mkEnv, planObj, putFile, qcReport, readPlan, writeGoal, writePlan, writeReport,
} from './fixtures/workflow-run/harness.ts'

const CFG = { merge: 'sequential', target: 'main' }
const P = 'sizing build: '
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`
const v = (version: number, crews: any[], over: Record<string, unknown> = {}) => planObj(crews, { version, ...over })
const decisions = (env: any): string => readFileSync(join(env.dir, 'decisions.md'), 'utf8')

function planCheck(env: any, plan: unknown) {
  writePlan(env.dir, plan)
  return env.run('plan-check', { repo: null })
}
function assertRefusedFor(r: any, text: string) {
  assert.equal(r.status, 1, say(r))
  const errs: string[] = Array.isArray(r.json?.errors) ? r.json.errors : []
  assert.ok(errs.includes(text) || errs.some((e) => e.startsWith(text)), `want an error "${text}" in ${JSON.stringify(errs)}`)
}
function assertAccepted(r: any) {
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json?.ok, true, say(r))
}

// ---------------------------------------------------------------------------------------------------------------
// plan-check

test(P + 'plan-check refuses an unknown process', () => {
  const env = mkEnv({ config: CFG })
  assertRefusedFor(planCheck(env, v(4, [crew('x', { process: 'huge' })])), 'x: process must be solo, lean or full')
  assertRefusedFor(planCheck(env, v(4, [crew('x', { process: 7 })])), 'x: process must be solo, lean or full')
})

test(P + 'plan-check refuses process, qc and red on a version 3 plan', () => {
  const env = mkEnv({ config: CFG })
  assertRefusedFor(planCheck(env, v(3, [crew('x', { process: 'solo' })])), 'x: process is version 4 only')
  const r = planCheck(env, v(3, [crew('y', { process: 'lean', qc: true, red: false })]))
  assertRefusedFor(r, 'y: process is version 4 only')
  assertRefusedFor(r, 'y: qc is version 4 only')
  assertRefusedFor(r, 'y: red is version 4 only')
  // the same on version 2
  assertRefusedFor(planCheck(env, v(2, [crew('z', { process: 'full' })])), 'z: process is version 4 only')
  // control: the same crews without the fields pass at 3
  assertAccepted(planCheck(env, v(3, [crew('x'), crew('y')])))
})

test(P + 'plan-check refuses qc or red on a solo or full crew', () => {
  const env = mkEnv({ config: CFG })
  for (const process of ['solo', 'full']) {
    assertRefusedFor(planCheck(env, v(4, [crew('x', { process, qc: true })])), 'x: qc is lean only')
    assertRefusedFor(planCheck(env, v(4, [crew('x', { process, red: false })])), 'x: red is lean only')
  }
  // a crew with no process is a full crew
  assertRefusedFor(planCheck(env, v(4, [crew('x', { qc: false })])), 'x: qc is lean only')
  assertRefusedFor(planCheck(env, v(4, [crew('x', { red: true })])), 'x: red is lean only')
})

test(P + 'plan-check refuses a non-boolean or missing qc or red on a lean crew', () => {
  const env = mkEnv({ config: CFG })
  const ln = (over: Record<string, unknown>) => v(4, [crew('l', { process: 'lean', estAgents: 2, ...over })])
  assertAccepted(planCheck(env, ln({ qc: true, red: false })))
  assertRefusedFor(planCheck(env, ln({ qc: 'yes', red: true })), 'l: qc must be a boolean on a lean crew')
  assertRefusedFor(planCheck(env, ln({ qc: true, red: 1 })), 'l: red must be a boolean on a lean crew')
  assertRefusedFor(planCheck(env, ln({ qc: true })), 'l: red must be a boolean on a lean crew')
  assertRefusedFor(planCheck(env, ln({ red: true })), 'l: qc must be a boolean on a lean crew')
})

test(P + 'plan-check accepts a version 4 plan with no process field', () => {
  const env = mkEnv({ config: CFG })
  assertAccepted(planCheck(env, v(4, [crew('a'), crew('b', { stage: 2, estAgents: 6 })])))
})

// ---------------------------------------------------------------------------------------------------------------
// start

test(P + 'start appends the decision line for a direct crew', () => {
  const env = mkEnv({ config: CFG })
  const crews = [crew('sa', { process: 'solo' }), crew('le', { process: 'lean', qc: false, red: true, estAgents: 2 })]
  writePlan(env.dir, v(4, crews))
  for (const c of crews) writeGoal(env.dir, c.slug as string)
  const r = env.run('start', { stage: 1 })
  assert.equal(r.status, 0, say(r))
  const text = decisions(env)
  assert.match(text, /started direct crew sa \(process solo\) in stage 1/, text)
  assert.match(text, /started direct crew le \(process lean\) in stage 1/, text)
  assert.match(text, /worktree truss-sa from main/, text)
})

test(P + 'start under merge single lists a lean crew under foremen, not direct', () => {
  const env = mkEnv({ config: { merge: 'single', target: 'main' } })
  const crews = [crew('le', { process: 'lean', qc: false, red: true, estAgents: 2 })]
  writePlan(env.dir, v(4, crews))
  for (const c of crews) writeGoal(env.dir, c.slug as string)
  const r = env.run('start', { stage: 1 })
  assert.equal(r.status, 0, say(r))
  assert.deepEqual((r.json?.direct ?? []).map((x: any) => x.slug), [], say(r))
  const foremen = (r.json?.foremen ?? []).map((x: any) => (typeof x === 'string' ? x : x.slug))
  assert.deepEqual(foremen, ['le'], say(r))
})

test(P + 'start --slug S --resume refuses a solo or lean crew with exit 1 and a why that names the merge command',() => {
  for (const c of [{ process: 'solo' }, { process: 'lean', qc: true, red: true, estAgents: 2 }]) {
    const env = mkEnv({ config: CFG })
    writePlan(env.dir, v(4, [crew('d', { status: 'running', ...c })]))
    writeGoal(env.dir, 'd')
    addCrewWorktree(env.repo, 'd')
    for (const kind of ['merge-ready', 'stale', 'answers']) {
      const r = env.run('start', { slug: 'd', resume: kind, transcript: env.transcripts })
      assert.equal(r.status, 1, say(r))
      const why = String(r.json?.why ?? r.json?.refused?.[0]?.why ?? '')
      assert.match(why, /land/, say(r))
      assert.match(why, new RegExp(String(c.process)), say(r))
    }
    assert.equal(readPlan(env.dir).crews[0].status, 'running')
  }
})

// ---------------------------------------------------------------------------------------------------------------
// land

/** The patch id of base...hd in `cwd`, via the hook's PATCH_COMMAND. */
function patchId(cwd: string, base: string, hd: string): string | undefined {
  const [diffCmd, idCmd] = reg.PATCH_COMMAND.split(' | ').map((s) => s.replace('<base>', base).replace('<head>', hd).split(' '))
  const d = spawnSync(diffCmd[0], diffCmd.slice(1), { cwd, encoding: 'utf8' })
  const p = spawnSync(idCmd[0], idCmd.slice(1), { cwd, input: d.stdout, encoding: 'utf8' })
  return reg.patchIdOf(p.stdout)
}

/** A land world: plan v4 with one crew, a crew worktree holding one commit inside owns. */
function landWorld(slug: string, c: Record<string, unknown>) {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, v(4, [crew(slug, { status: 'running', ...c })]))
  writeGoal(env.dir, slug)
  const wt = addCrewWorktree(env.repo, slug)
  putFile(wt, `src/${slug}/a.ts`, `${slug}\n`, `work ${slug}`)
  const hd = head(wt)
  const base = git(wt, ['merge-base', 'main', 'HEAD'])
  return { env, wt, head: hd, base, mainBefore: git(env.repo, ['rev-parse', 'main']), slug }
}
function assertRefused(w: any, r: any, whyRe: RegExp, status = 'running') {
  assert.equal(r.status, 1, say(r))
  assert.equal(r.json?.merged, false, say(r))
  assert.equal(r.json.slug, w.slug)
  assert.match(String(r.json.why), whyRe, say(r))
  assert.equal(git(w.env.repo, ['rev-parse', 'main']), w.mainBefore, 'the target is unchanged')
  assert.equal(readPlan(w.env.dir).crews[0].status, status)
  assert.ok(existsSync(w.wt), 'the crew worktree stays')
  assert.doesNotMatch(decisions(w.env), /merged into/, 'nothing is written')
}
function redRecord(w: any, exit: number) {
  mkdirSync(join(w.env.dir, 'checks'), { recursive: true })
  writeFileSync(join(w.env.dir, 'checks', `${w.slug}-1.json`), JSON.stringify({ command: 'true', exit, head: w.head, tail: '' }))
}

test(P + 'land exits 2 with error for a missing --slug', () => {
  const w = landWorld('a', { process: 'solo' })
  const r = w.env.run('land')
  assert.equal(r.status, 2, say(r))
  assert.equal(typeof r.json?.error, 'string', say(r))
  assert.equal(git(w.env.repo, ['rev-parse', 'main']), w.mainBefore)
})

test(P + 'land exits 2 with error for an unknown slug', () => {
  const w = landWorld('a', { process: 'solo' })
  const r = w.env.run('land', { slug: 'nope' })
  assert.equal(r.status, 2, say(r))
  assert.equal(typeof r.json?.error, 'string', say(r))
  assert.equal(git(w.env.repo, ['rev-parse', 'main']), w.mainBefore)
  assert.equal(readPlan(w.env.dir).crews[0].status, 'running')
})

test(P + 'land refuses a crew with no process or process full and names process', () => {
  for (const c of [{}, { process: 'full' }]) {
    const w = landWorld('f', c)
    assertRefused(w, w.env.run('land', { slug: 'f' }), /process/)
  }
})

test(P + 'land refuses a crew that is not running', () => {
  for (const status of ['planned', 'merged']) {
    const w = landWorld('n', { process: 'solo', status })
    assertRefused(w, w.env.run('land', { slug: 'n' }), /./, status)
  }
})

test(P + 'land refuses a lean crew with red true and no red record, then with a zero-exit record', () => {
  const w = landWorld('lr', { process: 'lean', qc: false, red: true, estAgents: 2 })
  assertRefused(w, w.env.run('land', { slug: 'lr' }), /red/i)
  redRecord(w, 0)
  assertRefused(w, w.env.run('land', { slug: 'lr' }), /red/i)
})

test(P + 'land lands a lean crew with red true and a red record with non-zero exit and qc false', () => {
  const w = landWorld('lg', { process: 'lean', qc: false, red: true, estAgents: 2 })
  redRecord(w, 1)
  const r = w.env.run('land', { slug: 'lg' })
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json?.merged, true, say(r))
  assert.equal(r.json.process, 'lean')
  assert.equal(r.json.qc, false)
  assert.equal(r.json.red, true)
  assert.equal(r.json.head, w.head)
  assert.equal(git(w.env.repo, ['rev-parse', 'main']), w.head)
  assert.equal(readPlan(w.env.dir).crews[0].status, 'merged')
  assert.ok(!existsSync(w.wt), 'the crew worktree is removed')
  const text = decisions(w.env)
  assert.match(text, new RegExp(`crew lg merged into main at ${w.head} \\| land: process lean, qc false, red true`), text)
  assert.match(text, /red record exit 1/, text)
})

test(P + 'land lands a lean crew with qc true and a QC PASS on its head', () => {
  const w = landWorld('lp', { process: 'lean', qc: true, red: false })
  writeReport(w.env.dir, 'lp', 'qc-1', qcReport({ verdict: 'PASS', head: w.head, patch: patchId(w.wt, w.base, w.head) }))
  const r = w.env.run('land', { slug: 'lp' })
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json?.merged, true, say(r))
  assert.equal(r.json.qc, true)
  assert.equal(r.json.red, false)
  assert.equal(git(w.env.repo, ['rev-parse', 'main']), w.head)
  assert.equal(readPlan(w.env.dir).crews[0].status, 'merged')
  assert.match(decisions(w.env), new RegExp(`crew lp merged into main at ${w.head} \\| land: process lean, qc true, red false.*QC PASS on ${w.head.slice(0, 7)}`), decisions(w.env))
})

test(P + 'land refuses a lean crew with a QC PASS that has an UNSCOPED finding', () => {
  const w = landWorld('lu', { process: 'lean', qc: true, red: false })
  writeReport(w.env.dir, 'lu', 'qc-1', qcReport({ verdict: 'PASS', head: w.head, unscoped: 1 }))
  assertRefused(w, w.env.run('land', { slug: 'lu' }), /qc|unscoped/i)
})
