// Bug G (0.32.0): goal items a PM or a handoff added reached planning with no worth review. plan-args now refuses unless the
// current run section of <dir>/decisions.md (everything after the last `## Run` heading) holds a `checker-<n> WORTH` line or a
// `worth review none:` decision line, and decide writes the WORTH form. Each case builds its own temp repo and truss dir and
// removes them in `finally`; the factory runs as a real child process.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const FACTORY = `${PLUGIN}/bin/factory.ts`

function mk(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix))).replace(/\\/g, '/')
}

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
}

function cli(command: string, args: string[], cwd: string): { status: number | null; json: any; stdout: string; stderr: string } {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.TRUSS_SESSION_START
  delete env.CLAUDE_PID
  delete env.CLAUDE_CODE_SESSION_ID
  delete env.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, [FACTORY, command, ...args], { cwd, encoding: 'utf8', env, timeout: 120_000, windowsHide: true })
  const lines = (r.stdout ?? '').split('\n').filter((l) => l.length > 0)
  let json: any
  if (lines.length === 1) {
    try {
      json = JSON.parse(lines[0])
    } catch {}
  }
  return { status: r.status, json, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// A temp repo, truss dir and brief; `decisions` is the decisions.md text. Runs `fn` and removes every temp dir after.
function world(decisions: string, fn: (w: { repo: string; dir: string; brief: string }) => void, opts: { unattended?: boolean } = {}): void {
  const root = mk('worth-gate-')
  try {
    const repo = `${root}/repo`
    const dir = `${root}/truss`
    spawnSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true })
    git(repo, ['config', 'user.name', 'Test Writer'])
    git(repo, ['config', 'user.email', 'tw@example.invalid'])
    git(repo, ['config', 'core.autocrlf', 'false'])
    writeFileSync(`${repo}/README.md`, 'readme\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-q', '-m', 'initial'])
    mkdirSync(dir)
    writeFileSync(`${dir}/decisions.md`, decisions)
    writeFileSync(`${dir}/events.jsonl`, '')
    if (opts.unattended) writeFileSync(`${dir}/unattended.json`, '{}\n')
    const brief = `${root}/brief.md`
    writeFileSync(brief, 'Mode: plan\n')
    fn({ repo, dir, brief })
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
}

const planArgs = (w: { repo: string; dir: string; brief: string }, extra: string[] = []) =>
  cli('plan-args', ['--dir', w.dir, '--repo', w.repo, '--brief-file', w.brief, ...extra], w.repo)

const RUN = '## Run 2026-11-14T05:00:00Z | the goal\n'
const WORTH = '- 05:10 | checker-3 WORTH worth: item 8, add the retry flag; small, closes a real failure | followed\n'
const NONE = '- 05:10 | worth review none: every goal item was typed by the client in this session (prompts at 05:01 and 05:04) | none | none | followed\n'

test('worth-gate-032: plan-args refuses a run with no worth line', () => {
  world(`${RUN}- 05:05 | size a full | one crew; sizing-engineer none | none | followed\n`, (w) => {
    const r = planArgs(w)
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.equal(typeof r.json?.error, 'string', 'one JSON line with an error')
    assert.match(r.json.error, /worth/i)
    assert.match(r.json.error, /decide/, 'the error names the fix')
    const fix = `${w.dir}/fix.txt`
    writeFileSync(fix, 'errors\n')
    const re = planArgs(w, ['--fix', fix])
    assert.equal(re.status, 1, 'a re-plan with --fix is gated the same way')
  })
})

test('worth-gate-032: plan-args passes with a checker WORTH line', () => {
  world(RUN + WORTH, (w) => {
    const r = planArgs(w)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(r.json.truss.kind, 'plan')
  })
})

test('worth-gate-032: plan-args passes with a worth review none line', () => {
  world(RUN + NONE, (w) => {
    const r = planArgs(w)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.equal(r.json.truss.kind, 'plan')
  })
})

