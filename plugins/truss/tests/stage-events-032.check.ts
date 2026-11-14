// @ts-nocheck
// R-143: each stage step's event lands with the time that step ended, not the time finish ran. R-146: a test drives
// concludeFrontmatterMerge through finish. The wave-4 run (48e2a721) showed the symptom: its spawn, report, tag, allowance-spent
// and knowledge lines all share one finish second, because audit.ts appended them in one batch with `ts` = now.
// Contract (stage.js has no clock, ADR-0009): every crew result carries `stepEnds`, [{step, agent}] in the order the steps ended;
// finish stamps spawn (agent firstTs), report (agent lastTs), tag and knowledge (lastTs of the agent the result names) from transcripts.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import * as reg from '../hooks/register.ts'
import { concludeFrontmatterMerge } from '../bin/fragments.ts'
import { spawnSync } from 'node:child_process'
import { addCrewWorktree, appendEvent, assertOneLine, crew, factorySpawn, git, head, mkEnv, mkRun, planObj, putFile, qcReport, readEvents, tmp, validateEvent, writePlan } from './fixtures/workflow-run/harness.ts'

const APPROVED = '2026-10-01T00:00:00.000Z'
const CFG = { merge: 'sequential', target: 'main' }
const HOUR = 3600_000
const MIN = 60_000

