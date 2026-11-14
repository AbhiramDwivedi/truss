// @ts-nocheck
// Truss 0.32.0, crew guards (R-134, R-136, R-137), written before the code.
//  - R-134: decision lines reach decisions.md only through `factory.ts decide`. The guard on Edit and Write is not enough: a
//    main-session Bash command that writes decisions.md (a redirect, tee, >>, sed -i, a heredoc, or any command that names the
//    file with a target the guard cannot resolve) is refused too, and fails closed. A member's command is not gated by it.
//  - R-136: `factory finish` retires the Claude Code Agent worktrees `.claude/worktrees/agent-<agentId>` (branch
//    `worktree-agent-<agentId>`, attributed to a crew by a `spawn` event carrying that agentId and crew) of merged or dropped
//    crews that hold no unmerged change or lock, and lists each kept one in `leftWorktrees` with why.
//  - R-137: cite-by-symbol (0.31.0) closed the citation coupling trap: a crew that changes the file a doc cites needs no doc edit.
//
// Run with: node --test plugins/truss/tests/guards-032.check.ts
// Red on the base (59f0848): cases 1 to 3 (a Bash write into decisions.md is allowed) and 5 and 6 (an agent- worktree of a
// terminal crew is left behind, without a listed why). Cases 4 and 7 are regression and confirm cases: they pass on the base.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import * as reg from '../hooks/register.ts'
import { citationLintFailures } from './fixtures/citations/line-citations.ts'
import { addCrewWorktree, appendEvent, crew, factorySpawn, git, gitStatus, head, mkEnv, mkRun, planObj, putFile, qcReport, writePlan } from './fixtures/workflow-run/harness.ts'

const ALLOWED = Symbol('allowed')
const PLUGIN = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1').replace(/\/$/, '')

