// @ts-nocheck
// Factory fixes from the 2026-11-07 client request (truss ADR-0030): finish retires every member worktree and branch of a terminal
// crew, archiving a branch tip the target lacks; an untracked symlink into the main checkout is clean; a worktree with real changes
// stays and is reported; a process inside a retired worktree is never signalled or waited on (0.20.1: Claude Code's TaskStop
// stops what a finished agent or background shell left running, so truss reads no process table and kills nothing).

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import * as reg from '../hooks/register.ts'
import { ARCHIVE_PREFIX, worktreeChanges } from '../bin/factory.ts'
import * as factory from '../bin/factory.ts'
import { addCrewWorktree, appendEvent, crew, factorySpawn, git, gitStatus, head, mkEnv, mkRun, planObj, putFile, qcReport, readEvents, tmp, validateEvent, writePlan } from './fixtures/workflow-run/harness.ts'

const t = (name, a, b) => (b === undefined ? test(name, { timeout: 30000 }, a) : test(name, { timeout: 30000, ...a }, b))
const CFG = { merge: 'sequential', target: 'main' }
const RUN = 'wf_c8new000-aaa'
const OLD = 'wf_c8old000-bbb'
const say = (r) => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 900)}; stderr ${String(r.stderr).slice(0, 300)}`
const branchExists = (repo, b) => gitStatus(repo, ['rev-parse', '--verify', '-q', `refs/heads/${b}`]) === 0
const refSha = (repo, ref) => git(repo, ['rev-parse', '--verify', '-q', ref], true)
const left = (j) => (Array.isArray(j.leftWorktrees) ? j.leftWorktrees : [])
const retires = (env) => readEvents(env.dir).filter((e) => e.event === 'retire')

function patchId(cwd, base, hd) {
  const [diffCmd, idCmd] = reg.PATCH_COMMAND.split(' | ').map((s) => s.replace('<base>', base).replace('<head>', hd).split(' '))
  const d = spawnSync(diffCmd[0], diffCmd.slice(1), { cwd, encoding: 'utf8' })
  const p = spawnSync(idCmd[0], idCmd.slice(1), { cwd, input: d.stdout, encoding: 'utf8' })
  return reg.patchIdOf(p.stdout)
}
const wfPath = (env, name) => `${env.repo}/.claude/worktrees/${name}`
// A member worktree <name> on branch worktree-<name>, forked from `from`, with one commit of its own when `commit` is set.
function member(env, name, from, commit) {
  const p = wfPath(env, name)
  git(env.repo, ['worktree', 'add', '-q', '-b', `worktree-${name}`, p, from])
  git(p, ['config', 'user.name', 'T'])
  git(p, ['config', 'user.email', 't@e.invalid'])
  if (commit !== undefined) putFile(p, `src/s/${commit}.ts`, `${commit}\n`, commit)
  return p
}
const agent = (label, cwd, over = {}) => ({ label, agentType: 'general-purpose', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', result: 'built it', ...(cwd === undefined ? {} : { cwd }), ...over })

/**
 * Crew s (running) with a commit and a red record, merged by run RUN; crew t (running) also in RUN; crew d dropped.
 * o.members(env, wt) adds member worktrees before the runs are written and returns {runAgents, oldAgents}: agents of RUN
 * besides the s-qc, and agents of the older run OLD (written with spawn events, as an earlier finish recorded them).
 */
function world(o) {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('s', { status: 'running' }), crew('t', { status: 'running' }), crew('d', { status: 'dropped' })], { approvedAt: '2026-10-01T00:00:00.000Z' }))
  const when = new Date(Date.now() - 3 * 3600_000).toISOString()
  appendEvent(env.dir, factorySpawn('s', when))
  appendEvent(env.dir, factorySpawn('t', when))
  const wt = addCrewWorktree(env.repo, 's')
  putFile(wt, 'src/s/a.ts', 's\n', 'work')
  const { runAgents, oldAgents } = o.members(env, wt)
  // the crew head gets one more commit after the members forked, so a member tip is a stale version the target never takes
  putFile(wt, 'src/s/final.ts', 'final\n', 'final')
  const base = git(wt, ['merge-base', 'main', 'HEAD'])
  const hd = head(wt)
  mkdirSync(`${env.dir}/checks`, { recursive: true })
  writeFileSync(`${env.dir}/checks/s-1.json`, JSON.stringify({ command: 'true', exit: 1, head: hd, tail: '' }))
  if (oldAgents.length > 0) {
    const old = mkRun(env.transcripts, OLD, oldAgents)
    for (const a of oldAgents) appendEvent(env.dir, { event: 'spawn', crew: a.label.split('-')[0], agent: a.label, agentId: old.ids[a.label], type: 'general-purpose', model: 'claude-sonnet-5-5', effort: 'medium', by: `workflow:${OLD}` })
  }
  const qc = agent('s-qc', undefined, { agentType: 'truss:qc-engineer', metaModel: 'opus', model: 'claude-opus-5-5', result: qcReport({ head: hd, patch: patchId(wt, base, hd) }) })
  const run = mkRun(env.transcripts, RUN, [...runAgents, qc])
  const resFile = `${env.dir}/result.json`
  writeFileSync(resFile, JSON.stringify([{ slug: 's', state: 'passed', head: hd, base, qc: 's-qc' }]))
  return { env, wt, finish: () => env.run('finish', { transcript: run.dir, result: resFile }) }
}

t('r1: a merged crew retires every member of this run and of an older run, archiving each tip the target lacks; another crew\'s member stays', () => {
  let tips = {}
  const w = world({
    members: (env, wt) => {
      const builder = member(env, `${RUN}-1`, 'truss-s', 'b1')
      const tester = member(env, `${RUN}-2`, 'truss-s')
      const other = member(env, `${RUN}-3`, 'main', 't1')
      const oldB = member(env, `${OLD}-4`, 'truss-s', 'o4')
      const gone = member(env, `${OLD}-5`, 'truss-s', 'o5')
      const dropped = member(env, `${OLD}-6`, 'main', 'd6')
      tips = { b1: head(builder), o4: head(oldB), o5: head(gone), d6: head(dropped), tester: head(tester), other }
      git(env.repo, ['worktree', 'remove', gone])
      return {
        runAgents: [agent('s-builder', builder), agent('s-tester', tester), agent('t-builder', other)],
        oldAgents: [agent('s-builder', oldB), agent('s-tester', gone), agent('d-builder', dropped)],
      }
    },
  })
  addCrewWorktree(w.env.repo, 'd')
  const r = w.finish()
  const repo = w.env.repo
  assert.deepEqual(r.json?.merged, ['s'], say(r))
  for (const n of [`${RUN}-1`, `${RUN}-2`, `${OLD}-4`, `${OLD}-6`]) {
    assert.ok(!existsSync(wfPath(w.env, n)), `${n} must be removed: ${say(r)}`)
    assert.ok(!branchExists(repo, `worktree-${n}`), `worktree-${n} must be deleted`)
  }
  assert.ok(!branchExists(repo, `worktree-${OLD}-5`), 'a member branch whose worktree was already gone is retired too')
  assert.equal(refSha(repo, `${ARCHIVE_PREFIX}/${RUN}/worktree-${RUN}-1`), tips.b1, 'the stale builder tip is archived')
  assert.equal(refSha(repo, `${ARCHIVE_PREFIX}/${OLD}/worktree-${OLD}-4`), tips.o4)
  assert.equal(refSha(repo, `${ARCHIVE_PREFIX}/${OLD}/worktree-${OLD}-5`), tips.o5)
  assert.equal(refSha(repo, `${ARCHIVE_PREFIX}/${OLD}/worktree-${OLD}-6`), tips.d6)
  assert.equal(refSha(repo, `${ARCHIVE_PREFIX}/${RUN}/worktree-${RUN}-2`), '', 'a tip the target holds needs no archive')
  assert.ok(!existsSync(`${repo}/.claude/worktrees/truss-d`) && !branchExists(repo, 'truss-d'), 'the dropped crew\'s own worktree and branch go')
  assert.ok(existsSync(tips.other) && branchExists(repo, `worktree-${RUN}-3`), 'crew t is still running: its member stays')
  assert.ok(left(r.json).some((l) => l.branch === `worktree-${RUN}-3` && l.why === 'unmerged'), JSON.stringify(r.json.leftWorktrees))
  const ev = retires(w.env)
  const by = (b) => ev.find((e) => e.branch === b)
  assert.equal(by(`worktree-${RUN}-1`)?.reason, 'superseded', JSON.stringify(ev))
  assert.equal(by(`worktree-${RUN}-2`)?.reason, 'merged')
  assert.equal(by(`worktree-${OLD}-4`)?.reason, 'superseded')
  assert.equal(by(`worktree-${OLD}-5`)?.worktree, null)
  assert.equal(by(`worktree-${OLD}-6`)?.reason, 'dropped')
  assert.equal(by('truss-d')?.reason, 'dropped')
  assert.equal(by('truss-s')?.reason, 'merged', 'the merged crew\'s own branch goes too')
  assert.equal(ev.length, 7, JSON.stringify(ev))
  for (const e of ev) assert.deepEqual(validateEvent(e), [], JSON.stringify(e))
})

t('r2: an untracked symlink into the main checkout is clean; a symlink elsewhere or an untracked file is real work and the worktree stays', () => {
  const outside = tmp('c8-outside-')
  let paths = {}
  const w = world({
    members: (env) => {
      mkdirSync(`${env.repo}/node_modules`, { recursive: true })
      const linked = member(env, `${RUN}-1`, 'truss-s')
      mkdirSync(`${linked}/ui`, { recursive: true })
      symlinkSync(`${env.repo}/node_modules`, `${linked}/ui/node_modules`)
      const foreign = member(env, `${RUN}-2`, 'truss-s')
      symlinkSync(outside, `${foreign}/elsewhere`)
      const file = member(env, `${RUN}-3`, 'truss-s')
      writeFileSync(`${file}/notes.txt`, 'unsaved\n')
      paths = { linked, foreign, file }
      return { runAgents: [agent('s-builder', linked), agent('s-tester', foreign), agent('s-writer', file)], oldAgents: [] }
    },
  })
  assert.deepEqual(worktreeChanges(paths.linked, w.env.repo), { real: [], links: [`${paths.linked}/ui/node_modules`] })
  const r = w.finish()
  assert.deepEqual(r.json?.merged, ['s'], say(r))
  assert.ok(!existsSync(paths.linked) && !branchExists(w.env.repo, `worktree-${RUN}-1`), `the worktree with only the main-checkout link goes: ${say(r)}`)
  assert.ok(existsSync(`${w.env.repo}/node_modules`), 'the link target in the main checkout is untouched')
  for (const [p, n] of [[paths.foreign, 2], [paths.file, 3]]) {
    assert.ok(existsSync(p) && branchExists(w.env.repo, `worktree-${RUN}-${n}`), `${p} stays`)
    assert.ok(left(r.json).some((l) => l.path === p && l.why === 'dirty'), JSON.stringify(r.json.leftWorktrees))
  }
})

// A fixture child sleeping with cwd in `dir`; `ours` gives it CLAUDECODE=1 as Claude Code's commands have, `stubborn` ignores SIGTERM.
function child(dir, ours, stubborn) {
  const env = { ...process.env }
  delete env.CLAUDECODE
  if (ours) env.CLAUDECODE = '1'
  const code = `${stubborn ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000)`
  return spawn(process.execPath, ['-e', code], { cwd: dir, env, stdio: 'ignore' })
}
const gone = (pid) => {
  try {
    process.kill(pid, 0)
    return spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().startsWith('Z')
  } catch {
    return true
  }
}
const waitFor = (cond, ms) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 50)'])
  return cond()
}
const linux = process.platform === 'linux'

t('r3: processes inside member worktrees, the run\'s own and anyone else\'s, keep nothing and are never touched; the worktrees go and no stop event is written', { skip: !linux }, (ctx) => {
  const kids = []
  ctx.after(() => kids.forEach((k) => k.kill('SIGKILL')))
  let p
  let q
  const w = world({
    members: (env) => {
      p = member(env, `${RUN}-1`, 'truss-s')
      q = member(env, `${RUN}-2`, 'truss-s')
      return { runAgents: [agent('s-builder', p), agent('s-tester', q)], oldAgents: [] }
    },
  })
  const theirs = child(p, false, false)
  const ours = child(q, true, true)
  kids.push(theirs, ours)
  assert.ok(waitFor(() => !gone(theirs.pid) && !gone(ours.pid), 5000), 'both children run')
  const r = w.finish()
  assert.deepEqual(r.json?.merged, ['s'], say(r))
  assert.ok(!existsSync(p) && !existsSync(q), `both worktrees go: ${say(r)}`)
  assert.ok(!(r.json.leftWorktrees ?? []).some((l) => /process/.test(l.why)), JSON.stringify(r.json.leftWorktrees))
  assert.ok(!gone(theirs.pid) && !gone(ours.pid), 'neither process is signalled')
  assert.equal(readEvents(w.env.dir).filter((e) => e.event === 'stop').length, 0)
})

t('r4: factory exports no process scan or stopper and reads no other process\'s cwd or environment', () => {
  assert.equal(factory.processesIn, undefined)
  assert.equal(factory.stopPid, undefined)
  const src = readFileSync(new URL('../bin/factory.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /\/cwd`|\/environ`|\bps -A|lsof|Win32_Process|taskkill/)
})

t('r5: the session start time is read from /proc on Linux, by ps on macOS and PowerShell on Windows (ADR-0033; tests/personas-platform.check.ts); when that read gives nothing it is unknown (the caller then warns), and the test override works everywhere', () => {
  const env = { CLAUDE_PID: String(process.pid) }
  const none = { exec: () => undefined, now: () => Date.now() }
  for (const os of ['darwin', 'win32']) {
    assert.equal(factory.sessionStart(env, os, none), undefined, os)
    assert.equal(factory.sessionStart({ ...env, TRUSS_SESSION_START: '1234' }, os), 1234, os)
  }
  if (linux) {
    const s = factory.sessionStart(env, 'linux')
    assert.ok(typeof s === 'number' && s <= Date.now() && s > Date.now() - 600000, String(s))
  }
})

t('r6: pid liveness is process.kill(pid, 0) on every OS; a gone pid is dead, a live one alive, without /proc off Linux', () => {
  const done = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  const dead = Number(done.stdout)
  for (const os of ['linux', 'darwin', 'win32']) {
    assert.equal(factory.pidAlive(process.pid, os), true, os)
    assert.equal(factory.pidAlive(dead, os), false, os)
    assert.equal(factory.pidAlive('12', os), false, os)
  }
})
