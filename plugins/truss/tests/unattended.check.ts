// @ts-nocheck
// truss 0.25.0 wave 2, C (c-unattended): contract-025 section 7, the hook and the on/off file. Written before the code.
// Runs under plain node (no `claude-code/testing`), like gate-trussfile.check.ts.
//
// Run with: node --test tests/unattended.check.ts
//
// Interface pinned here:
//  - `factory unattended --on --dir D` writes D/unattended.json `{since, item: null}` and appends an `unattended` event
//    `{on: true, item}` to D/events.jsonl; `--off` removes the file and logs `on: false`. Output: one line `{on, item|null}`.
//  - D is the session truss dir `<common>/truss/<sid>/`. No unattended.json ever appears in `<common>/truss/shared/`, the
//    repo tree or the home dir.
//  - hooks/register.ts exports `unattendedAskVerdict(input: {agentId?}, ctx: {trussDir: string|undefined,
//    exists: (p) => boolean|Promise<boolean>})` returning `{deny: string}` or undefined (await it). It denies only when
//    input.agentId is undefined (main thread), trussDir is defined and exists(`<trussDir>/unattended.json`) is true. The deny
//    text starts `[truss] unattended run: no one is here to answer.` A throwing exists gives undefined (fail open). It only
//    ever asks about `<trussDir>/unattended.json`, never another session's.
//  - register.ts holds an `on('tool.call', { tool: ['AskUserQuestion'] }` handler that calls unattendedAskVerdict with
//    rootOf and ends `.catch(failOpen)`.
//  - `admit`/`start` hold only the (session, slug) that blockingFor names (stubbedPlugin seam).
//  - plan-check refuses a version 4 plan crew without workType when D/unattended.json exists.

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  crew, mkEnv, planObj, pluginCopy, runCli, tmp, validateEvent, writeGoal, writePlan,
} from './fixtures/workflow-run/harness.ts'
import { codeOnly } from './hooks-load.check.ts'

const REGISTER = new URL('../hooks/register.ts', import.meta.url)
const DENY_START = '[truss] unattended run: no one is here to answer.'

/** Every path under `root` (recursive, no symlink following) whose base name is unattended.json. */
function findUnattended(root: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name !== '.git' && e.name !== 'node_modules') walk(`${d}/${e.name}`)
      } else if (e.name === 'unattended.json') out.push(`${d}/${e.name}`)
    }
  }
  walk(root)
  return out
}

/** A truss layout `<common>/truss/<sid>/` with a sibling `shared/`. */
function layout() {
  const common = tmp('unatt-common-')
  const sid = 'sess-0001'
  const dir = `${common}/truss/${sid}`
  mkdirSync(dir, { recursive: true })
  mkdirSync(`${common}/truss/shared`, { recursive: true })
  writeFileSync(`${dir}/events.jsonl`, '')
  return { common, dir, shared: `${common}/truss/shared`, sid }
}

const eventsOf = (dir: string): any[] =>
  readFileSync(`${dir}/events.jsonl`, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l))

async function verdictFn() {
  let mod: Record<string, unknown>
  try {
    mod = await import('../hooks/register.ts')
  } catch (err) {
    assert.fail(`register.ts did not load: ${(err as Error).message}`)
  }
  assert.equal(typeof mod.unattendedAskVerdict, 'function', 'producer missing: hooks unattendedAskVerdict is not exported')
  return mod.unattendedAskVerdict as (i: unknown, c: unknown) => Promise<{ deny: string } | undefined>
}

test('unattended: on and off write and remove the file and log the event', () => {
  const { dir } = layout()
  const factory = mkEnv().factory
  const on = runCli(factory, 'unattended', ['--on', '--dir', dir])
  assert.equal(on.status, 0, `${on.stdout} ${on.stderr}`)
  assert.deepEqual(on.json, { on: true, item: null }, on.stdout)
  const file = JSON.parse(readFileSync(`${dir}/unattended.json`, 'utf8'))
  assert.equal(file.item, null)
  assert.ok(typeof file.since === 'string' && file.since.length > 0, 'since is set')
  const evOn = eventsOf(dir).filter((e) => e.event === 'unattended')
  assert.equal(evOn.length, 1, JSON.stringify(evOn))
  assert.equal(evOn[0].on, true)
  assert.equal(evOn[0].item, null)
  assert.deepEqual(validateEvent(evOn[0]), [])
  const off = runCli(factory, 'unattended', ['--off', '--dir', dir])
  assert.equal(off.status, 0, `${off.stdout} ${off.stderr}`)
  assert.equal(off.json.on, false)
  assert.equal(existsSync(`${dir}/unattended.json`), false, 'the file is removed')
  const evAll = eventsOf(dir).filter((e) => e.event === 'unattended')
  assert.equal(evAll.length, 2)
  assert.equal(evAll[1].on, false)
  assert.deepEqual(validateEvent(evAll[1]), [])
})