test('worth-gate-032: a WORTH line from an earlier run section does not count', () => {
  world(RUN + WORTH + NONE + '## Run 2026-11-14T06:00:00Z | the next goal\n- 06:01 | size b solo | small | none | followed\n', (w) => {
    const r = planArgs(w)
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.json.error, /worth/i)
  })
})

test('worth-gate-032: an unattended run needs a checker WORTH line, not worth review none', () => {
  world(RUN + NONE, (w) => {
    const r = planArgs(w)
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.json.error, /unattended/)
  }, { unattended: true })
  world(RUN + WORTH, (w) => assert.equal(planArgs(w).status, 0), { unattended: true })
})

test('worth-gate-032: decide writes the WORTH form and still writes the old RECOMMEND form unchanged', () => {
  world('', (w) => {
    const worth = cli('decide', ['--dir', w.dir, '--checker', '4', '--recommend', 'trim', '--text', 'item 9: keep the flag, drop the UI', '--outcome', 'pass to client'], w.repo)
    assert.equal(worth.status, 0, worth.stdout + worth.stderr)
    for (const rec of ['worth', 'drop']) assert.equal(cli('decide', ['--dir', w.dir, '--checker', '4', '--recommend', rec, '--text', 't', '--outcome', 'followed'], w.repo).status, 0)
    for (const rec of ['answer', 'defer', 'pass']) assert.equal(cli('decide', ['--dir', w.dir, '--checker', '5', '--recommend', rec, '--text', 'q', '--outcome', 'followed'], w.repo).status, 0)
    assert.equal(cli('decide', ['--dir', w.dir, '--checker', '5', '--recommend', 'maybe', '--text', 'q', '--outcome', 'o'], w.repo).status, 2)
    const lines = readFileSync(`${w.dir}/decisions.md`, 'utf8').split('\n').filter((l) => l !== '')
    assert.equal(lines.length, 6, lines.join('\n'))
    assert.match(lines[0], /^- \d\d:\d\d \| checker-4 WORTH trim: item 9: keep the flag, drop the UI \| pass to client$/)
    assert.match(lines[1], /^- \d\d:\d\d \| checker-4 WORTH worth: t \| followed$/)
    assert.match(lines[2], /^- \d\d:\d\d \| checker-4 WORTH drop: t \| followed$/)
    assert.match(lines[3], /^- \d\d:\d\d \| checker-5 RECOMMEND answer: q \| followed$/)
    assert.match(lines[4], /^- \d\d:\d\d \| checker-5 RECOMMEND defer: q \| followed$/)
    assert.match(lines[5], /^- \d\d:\d\d \| checker-5 RECOMMEND pass: q \| followed$/)
    assert.equal(worth.json.line, lines[0])
  })
})

test('worth-gate-032: SKILL.md has the worth step before Draft the plan, and checking-engineer.md has the worth mode', () => {
  const skill = readFileSync(`${PLUGIN}/skills/run/SKILL.md`, 'utf8')
  const step = skill.indexOf('### Review each goal item\'s worth')
  const draft = skill.indexOf('### Draft the plan')
  assert.ok(step > 0, 'SKILL.md has the worth step heading')
  assert.ok(draft > step, 'the worth step comes before "### Draft the plan"')
  const body = skill.slice(step, draft)
  assert.match(body, /--recommend <worth\|trim\|drop>/)
  assert.match(body, /worth review none:/)
  assert.match(body, /handoff/)
  assert.match(body, /plan-args/)
  const ce = readFileSync(`${PLUGIN}/agents/checking-engineer.md`, 'utf8')
  const mode = ce.indexOf('## Worth review')
  assert.ok(mode > 0, 'checking-engineer.md has a Worth review section')
  const modeBody = ce.slice(mode, ce.indexOf('\n## ', mode + 3))
  assert.match(modeBody, /RECOMMEND: worth \| trim \| drop/)
  assert.match(modeBody, /cost/i)
  assert.match(modeBody, /scope/i)
})