// Registers the hooks against a stub runtime and returns a dispatcher over the Bash tool.call chain (detach-gate.check.ts drive()).
// The session's real decision log is <common>/truss/<session>/decisions.md, the path the Edit and Write guard compares.
async function drive(fn: (call: (command: string, extra?: Record<string, unknown>) => Promise<any>, at: { root: string; dir: string; log: string }) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'guards-032-')))
  try {
    const common = join(root, 'git')
    const sessionId = 's1'
    const dir = reg.trussDir(common, undefined, sessionId)
    mkdirSync(dir, { recursive: true })
    const $: any = {
      process: { run: async () => ({ exitCode: 0, stdout: `${common}\n`, stderr: '' }) },
      session: { cwd: async () => root, id: async () => sessionId },
      env: { get: async () => undefined },
      clock: { after: () => ({ cancel() {} }) },
      ui: { log: () => {} },
      fs: {
        exists: async () => false,
        read: async () => {
          throw new Error('no such file')
        },
        stat: async (p: string) => ({ realPath: p }),
        write: async () => {},
      },
      state: { get: async () => ({ value: undefined, version: 0 }), set: async () => ({ isSet: true, version: 1 }) },
    }
    const handlers: { filter: any; fn: any }[] = []
    const on: any = (...a: any[]) => {
      if (a[0] === 'tool.call') handlers.push({ filter: a.length >= 3 && a[1] && typeof a[1] === 'object' ? a[1] : undefined, fn: a[a.length - 1] })
      const chain: any = { catch: () => chain }
      return chain
    }
    reg.register(on)
    const matches = (filter: any) => filter === undefined || filter.tool === undefined || (Array.isArray(filter.tool) ? filter.tool.includes('Bash') : filter.tool === 'Bash')
    const call = async (command: string, extra: Record<string, unknown> = {}) => {
      const chain = handlers.filter((h) => matches(h.filter))
      const dispatch = async (i: number, ev: any): Promise<any> => (i >= chain.length ? ALLOWED : chain[i].fn($, ev, (next: any) => dispatch(i + 1, next)))
      return dispatch(0, { tool: 'Bash', args: { command }, ...extra })
    }
    await fn(call, { root, dir: reg.trussDir(common, undefined, sessionId).replace(/\\/g, '/'), log: `${reg.trussDir(common, undefined, sessionId).replace(/\\/g, '/')}/decisions.md` })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const denied = (v: any, what: string) => {
  assert.ok(v && typeof v === 'object' && typeof v.deny === 'string', `${what}: expected a deny, got ${v === ALLOWED ? 'allowed' : JSON.stringify(v)}`)
  assert.match(v.deny, /^\[truss\] Refused:/, what)
  assert.ok(v.deny.includes('factory.ts decide'), `${what}: the deny must name factory.ts decide: ${v.deny}`)
}

test('a main-session Bash redirect into decisions.md is refused with a message naming factory decide', async () => {
  await drive(async (call, at) => {
    const rel = at.log.slice(at.log.indexOf('/git/') + 1)
    const writes = [
      `echo x > ${at.log}`,
      `echo x>${at.log}`,
      `echo x 1> ${at.log}`,
      `echo x >| ${at.log}`,
      `echo x &> ${at.log}`,
      `: > ${at.log}`,
      `echo x > "${at.log}"`,
      `echo x > '${at.log}'`,
      `echo x > ${rel}`,
      `echo x > ./${rel}`,
      `cd ${at.dir} && echo x > decisions.md`,
      `cat <<EOF > ${at.log}\n- 12:00 | a | b | c | d\nEOF`,
      `cat > ${at.log} <<'EOF'\n- 12:00 | a | b | c | d\nEOF`,
      `bash -c 'echo x > ${at.log}'`,
      `sh -c "echo x > ${at.log}"`,
      `echo ok && echo x > ${at.log}`,
    ]
    for (const c of writes) denied(await call(c), c)
    // positive controls: a read is not a write, and the decide command itself is the one writer
    const reads = [`cat ${at.log}`, `grep -n foo ${at.log}`, `tail -n 5 ${at.log}`, `tail -n 3 ${at.log} | grep x`, `wc -l < ${at.log}`]
    for (const c of reads) assert.equal(await call(c), ALLOWED, c)
    const decide = `node ${PLUGIN}/bin/factory.ts decide --dir ${at.dir} --line "ruled | because | none | followed"`
    assert.equal(await call(decide), ALLOWED, decide)
    // a member's command is not gated by this guard
    assert.equal(await call(`echo x > ${at.log}`, { agentId: 'member-1' }), ALLOWED, 'a member is not gated')
  })
})

test('a main-session Bash tee or append into decisions.md is refused with a message naming factory decide', async () => {
  await drive(async (call, at) => {
    const rel = at.log.slice(at.log.indexOf('/git/') + 1)
    const writes = [
      `echo x >> ${at.log}`,
      `echo x >>${at.log}`,
      `echo x 2>&1 >> "${at.log}"`,
      `echo x | tee ${at.log}`,
      `echo x | tee -a ${at.log}`,
      `echo x | tee -a "${at.log}"`,
      `echo x | tee -a ${rel}`,
      `echo x | tee ${at.dir}/other.md ${at.log}`,
      `sed -i 's/a/b/' ${at.log}`,
      `sed -i.bak 's/a/b/' ${at.log}`,
      `sed -i '' 's/a/b/' ${at.log}`,
      `bash -c 'echo x | tee -a ${at.log}'`,
      `printf x | sh -c "tee -a ${at.log}"`,
      `cat <<EOF >> ${at.log}\n- 12:00 | a | b | c | d\nEOF`,
    ]
    for (const c of writes) denied(await call(c), c)
    // positive controls
    for (const c of [`grep -c . ${at.log}`, `cat ${at.log} | tee ${at.dir}/copy.txt`, `echo x | tee -a ${at.dir}/notes.md`]) assert.equal(await call(c), ALLOWED, c)
    const decide = `node ${PLUGIN}/bin/factory.ts decide --dir ${at.dir} --checker 1 --recommend answer --text "t" --outcome "o"`
    assert.equal(await call(decide), ALLOWED, decide)
    assert.equal(await call(`echo x | tee -a ${at.log}`, { agentId: 'member-1' }), ALLOWED, 'a member is not gated')
  })
})

test('a Bash command that names decisions.md and whose write target the guard cannot resolve is refused', async () => {
  await drive(async (call, at) => {
    const unresolved = [
      'echo x > $DIR/decisions.md',
      'echo x >> "${TRUSS_DIR}/decisions.md"',
      'echo x | tee -a $DIR/decisions.md',
      'echo x | tee $(pwd)/decisions.md',
      'echo x > $(git rev-parse --git-common-dir)/truss/s1/decisions.md',
      'echo x >> */decisions.md',
      'echo x | tee -a /*/truss/*/decisions.md',
      'sed -i s/a/b/ $DIR/decisions.md',
      'bash -c \'echo x > $DIR/decisions.md\'',
      'echo x > `echo /somewhere`/decisions.md',
    ]
    for (const c of unresolved) {
      const v = await call(c)
      assert.ok(v && typeof v === 'object' && typeof v.deny === 'string', `${c}: expected a deny, got ${v === ALLOWED ? 'allowed' : JSON.stringify(v)}`)
      assert.match(v.deny, /^\[truss\] Refused:/, c)
    }
    // a command that does not name the file, and a read of it, are not refused
    for (const c of ['echo x > $DIR/notes.md', `cat $DIR/decisions.md`, 'grep foo $DIR/decisions.md']) assert.equal(await call(c), ALLOWED, c)
    assert.equal(await call('echo x > $DIR/decisions.md', { agentId: 'member-1' }), ALLOWED, 'a member is not gated')
  })
})

test('factory decide still writes a decision line to decisions.md', () => {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' } })
  const dir = `${env.repo}/.git/truss/sid4`
  mkdirSync(dir, { recursive: true })
  const r = env.run('decide', { dir, line: 'ruled on it | the evidence | none | followed' })
  assert.equal(r.status, 0, `exit ${r.status}; ${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 300)}`)
  assert.equal(r.json?.ok, true)
  assert.match(readFileSync(`${dir}/decisions.md`, 'utf8'), /^- \d\d:\d\d \| ruled on it \| the evidence \| none \| followed\n$/)
  // a second line appends: the file is one stamped line per call
  const r2 = env.run('decide', { dir, line: 'second | why | none | done' })
  assert.equal(r2.status, 0)
  assert.equal(readFileSync(`${dir}/decisions.md`, 'utf8').split('\n').filter(Boolean).length, 2)
})

// ---- R-136: worktrees left at the end of a run -------------------------------------------------------------------------

const CFG = { merge: 'sequential', target: 'main' }
const RUN = 'wf_g32new000-aaa'
const say = (r) => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 900)}; stderr ${String(r.stderr).slice(0, 300)}`
const branchExists = (repo, b) => gitStatus(repo, ['rev-parse', '--verify', '-q', `refs/heads/${b}`]) === 0
const left = (j) => (Array.isArray(j?.leftWorktrees) ? j.leftWorktrees : [])
const agentPath = (env, id) => `${env.repo}/.claude/worktrees/agent-${id}`

function patchId(cwd, base, hd) {
  const [diffCmd, idCmd] = reg.PATCH_COMMAND.split(' | ').map((s) => s.replace('<base>', base).replace('<head>', hd).split(' '))
  const d = spawnSync(diffCmd[0], diffCmd.slice(1), { cwd, encoding: 'utf8' })
  const p = spawnSync(idCmd[0], idCmd.slice(1), { cwd, input: d.stdout, encoding: 'utf8' })
  return reg.patchIdOf(p.stdout)
}

// A Claude Code Agent worktree agent-<id> on branch worktree-agent-<id>, forked from `from`, with one commit of its own when
// `commit` is set, and a spawn event naming the crew it belongs to.
function agentWorktree(env, id, slug, from, commit) {
  const p = agentPath(env, id)
  git(env.repo, ['worktree', 'add', '-q', '-b', `worktree-agent-${id}`, p, from])
  git(p, ['config', 'user.name', 'T'])
  git(p, ['config', 'user.email', 't@e.invalid'])
  if (commit !== undefined) putFile(p, `src/${slug}/${commit}.ts`, `${commit}\n`, commit)
  appendEvent(env.dir, { v: 1, ts: new Date().toISOString(), event: 'spawn', crew: slug, agent: `${slug}-builder`, agentId: id, type: 'general-purpose', model: 'claude-sonnet-5-5', effort: 'medium', by: `workflow:${RUN}` })
  return p
}

/** Crew s (running, one commit, red record, QC PASS) merges through finish; crew t is running and stays; crew d is dropped. o.agents(env, wt) adds the agent worktrees. */
function world(o) {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew('s', { status: 'running' }), crew('t', { status: 'running' }), crew('d', { status: 'dropped' })], { approvedAt: '2026-10-01T00:00:00.000Z' }))
  const when = new Date(Date.now() - 3 * 3600_000).toISOString()
  appendEvent(env.dir, factorySpawn('s', when))
  appendEvent(env.dir, factorySpawn('t', when))
  const wt = addCrewWorktree(env.repo, 's')
  putFile(wt, 'src/s/a.ts', 's\n', 'work')
  addCrewWorktree(env.repo, 'd')
  const made = o.agents(env, wt)
  const base = git(wt, ['merge-base', 'main', 'HEAD'])
  const hd = head(wt)
  mkdirSync(`${env.dir}/checks`, { recursive: true })
  writeFileSync(`${env.dir}/checks/s-1.json`, JSON.stringify({ command: 'true', exit: 1, head: hd, tail: '' }))
  const qc = { label: 's-qc', agentType: 'truss:qc-engineer', metaModel: 'opus', model: 'claude-opus-5-5', effort: 'medium', result: qcReport({ head: hd, patch: patchId(wt, base, hd) }) }
  const run = mkRun(env.transcripts, RUN, [qc])
  const resFile = `${env.dir}/result.json`
  writeFileSync(resFile, JSON.stringify([{ slug: 's', state: 'passed', head: hd, base, qc: 's-qc' }]))
  return { env, wt, made, finish: () => env.run('finish', { transcript: run.dir, result: resFile }) }
}

test('at the end of a run the worktrees and branches of merged or dropped crews with no unmerged change or lock are removed', () => {
  const w = world({
    agents: (env) => ({
      merged: agentWorktree(env, 'a0000000000000001', 's', 'truss-s'),
      dropped: agentWorktree(env, 'a0000000000000002', 'd', 'main'),
      running: agentWorktree(env, 'a0000000000000003', 't', 'main'),
    }),
  })
  const r = w.finish()
  assert.deepEqual(r.json?.merged, ['s'], say(r))
  const repo = w.env.repo
  for (const id of ['a0000000000000001', 'a0000000000000002']) {
    assert.ok(!existsSync(agentPath(w.env, id)), `agent-${id} must be removed: ${say(r)}`)
    assert.ok(!branchExists(repo, `worktree-agent-${id}`), `worktree-agent-${id} must be deleted`)
  }
  assert.ok(!left(r.json).some((l) => /agent-a000000000000000[12]$/.test(String(l.path).replace(/\\/g, '/'))), `a removed worktree is not listed: ${JSON.stringify(r.json?.leftWorktrees)}`)
  // a crew that is still running keeps its agent worktree and branch
  assert.ok(existsSync(w.made.running) && branchExists(repo, 'worktree-agent-a0000000000000003'), 'the running crew\'s agent worktree stays')
  assert.ok(!existsSync(`${repo}/.claude/worktrees/truss-d`) && !branchExists(repo, 'truss-d'), 'the dropped crew\'s own worktree and branch go')
})

test('at the end of a run a worktree with an unmerged change or a lock is kept and listed with why', () => {
  const w = world({
    agents: (env) => {
      const unmerged = agentWorktree(env, 'a0000000000000011', 's', 'main', 'u1')
      const dirty = agentWorktree(env, 'a0000000000000012', 's', 'truss-s')
      writeFileSync(`${dirty}/notes.txt`, 'unsaved\n')
      const locked = agentWorktree(env, 'a0000000000000013', 's', 'truss-s')
      git(env.repo, ['worktree', 'lock', '--reason', 'guards-032 fixture', locked])
      const clean = agentWorktree(env, 'a0000000000000014', 's', 'truss-s')
      return { unmerged, dirty, locked, clean }
    },
  })
  const r = w.finish()
  assert.deepEqual(r.json?.merged, ['s'], say(r))
  const repo = w.env.repo
  const listed = (p) => left(r.json).find((l) => realpathSync(l.path) === realpathSync(p))
  const cases = [
    ['unmerged', 'worktree-agent-a0000000000000011', /unmerged/i],
    ['dirty', 'worktree-agent-a0000000000000012', /dirty|uncommitted|change/i],
    ['locked', 'worktree-agent-a0000000000000013', /lock/i],
  ]
  for (const [k, branch, why] of cases) {
    assert.ok(existsSync(w.made[k]) && branchExists(repo, branch), `${k}: the worktree and branch stay`)
    const l = listed(w.made[k])
    assert.ok(l !== undefined, `${k}: listed in leftWorktrees: ${JSON.stringify(r.json?.leftWorktrees)}`)
    assert.equal(l.branch, branch)
    assert.match(String(l.why), why, `${k}: why names the reason`)
  }
  // the unmerged commit is still reachable from its branch
  assert.notEqual(git(repo, ['rev-parse', '--verify', '-q', 'refs/heads/worktree-agent-a0000000000000011']), '')
  // positive control: the clean one of the same merged crew goes
  assert.ok(!existsSync(w.made.clean) && !branchExists(repo, 'worktree-agent-a0000000000000014'), `the clean agent worktree is removed: ${say(r)}`)
})

// ---- R-137: the citation coupling trap is closed by cite-by-symbol -------------------------------------------------------

test('a crew that changes a file a doc cites by symbol outside its owns needs no out-of-owns doc edit', () => {
  const MOD = 'export const x = 1\n\nexport function helper() {\n  return x\n}\n'
  const env = mkEnv({ config: CFG, files: { 'src/a/mod.ts': MOD, '.claude/rules/area.md': 'The helper is `src/a/mod.ts` `helper`.\n' } })
  writePlan(env.dir, planObj([crew('a', { status: 'running', owns: ['src/a/**'] })]))
  const wt = addCrewWorktree(env.repo, 'a')
  // the crew adds lines above the cited symbol, so every line below moves
  putFile(wt, 'src/a/mod.ts', `// one\n// two\n// three\n${MOD}`, 'shift')
  assert.ok(readFileSync(`${wt}/src/a/mod.ts`, 'utf8').includes('export function helper()'), 'the cited symbol is still there')
  assert.deepEqual(citationLintFailures(wt), [], 'the doc cites a symbol: the citation lint passes with the doc unedited')
  const r = env.run('owns-check', { slug: 'a' })
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json?.ok, true, say(r))
  assert.deepEqual(r.json?.exempt, [], 'no doc was edited, so none needed the exemption')
  assert.equal(git(wt, ['diff', '--name-only', 'main...HEAD']), 'src/a/mod.ts')
  // positive control: a line citation is flagged, and the same change is what makes it stale
  const line3 = MOD.split('\n')[2]
  assert.match(line3, /function helper/)
  writeFileSync(`${wt}/.claude/rules/area.md`, 'The helper is at `src/a/mod.ts:3`.\n')
  assert.deepEqual(citationLintFailures(wt), ['.claude/rules/area.md:1 cites mod.ts:3'])
  assert.ok(!readFileSync(`${wt}/src/a/mod.ts`, 'utf8').split('\n')[2].includes('function helper'), 'line 3 no longer holds the cited symbol after the crew\'s change')
})