test('unattended: unattended.json is written in the session truss dir, never the shared dir, the repo or the home dir', () => {
  const { dir, shared, common } = layout()
  const env = mkEnv()
  const home = tmp('unatt-home-')
  const r = runCli(env.factory, 'unattended', ['--on', '--dir', dir, '--repo', env.repo], env.repo, { HOME: home, USERPROFILE: home })
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`)
  assert.ok(existsSync(`${dir}/unattended.json`), 'written in D')
  assert.deepEqual(findUnattended(shared), [], 'nothing in the shared dir')
  assert.deepEqual(findUnattended(env.repo), [], 'nothing in the repo tree')
  assert.deepEqual(findUnattended(home), [], 'nothing in the home dir')
  assert.deepEqual(findUnattended(common), [`${dir}/unattended.json`], 'exactly one file under the common dir')
})

test('unattended: the hook ignores an unattended.json in another session dir', async () => {
  const verdict = await verdictFn()
  const a = layout()
  const otherDir = `${a.common}/truss/sess-0002`
  mkdirSync(otherDir, { recursive: true })
  writeFileSync(`${otherDir}/unattended.json`, '{"since":"x","item":null}\n')
  writeFileSync(`${a.shared}/unattended.json`, '{"since":"x","item":null}\n')
  const asked: string[] = []
  const exists = (p: string) => (asked.push(p), existsSync(p))
  const v = await verdict({}, { trussDir: a.dir, exists })
  assert.equal(v, undefined, JSON.stringify(v))
  assert.ok(asked.length > 0 && asked.every((p) => p === `${a.dir}/unattended.json`), `only this session's file is consulted: ${asked}`)
})

test('unattended: the hook refuses AskUserQuestion while the file exists', async () => {
  const verdict = await verdictFn()
  const { dir } = layout()
  writeFileSync(`${dir}/unattended.json`, '{"since":"x","item":null}\n')
  const v = await verdict({}, { trussDir: dir, exists: existsSync })
  assert.ok(v && typeof v.deny === 'string', JSON.stringify(v))
  assert.ok(v.deny.startsWith(DENY_START), v.deny)
  assert.ok(v.deny.includes('escalate --kind client-question'), v.deny)
  // an async exists works too
  const w = await verdict({}, { trussDir: dir, exists: async (p: string) => existsSync(p) })
  assert.ok(w && w.deny.startsWith(DENY_START), JSON.stringify(w))
  // a subagent (agentId set) is never refused by this hook
  assert.equal(await verdict({ agentId: 'agent-1' }, { trussDir: dir, exists: existsSync }), undefined)
  // no truss dir: nothing to consult
  assert.equal(await verdict({}, { trussDir: undefined, exists: () => true }), undefined)
})

test('unattended: the hook allows AskUserQuestion when the file is absent', async () => {
  const verdict = await verdictFn()
  const { dir } = layout()
  assert.equal(await verdict({}, { trussDir: dir, exists: existsSync }), undefined)
  assert.equal(await verdict({ agentId: undefined }, { trussDir: dir, exists: () => false }), undefined)
})

