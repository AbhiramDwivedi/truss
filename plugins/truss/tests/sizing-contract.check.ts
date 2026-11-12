// @ts-nocheck
// ADR-0031 (right-size the process per task) seams: factory.ts plan-check, start and land, the sizing-engineer agent file,
// and two guards (finish for a full crew, the plan gate). Written from the ADR before the implementation existed.
// Plain node --test: 0 agents, 0 model calls; fixture repos and truss dirs under os.tmpdir() through the shared harness.
//
// Open points the ADR leaves (none blocks these tests): the exact wording of `why` (asserted only by slug field and rule word),
// and the `start` output key `direct` entries' shape, which the ADR gives as { slug, process, qc, red, worktree, branch }.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import * as reg from '../hooks/register.ts'
import {
  REAL_PLUGIN, addCrewWorktree, appendEvent, crew, factorySpawn, flat, git, head, mkEnv, mkRun, planObj, putFile,
  qcReport, readEvents, readPlan, writeGoal, writePlan, writeReport,
} from './fixtures/workflow-run/harness.ts'

const CFG = { merge: 'sequential', target: 'main' }
const P = 'sizing contract: '
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`
const v4 = (crews: any[], over: Record<string, unknown> = {}) => planObj(crews, { version: 4, ...over })
const lean = (slug: string, over: Record<string, unknown> = {}) => crew(slug, { process: 'lean', qc: true, red: true, ...over })
const solo = (slug: string, over: Record<string, unknown> = {}) => crew(slug, { process: 'solo', ...over })

/** plan-check on a plan; returns the result with `errors` (array) when refused. */
function planCheck(env: any, plan: unknown) {
  writePlan(env.dir, plan)
  return env.run('plan-check', { repo: null })
}
/** Asserts plan-check refused with an error that starts with `<slug>: ` and names `rule`; a version refusal alone fails this. */
function assertRefusedFor(r: any, slug: string, rule: string) {
  assert.equal(r.status, 1, say(r))
  const errs: string[] = Array.isArray(r.json?.errors) ? r.json.errors : []
  assert.ok(errs.some((e) => e.startsWith(`${slug}: `) && e.includes(rule)), `want an error "${slug}: ... ${rule} ..." in ${JSON.stringify(errs)}`)
}
function assertAccepted(r: any) {
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json?.ok, true, say(r))
}

test(P + 'plan-check accepts a version 4 plan with solo, lean and full crews', () => {
  const env = mkEnv({ config: CFG })
  const r = planCheck(env, v4([solo('a'), lean('b', { estAgents: 3 }), crew('c', { estAgents: 6 }), crew('d', { process: 'full', estAgents: 5 }), crew('e', { process: 'lean', qc: false, red: false, estAgents: 2 })]))
  assertAccepted(r)
})

test(P + 'plan-check refuses a solo crew with estAgents above 1', () => {
  const env = mkEnv({ config: CFG })
  assertAccepted(planCheck(env, v4([solo('s', { estAgents: 1 })])))
  assertRefusedFor(planCheck(env, v4([solo('s', { estAgents: 2 })])), 's', 'estAgents')
})

test(P + 'plan-check refuses a lean crew with estAgents above 3, or above 2 without qc', () => {
  const env = mkEnv({ config: CFG })
  assertAccepted(planCheck(env, v4([lean('l', { estAgents: 3 })])))
  assertAccepted(planCheck(env, v4([lean('l', { qc: false, estAgents: 2 })])))
  assertRefusedFor(planCheck(env, v4([lean('l', { estAgents: 4 })])), 'l', 'estAgents')
  assertRefusedFor(planCheck(env, v4([lean('l', { qc: false, red: false, estAgents: 3 })])), 'l', 'estAgents')
})

test(P + 'plan-check accepts a stage-0 design crew of any process (ADR-0042)', () => {
  const env = mkEnv({ config: CFG })
  const design = (over: Record<string, unknown>) => v4([crew('d', { stage: 0, verdict: 'design', ...over })], { approval: 'auto' })
  assertAccepted(planCheck(env, design({ process: 'full' })))
  assertAccepted(planCheck(env, design({})))
  assertAccepted(planCheck(env, design({ process: 'solo' })))
  assertAccepted(planCheck(env, design({ process: 'lean', qc: true, red: true })))
})

test(P + 'start lists solo and lean crews under direct and leaves them out of the Workflow args', () => {
  const env = mkEnv({ config: CFG })
  const crews = [solo('sa'), lean('le', { qc: true, red: false, estAgents: 2 }), crew('fu', { estAgents: 4 })]
  writePlan(env.dir, v4(crews))
  for (const c of crews) writeGoal(env.dir, c.slug as string)
  const r = env.run('start', { stage: 1 })
  assert.equal(r.status, 0, say(r))
  const j = r.json
  assert.ok(j && Array.isArray(j.direct), `a top-level direct array: ${say(r)}`)
  const bySlug = Object.fromEntries(j.direct.map((x: any) => [x.slug, x]))
  assert.deepEqual(Object.keys(bySlug).sort(), ['le', 'sa'])
  assert.deepEqual([bySlug.sa.process, bySlug.sa.qc, bySlug.sa.red], ['solo', false, false])
  assert.deepEqual([bySlug.le.process, bySlug.le.qc, bySlug.le.red], ['lean', true, false])
  for (const s of ['sa', 'le']) {
    assert.equal(bySlug[s].branch, `truss-${s}`)
    assert.ok(flat(bySlug[s].worktree).endsWith(`.claude/worktrees/truss-${s}`), bySlug[s].worktree)
    assert.ok(existsSync(join(env.repo, '.claude', 'worktrees', `truss-${s}`)), `worktree for ${s}`)
  }
  assert.deepEqual((j.truss?.crews ?? []).map((c: any) => c.slug), ['fu'], 'only the full crew goes to the Workflow args')
  for (const key of ['foremen', 'held', 'refused']) {
    const list = (j[key] ?? []).map((x: any) => (typeof x === 'string' ? x : x.slug))
    assert.ok(!list.includes('sa') && !list.includes('le'), `${key} holds a direct crew: ${JSON.stringify(j[key])}`)
  }
  const plan = readPlan(env.dir)
  for (const s of ['sa', 'le', 'fu']) assert.equal(plan.crews.find((c: any) => c.slug === s).status, 'running', s)
  const spawned = readEvents(env.dir).filter((e) => e.event === 'spawn' && e.by === 'factory').map((e) => e.crew)
  assert.deepEqual(spawned, ['fu'], 'no factory spawn line for a direct crew')
})

/** A land world: plan v4 with one running crew, a crew worktree holding one commit inside owns. */
function landWorld(slug: string, c: Record<string, unknown>) {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, v4([crew(slug, { status: 'running', ...c })]))
  writeGoal(env.dir, slug)
  const wt = addCrewWorktree(env.repo, slug)
  putFile(wt, `src/${slug}/a.ts`, `${slug}\n`, `work ${slug}`)
  return { env, wt, head: head(wt), mainBefore: git(env.repo, ['rev-parse', 'main']) }
}
function assertLanded(w: any, slug: string, r: any, process: string) {
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json?.merged, true, say(r))
  assert.equal(r.json.slug, slug)
  assert.equal(r.json.process, process)
  assert.equal(r.json.qc, false)
  assert.equal(r.json.red, false)
  assert.equal(r.json.head, w.head)
  assert.equal(git(w.env.repo, ['rev-parse', 'main']), w.head, 'the target fast-forwarded to the crew head')
  assert.equal(readPlan(w.env.dir).crews.find((c: any) => c.slug === slug).status, 'merged')
  assert.ok(!existsSync(join(w.env.repo, '.claude', 'worktrees', `truss-${slug}`)), 'the crew worktree is removed')
  assert.match(readFileSync(join(w.env.dir, 'decisions.md'), 'utf8'), new RegExp(`crew ${slug} merged into main at ${w.head} \\| land: process ${process}`))
}

test(P + 'land merges a solo crew with no red record and no QC file', () => {
  const w = landWorld('so', { process: 'solo' })
  assert.ok(!existsSync(join(w.env.dir, 'checks')) && !existsSync(join(w.env.dir, 'reports')), 'no red record and no QC file')
  assertLanded(w, 'so', w.env.run('land', { slug: 'so' }), 'solo')
})

test(P + 'land merges a lean crew with qc false and red false that has no red record and no QC file', () => {
  const w = landWorld('ln', { process: 'lean', qc: false, red: false, estAgents: 2 })
  assert.ok(!existsSync(join(w.env.dir, 'checks')) && !existsSync(join(w.env.dir, 'reports')), 'no red record and no QC file')
  assertLanded(w, 'ln', w.env.run('land', { slug: 'ln' }), 'lean')
})

test(P + 'land refuses a lean crew with qc true and no QC PASS', () => {
  const w = landWorld('lq', { process: 'lean', qc: true, red: false })
  const refusedFor = (r: any) => {
    assert.equal(r.status, 1, say(r))
    assert.equal(r.json?.merged, false, say(r))
    assert.equal(r.json.slug, 'lq')
    assert.match(String(r.json.why), /qc/i, say(r))
    assert.equal(git(w.env.repo, ['rev-parse', 'main']), w.mainBefore, 'the target is unchanged')
    assert.equal(readPlan(w.env.dir).crews.find((c: any) => c.slug === 'lq').status, 'running')
    assert.ok(existsSync(w.wt), 'the crew worktree stays')
  }
  refusedFor(w.env.run('land', { slug: 'lq' }))
  writeReport(w.env.dir, 'lq', 'qc-1', qcReport({ verdict: 'FAIL', head: w.head }))
  refusedFor(w.env.run('land', { slug: 'lq' }))
})

test(P + 'sizing-engineer frontmatter names no write tool', () => {
  const file = join(REAL_PLUGIN, 'agents', 'sizing-engineer.md')
  assert.ok(existsSync(file), `${file} is missing`)
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, 'utf8'))
  assert.ok(m, 'frontmatter block')
  const fm: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (kv) fm[kv[1]] = kv[2].trim()
  }
  assert.equal(fm.name, 'sizing-engineer')
  assert.equal(fm.model, 'sonnet')
  assert.ok(fm.tools, 'a tools line (no tools line would grant every tool)')
  const tools = fm.tools.split(',').map((t) => t.trim())
  for (const bad of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) assert.ok(!tools.includes(bad), `tools names ${bad}: ${fm.tools}`)
})

// ---------------------------------------------------------------------------------------------------------------
// guards

/** The patch id of base...hd in `cwd`, via the hook's PATCH_COMMAND. */
function patchId(cwd: string, base: string, hd: string): string | undefined {
  const [diffCmd, idCmd] = reg.PATCH_COMMAND.split(' | ').map((s) => s.replace('<base>', base).replace('<head>', hd).split(' '))
  const d = spawnSync(diffCmd[0], diffCmd.slice(1), { cwd, encoding: 'utf8' })
  const p = spawnSync(idCmd[0], idCmd.slice(1), { cwd, input: d.stdout, encoding: 'utf8' })
  return reg.patchIdOf(p.stdout)
}

/** A finish world for one full crew `f` (no process field, plan version 2): a commit, optionally a red record, a QC PASS in the run. */
function finishWorld(red: boolean) {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('f', { status: 'running' })], { approvedAt: '2026-10-01T00:00:00.000Z' }))
  appendEvent(env.dir, factorySpawn('f', new Date(Date.now() - 3 * 3600_000).toISOString()))
  const wt = addCrewWorktree(env.repo, 'f')
  putFile(wt, 'src/f/a.ts', 'f\n', 'work f')
  const base = git(wt, ['merge-base', 'main', 'HEAD'])
  const hd = head(wt)
  const patch = patchId(wt, base, hd)
  if (red) {
    mkdirSync(join(env.dir, 'checks'), { recursive: true })
    writeFileSync(join(env.dir, 'checks', 'f-1.json'), JSON.stringify({ command: 'true', exit: 1, head: hd, tail: '' }))
  }
  const run = mkRun(env.transcripts, 'wf_1', [
    { label: 'f-builder', agentType: 'general-purpose', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', result: 'built it' },
    { label: 'f-qc', agentType: 'truss:qc-engineer', metaModel: 'opus', model: 'claude-opus-5-5', effort: 'medium', result: qcReport({ head: hd, patch }) },
  ])
  const resFile = join(env.dir, 'result.json')
  writeFileSync(resFile, JSON.stringify([{ slug: 'f', state: 'passed', head: hd, base, qc: 'f-qc' }]))
  return { env, head: hd, mainBefore: git(env.repo, ['rev-parse', 'main']), finish: () => env.run('finish', { transcript: run.dir, result: resFile }) }
}

test(P + 'finish still refuses a full crew without a red record', () => {
  const w = finishWorld(false)
  const r = w.finish()
  assert.equal(r.status, 1, say(r))
  assert.ok((r.json?.refused ?? []).some((x: any) => (typeof x === 'string' ? x : x.slug) === 'f'), `f is refused: ${say(r)}`)
  assert.ok(!(r.json?.merged ?? []).includes('f'), say(r))
  assert.equal(readPlan(w.env.dir).crews[0].status, 'running')
  assert.equal(git(w.env.repo, ['rev-parse', 'main']), w.mainBefore, 'the target is unchanged')
  // control: the same crew with a red record merges, so the refusal above is the missing record
  const ok = finishWorld(true)
  const r2 = ok.finish()
  assert.equal(r2.status, 0, say(r2))
  assert.deepEqual(r2.json?.merged, ['f'], say(r2))
})

test(P + 'the plan gate does not refuse a solo or lean crew for its process', () => {
  const plan = reg.parsePlan(JSON.stringify(v4([solo('sa'), lean('le', { estAgents: 3 }), lean('lf', { qc: false, red: false, estAgents: 2 }), crew('fu', { estAgents: 5 })])))
  assert.ok(plan, 'a version 4 plan parses')
  for (const name of ['sa', 'le', 'lf', 'fu']) assert.equal(reg.gateOf(plan, name), undefined, name)
  // control: the gate still refuses on its own rules (stage order), for a sized crew, without naming its process
  const behind = reg.parsePlan(JSON.stringify(v4([crew('first', { stage: 1 }), solo('later', { stage: 2 }), lean('later2', { stage: 2 })])))
  for (const name of ['later', 'later2']) {
    const g = reg.gateOf(behind, name)
    assert.ok(g, `${name} waits for stage 1`)
    assert.match(g.deny, /stage 1/)
    assert.doesNotMatch(g.deny, /process|solo|lean/)
  }
})