const ROLES = {
  tester: { agentType: 'proj:tester', model: 'sonnet', effort: 'medium', isolation: 'worktree' },
  builder: { agentType: 'proj:builder', model: 'sonnet', effort: 'low', isolation: 'worktree' },
  writer: { agentType: 'truss:writer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  qc: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  runner: { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'none' },
}

/** The patch id of base...hd in `cwd`, computed with the exported PATCH_COMMAND. */
function patchId(cwd, base, hd) {
  const [diffCmd, idCmd] = reg.PATCH_COMMAND.split(' | ').map((s) => s.replace('<base>', base).replace('<head>', hd).split(' '))
  const d = spawnSync(diffCmd[0], diffCmd.slice(1), { cwd, encoding: 'utf8' })
  const p = spawnSync(idCmd[0], idCmd.slice(1), { cwd, input: d.stdout, encoding: 'utf8' })
  return reg.patchIdOf(p.stdout)
}

const writeCheck = (dir, slug, hd) => {
  mkdirSync(`${dir}/checks`, { recursive: true })
  writeFileSync(`${dir}/checks/${slug}-1.json`, JSON.stringify({ command: 'true', exit: 1, head: hd, tail: '' }))
}

/** A running crew `s` with one commit in its worktree, a red record and a spawn line from hours ago. */
function world(o = {}) {
  const env = mkEnv({ config: CFG, files: o.files })
  writePlan(env.dir, planObj([crew('s', { status: 'running', owns: o.owns ?? ['src/s/**'] })], { approvedAt: APPROVED }))
  appendEvent(env.dir, factorySpawn('s', new Date(Date.now() - 12 * HOUR).toISOString()))
  const wt = addCrewWorktree(env.repo, 's')
  return { env, wt }
}

/** Runs `finish --result` on a Workflow run `wf_1` holding `agents`, with `results` as the stage result. */
function finishWith(w, agents, results) {
  const run = mkRun(w.env.transcripts, 'wf_1', agents)
  const resFile = `${w.env.dir}/result.json`
  writeFileSync(resFile, JSON.stringify(results))
  return { run, res: w.env.run('finish', { transcript: run.dir, result: resFile }) }
}

const iso = (ms) => new Date(ms).toISOString()
const at = (ts) => Date.parse(ts)

test('each stage step event carries the time the step ended, not the time the stage run ended', () => {
  const w = world()
  putFile(w.wt, 'src/s/a.ts', 's\n', 'work')
  writeCheck(w.env.dir, 's', head(w.wt))
  // four steps ended hours before finish runs; each agent's transcript carries its own start and end
  const T = Date.now() - 6 * HOUR
  const span = (i) => ({ startTs: iso(T + i * 30 * MIN), endTs: iso(T + i * 30 * MIN + 10 * MIN) })
  const agents = [
    { label: 's-tester', agentType: 'proj:tester', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', ...span(0) },
    { label: 's-builder', agentType: 'proj:builder', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', ...span(1) },
    { label: 's-writer', agentType: 'truss:writer', metaModel: 'opus', model: 'claude-opus-5-5', effort: 'medium', ...span(2) },
    { label: 's-qc', agentType: 'truss:qc-engineer', metaModel: 'opus', model: 'claude-opus-5-5', effort: 'medium', result: qcReport({ head: head(w.wt) }), ...span(3) },
  ]
  const stepEnds = [{ step: 'red', agent: 's-tester' }, { step: 'green', agent: 's-builder' }, { step: 'knowledge', agent: 's-writer' }, { step: 'qc', agent: 's-qc' }]
  const result = { slug: 's', state: 'stopped', tag: 'BLOCKED', text: 'stopped at green for the test', at: 'green', knowledge: { items: 2, ran: true, sourceChanges: 0 }, stepEnds }
  const { run, res } = finishWith(w, agents, [result])
  assertOneLine(res)
  const ev = readEvents(w.env.dir)
  const finishedAt = Date.now()
  const spanOf = (label) => span(agents.findIndex((a) => a.label === label))
  const far = (e) => assert.ok(finishedAt - at(e.ts) > 4 * HOUR, `${e.event} line ts ${e.ts} is the finish time, not the step's: ${JSON.stringify(e)}`)
  for (const a of agents) {
    const spawn = ev.find((e) => e.event === 'spawn' && e.agentId === run.ids[a.label])
    assert.ok(spawn, `spawn line for ${a.label}`)
    far(spawn)
    assert.equal(at(spawn.ts), at(spanOf(a.label).startTs), `${a.label} spawn ts is its first transcript time`)
    const report = ev.find((e) => e.event === 'report' && e.agent === a.label)
    assert.ok(report, `report line for ${a.label}`)
    far(report)
    assert.equal(at(report.ts), at(spanOf(a.label).endTs), `${a.label} report ts is its last transcript time`)
  }
  const tag = ev.find((e) => e.event === 'tag' && e.crew === 's')
  assert.ok(tag, 'a tag line')
  far(tag)
  assert.equal(at(tag.ts), at(spanOf('s-builder').endTs), "the tag line takes the end of the step the stop names (at: green)")
  const knowledge = ev.find((e) => e.event === 'knowledge' && e.crew === 's')
  assert.ok(knowledge, 'a knowledge line')
  far(knowledge)
  assert.equal(at(knowledge.ts), at(spanOf('s-writer').endTs), "the knowledge line takes the end of the knowledge step's agent")
  for (const e of ev) assert.deepEqual(validateEvent(e), [], JSON.stringify(e))
})

test('three steps that end at different times give three different event times in events.jsonl', async () => {
  const { loadStageBundle } = await import('../bin/build-stage.ts')
  const calls = []
  const agent = async (prompt, opts = {}) => {
    calls.push(opts.label)
    if (/-runner(-\d+)?$/.test(String(opts.label))) return { exit: 0, stdout: JSON.stringify({ admitted: true }), status: '' }
    return 'done'
  }
  const stubs = { agent, args: { truss: { dir: '/', repo: '/', plugin: '/', roles: ROLES, crews: [] } }, log: () => {} }
  const { scope } = await loadStageBundle(stubs)
  const c = scope.makeCrew({ slug: 's', stage: 1, owns: ['src/s/**'] })
  // a crew passes through red, green and qc, each step running an agent (the steps set crew.step as chain.js does)
  for (const [step, role] of [['red', 'tester'], ['green', 'builder'], ['qc', 'qc']]) {
    c.step = step
    await scope.ask(c, role, `do the ${step} step`)
  }
  const result = scope.stopResult(c, new scope.Stop('BLOCKED', 'stopped at qc for the test', 'qc'))
  assert.deepEqual(result.stepEnds, [{ step: 'red', agent: 's-tester' }, { step: 'green', agent: 's-builder' }, { step: 'qc', agent: 's-qc' }])
  // the same result goes through finish; its agents' transcripts end at three different times, hours ago
  const w = world()
  putFile(w.wt, 'src/s/a.ts', 's\n', 'work')
  writeCheck(w.env.dir, 's', head(w.wt))
  const T = Date.now() - 8 * HOUR
  const ends = result.stepEnds.map((s, i) => T + (i + 1) * 45 * MIN)
  const agents = result.stepEnds.map((s, i) => ({ label: s.agent, agentType: ROLES[s.agent.replace(/^s-/, '')].agentType, metaModel: ROLES[s.agent.replace(/^s-/, '')].model, model: ROLES[s.agent.replace(/^s-/, '')].model === 'opus' ? 'claude-opus-5-5' : 'claude-sonnet-5-5', effort: 'medium', startTs: iso(ends[i] - 20 * MIN), endTs: iso(ends[i]), ...(s.agent === 's-qc' ? { result: qcReport({ head: head(w.wt) }) } : {}) }))
  const { res } = finishWith(w, agents, [result])
  assertOneLine(res)
  const reports = readEvents(w.env.dir).filter((e) => e.event === 'report' && result.stepEnds.some((s) => s.agent === e.agent))
  assert.equal(reports.length, 3)
  assert.equal(new Set(reports.map((e) => e.ts)).size, 3, `three different times: ${reports.map((e) => e.ts).join(', ')}`)
  result.stepEnds.forEach((s, i) => assert.equal(at(reports.find((e) => e.agent === s.agent).ts), ends[i], `${s.step} event time`))
})

test('finish merges a crew branch whose only conflict is doc frontmatter through concludeFrontmatterMerge', () => {
  const doc = 'docs/knowledge/store.md'
  const base = '---\nsources:\n  - a.ts\nverified: v0\n---\n# Store\n\nbody text\n'
  const w = world({ files: { [doc]: base }, owns: ['docs/knowledge/**'] })
  // the crew and the target each add their own source on the same lines; neither touches the body
  const crewHead = putFile(w.wt, doc, base.replace('  - a.ts', '  - a.ts\n  - b.ts'), 'crew adds b.ts')
  writeCheck(w.env.dir, 's', crewHead)
  putFile(w.env.repo, doc, base.replace('  - a.ts', '  - a.ts\n  - c.ts'), 'target adds c.ts')
  const mainBefore = git(w.env.repo, ['rev-parse', 'main'])
  // the QC ruling's patch is the one finish computes on the merged head: merge the same way in a throwaway worktree
  const scratch = `${tmp('stage-events-scratch-')}/wt`
  git(w.env.repo, ['worktree', 'add', '-q', '--detach', scratch, 'truss-s'])
  git(scratch, ['config', 'user.name', 'Test Writer'])
  git(scratch, ['config', 'user.email', 'tw@example.invalid'])
  const plain = spawnSync('git', ['merge', '--no-edit', mainBefore], { cwd: scratch, encoding: 'utf8' })
  assert.notEqual(plain.status, 0, 'the fixture must conflict under a plain git merge')
  assert.equal(concludeFrontmatterMerge(scratch).concluded, true)
  const qcPatch = patchId(scratch, git(scratch, ['merge-base', mainBefore, 'HEAD']), head(scratch))
  git(w.env.repo, ['worktree', 'remove', '--force', scratch])
  const agents = [
    { label: 's-builder', agentType: 'proj:builder', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium' },
    { label: 's-qc', agentType: 'truss:qc-engineer', metaModel: 'opus', model: 'claude-opus-5-5', effort: 'medium', result: qcReport({ head: crewHead, patch: qcPatch }) },
  ]
  const result = { slug: 's', state: 'passed', head: crewHead, base: git(w.wt, ['merge-base', 'main~1', 'truss-s']), qc: 's-qc', stepEnds: [{ step: 'qc', agent: 's-qc' }] }
  const { res } = finishWith(w, agents, [result])
  const j = assertOneLine(res)
  assert.equal(res.status, 0, res.stderr + res.stdout)
  assert.deepEqual(j.merged, ['s'], JSON.stringify(j))
  // the target now holds a merge commit with both parents, and the doc holds both sides' frontmatter and no conflict marker
  const main = git(w.env.repo, ['rev-parse', 'main'])
  assert.notEqual(main, mainBefore)
  const parents = git(w.env.repo, ['rev-list', '--parents', '-n', '1', 'main']).split(' ').slice(1)
  assert.equal(parents.length, 2, 'main is a merge commit')
  assert.ok(parents.includes(mainBefore) && parents.includes(crewHead), `parents ${parents} hold the old target and the crew head`)
  const text = git(w.env.repo, ['show', `main:${doc}`])
  assert.match(text, /sources:\n {2}- a\.ts\n {2}- b\.ts\n {2}- c\.ts\n/)
  assert.ok(!/^(<<<<<<<|=======|>>>>>>>)/m.test(text), 'no conflict marker')
  assert.equal(git(w.env.repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true), '', 'no merge left in progress')
  assert.equal(git(w.env.repo, ['status', '--porcelain', '--untracked-files=no']), '')
  assert.equal(git(w.env.repo, ['diff', '--name-only', '--diff-filter=U']), '', 'no unmerged path')
})