test('a read-only first command followed by a single & and a write into decisions.md is refused', async () => {
  await drive(async (call, at) => {
    const writes = [
      `echo done & tee -a ${at.log} < ${at.dir}/line`,
      `cat ${at.dir}/line & cp ${at.dir}/line ${at.log}`,
      `echo done & sed -i '' 's/a/b/' ${at.log}`,
      `cat /tmp/l & mv /tmp/l ${at.log}`,
      `test -f ${at.log} & perl -pi -e 's/a/b/' ${at.log}`,
    ]
    for (const c of writes) denied(await call(c), c)
    // positive control: a backgrounded read is not a write
    assert.equal(await call(`echo done & cat ${at.log}`), ALLOWED, 'a backgrounded read is allowed')
  })
})

test('uniq writing its second operand into decisions.md is refused', async () => {
  await drive(async (call, at) => {
    const writes = [`uniq ${at.dir}/line ${at.log}`, `cat ${at.dir}/line | uniq - ${at.log}`]
    for (const c of writes) denied(await call(c), c)
    // positive control: uniq reading the log, or writing elsewhere, is allowed
    for (const c of [`uniq ${at.log}`, `uniq ${at.log} ${at.dir}/out.txt`]) assert.equal(await call(c), ALLOWED, c)
  })
})