test('unattended: the hook fails open on a read error', async () => {
  const verdict = await verdictFn()
  const { dir } = layout()
  const boom = () => {
    throw new Error('EACCES')
  }
  assert.equal(await verdict({}, { trussDir: dir, exists: boom }), undefined)
  assert.equal(await verdict({}, { trussDir: dir, exists: async () => boom() }), undefined)
  // the handler is wired through rootOf and ends .catch(failOpen)
  const src = readFileSync(REGISTER, 'utf8')
  const code = codeOnly(src)
  const start = src.indexOf("on('tool.call', { tool: ['AskUserQuestion'] }")
  assert.ok(start > 0, "the on('tool.call', { tool: ['AskUserQuestion'] } handler is missing")
  const end = src.indexOf('\n  }).catch(failOpen)', start)
  assert.ok(end > start, 'the AskUserQuestion handler does not end with .catch(failOpen)')
  assert.ok(!src.slice(start + 10, end).includes("on('tool.call'"), 'handler end found in a later handler')
  const body = code.slice(start, end)
  assert.ok(body.includes('unattendedAskVerdict('), 'the handler does not call unattendedAskVerdict')
  assert.ok(body.includes('rootOf('), 'the handler does not use rootOf')
})

/** A private copy of the plugin whose bin/inbox.ts keeps the real exports and overrides blockingFor: it logs every call and blocks only (U_SESSION, U_SLUG). */
function stubbedPlugin(): string {
  const d = tmp('unatt-plugin-')
  cpSync(pluginCopy(), d, { recursive: true })
  const p = `${d}/bin/inbox.ts`
  const real = existsSync(p)
  if (real) renameSync(p, `${d}/bin/inbox-real.ts`)
  writeFileSync(p, [
    `import { appendFileSync } from 'node:fs'`,
    real ? `export * from './inbox-real.ts'` : '',
    `export function blockingFor(repo, session, slug) {`,
    `  if (process.env.U_LOG) appendFileSync(process.env.U_LOG, JSON.stringify({ session, slug }) + '\\n')`,
    `  return session === process.env.U_SESSION && slug === process.env.U_SLUG ? ['E-20261110-a1b2c3'] : []`,
    `}`,
    '',
  ].join('\n'))
  return d
}

test('unattended: a blocking link holds only that session and slug', () => {
  const plugin = stubbedPlugin()
  const env = mkEnv()
  writePlan(env.dir, planObj([crew('alpha'), crew('beta')]))
  writeGoal(env.dir, 'alpha')
  writeGoal(env.dir, 'beta')
  const run = (slug: string, extra: Record<string, string>) =>
    runCli(`${plugin}/bin/factory.ts`, 'admit', ['--dir', env.dir, '--repo', env.repo, '--slug', slug, '--wait-ms', '10000'], env.repo, extra)
  // learn the session id the seam is called with
  const log = `${tmp('unatt-log-')}/calls.jsonl`
  run('alpha', { U_LOG: log })
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.ok(calls.length > 0 && calls.every((c) => c.slug === 'alpha'), JSON.stringify(calls))
  const session = calls[0].session
  assert.equal(typeof session, 'string')
  // the same session and slug: held
  const held = run('alpha', { U_SESSION: session, U_SLUG: 'alpha' })
  assert.equal(held.status, 1, `${held.stdout} ${held.stderr}`)
  assert.equal(held.json.admitted, false)
  assert.ok(String(held.json.why).includes('awaiting client: E-20261110-a1b2c3'), held.stdout)
  // another slug of the same session: not held
  const free = run('beta', { U_SESSION: session, U_SLUG: 'alpha' })
  assert.equal(free.status, 0, `${free.stdout} ${free.stderr}`)
  // the same slug of another session: not held
  const other = run('alpha', { U_SESSION: `${session}-other`, U_SLUG: 'alpha' })
  assert.equal(other.status, 0, `${other.stdout} ${other.stderr}`)
})

test('unattended: plan-check requires workType when unattended', () => {
  const env = mkEnv()
  writePlan(env.dir, planObj([crew('alpha'), crew('beta', { stage: 2, workType: 'docs' })], { version: 4 }))
  writeGoal(env.dir, 'alpha')
  writeGoal(env.dir, 'beta')
  writeFileSync(`${env.dir}/unattended.json`, JSON.stringify({ since: new Date().toISOString(), item: null }) + '\n')
  const r = env.run('plan-check')
  assert.equal(r.status, 1, `exit 1 expected: ${r.stdout} ${r.stderr}`)
  assert.equal(r.json.ok, false)
  assert.ok(r.json.errors.includes('alpha: workType is required in an unattended run'), JSON.stringify(r.json))
  assert.ok(!r.json.errors.some((x: string) => x.startsWith('beta: workType is required')), 'a crew with a workType is not named')
})
