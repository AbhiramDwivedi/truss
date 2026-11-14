// The check command: the targeted and full test runs, the environment verdict and the retro catalog hits. Moved unchanged
// from bin/factory.ts (0.31.0 item 5). Never imports factory.ts, whose top-level await would make an import cycle.
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { configOf, declares, flat, isObj, need, packageName, refuse, usage } from '../core.ts'
import type { Flags, Obj } from '../core.ts'
import { selectForCheckout, stripBlanketSuite } from '../testmap.ts'
import type { Selection, TestsConfig } from '../testmap.ts'
import { releaseHeavySlot } from '../../resources/index.ts'
import type { Catalog } from '../../retro/catalog.ts'
import { isTestPath } from './crew.ts'
import { acceptanceCommand } from './goal-file.ts'
import { acquireSlot, heavyWaitMs, recordHeavyTime, slotsAt } from './slot.ts'
import { retro } from './retro-mods.ts'
import { baseOf, dirOf, gitOrFail, PLUGIN, repoOf, run } from './cli.ts'
import { loadPlan } from './plan-file.ts'
import { settingsFor } from './settings.ts'

// Environment failures (ADR-0009 "check, environment failures"): output lines that say the host, not the code, failed, so no
// fix builder can clear them. Kept short and literal on purpose: a miss only costs the fix ladder, a false hit stops a crew.
export const ENV_PATTERNS: RegExp[] = [
  /Host system is missing dependencies/, // Playwright: the browser's system libraries are not installed
  /browserType\.launch: /, // Playwright: the browser process could not start
  /Executable doesn't exist at /, // Playwright: the browser binary was never downloaded
  /error while loading shared libraries: /, // the dynamic loader: a system library is missing
  /^mk[ds]?temp: mk[ds]?temp failed on .*Operation not permitted/, // a sandbox forbids the temp dir the host's mktemp picked
]
// The first line of a failed check's output that names an environment failure, cut at 300 characters, or undefined. Besides
// ENV_PATTERNS, node's `Cannot find package 'x' imported from <file>` (ERR_MODULE_NOT_FOUND) counts when the package.json
// nearest to <file> declares x: the dependency is declared but not installed. An undeclared package is a code failure.
export function envFailure(text: string): string | undefined {
  // A match counts only when no quote or backtick comes before it on the line: quoted text is output echoed by a test, not the
  // host failing. A leading YAML `error:` key and its one opening quote don't count (TAP's `error: "<msg>"`).
  const bare = (s: string, at: number): boolean => !/["'`]/.test(s.slice(0, at))
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const s = line.replace(/^error:\s*["']?/, '')
    let hit = ENV_PATTERNS.some((re) => {
      const x = re.exec(s)
      return x !== null && bare(s, x.index)
    })
    const m = /Cannot find package '([^']+)' imported from (\S+)/.exec(s)
    if (!hit && m && bare(s, m.index) && !m[1].startsWith('.') && !m[1].startsWith('/')) hit = declares(m[2].replace(/^file:\/\//, ''), packageName(m[1]))
    if (hit) return line.length > 300 ? `${line.slice(0, 299)}…` : line
  }
  return undefined
}
// ADR-0024 item 34: the failure blocks of a check's output, each from its header to the next header: Playwright's
// `N) [project] › file:line:col › ...` (the `[project] › ` part left out when the project has no name) and node:test TAP's
// `not ok N - ...` (a TAP parent that only reports failed subtests is no block of its own). Text before the first header
// belongs to no block. [] when no header is found. ADR-0025 item 43: a TAP block ends at its YAML diagnostic's closing `...`
// line, or at a plan or summary line (`1..N`, `# tests`); lines after that, up to the next header, belong to no block.
// Playwright blocks run to the next header. ADR-0026 item 58 (b): the closing `...` counts only at the indent of the block's
// own `---` line, and a plan or summary line ends a block only outside its YAML diagnostic, so an `error: |-` block scalar
// holding an indented `...` or `1..N` line stays one block.
function failureBlocks(text: string): string[] {
  const header = /^\s*(\d+\) (\[[^\]]+\] › )?[^\s›][^›]*:\d+:\d+ › |not ok \d+ - )/
  const tapHeader = /^\s*not ok \d+ - /
  const blocks: string[][] = []
  let open = false
  let tap = false
  // the indent of the open TAP block's `---` line while inside its YAML diagnostic, else undefined
  let yaml: string | undefined
  for (const line of text.split('\n')) {
    if (header.test(line)) {
      blocks.push([line])
      open = true
      tap = tapHeader.test(line)
      yaml = undefined
    } else if (open && tap && yaml === undefined && /^\s*(\d+\.\.\d+|# tests \d+)\b/.test(line)) open = false
    else if (open) {
      blocks[blocks.length - 1]?.push(line)
      if (!tap) continue
      if (yaml === undefined) {
        const start = /^(\s*)---\s*$/.exec(line)
        if (start !== null) yaml = start[1] as string
        else if (/^\s*\.\.\.\s*$/.test(line)) open = false
      } else if (line.startsWith(`${yaml}...`) && line.slice(yaml.length + 3).trim() === '') {
        yaml = undefined
        open = false
      }
    }
  }
  return blocks.map((b) => b.join('\n')).filter((b) => !/failureType: '?subtestsFailed'?/.test(b))
}
// `env` only when env lines explain every failure: every failure block holds one, or no block is found and an env line is.
// Otherwise the first env line, if any, is `envSeen` and the run is a code failure.
export function envVerdict(text: string): { env?: string; envSeen?: string } {
  const first = envFailure(text)
  if (first === undefined) return {}
  const blocks = failureBlocks(text)
  const explained = blocks.length === 0 || blocks.every((b) => envFailure(b) !== undefined)
  return explained ? { env: first } : { envSeen: first }
}

// Stage green (ADR-0046 item 8): run `npm ci` in each directory with a tracked package-lock.json whose node_modules is missing.
// A linked node_modules (lstat) counts as present. On win32 npm is a .cmd, which spawn runs only through a shell (CVE-2024-27980):
// one fixed command string with shell: true and no args array (DEP0190); nothing in it comes from input.
export function installMissingDeps(cwd: string, platform: string = process.platform, spawn: typeof spawnSync = spawnSync): { dir: string; status: number | null; output: string }[] {
  const listed = spawnSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-z', '--', 'package-lock.json', '**/package-lock.json'], { cwd, encoding: 'utf8', windowsHide: true })
  const out: { dir: string; status: number | null; output: string }[] = []
  if (listed.status !== 0) return out
  for (const rel of String(listed.stdout).split('\0').filter(Boolean)) {
    const dir = flat(path.join(cwd, path.dirname(rel)))
    try {
      lstatSync(`${dir}/node_modules`)
      continue
    } catch {
      // missing: install
    }
    const opts = { cwd: dir, encoding: 'utf8' as const, windowsHide: true, timeout: 600000 }
    const r = platform === 'win32' ? spawn('npm ci', { ...opts, shell: true }) : spawn('npm', ['ci'], opts)
    out.push({ dir, status: r.status ?? 1, output: `${String(r.stdout ?? '')}${String(r.stderr ?? '')}${r.error ? `\n${r.error.message}` : ''}` })
  }
  return out
}

// Runs `bash -c command` in cwd with stdout and stderr to one file; returns the exit and the text.
// Prefixed (on the same line, so line numbers in the output stay the crew's) to every command bashRun runs. BSD mktemp with no
// template uses the Darwin per-user temp dir and ignores TMPDIR, which a sandbox forbids; GNU mktemp already honours TMPDIR, so
// this is harmless on Linux. A call with a template, or with flags other than a lone -d, goes to the real mktemp unchanged.
export const MKTEMP_PREFIX =
  'mktemp() { if [ "$#" -eq 0 ]; then command mktemp "${TMPDIR:-/tmp}/tmp.XXXXXXXX"; ' +
  'elif [ "$#" -eq 1 ] && [ "$1" = "-d" ]; then command mktemp -d "${TMPDIR:-/tmp}/tmp.XXXXXXXX"; ' +
  'else command mktemp "$@"; fi; }; '

// Runs `bash -c command` in cwd with stdout and stderr to one file; returns the exit and the text.
export function bashRun(cwd: string, command: string): { exit: number; text: string } {
  const scratch = mkdtempSync(`${tmpdir()}/factory-check-`)
  try {
    const fd = openSync(`${scratch}/out.txt`, 'w')
    // a check started under node --test (the plugin's own tests) must not hand NODE_TEST_CONTEXT to the tests it runs: a nested
    // node --test that sees it skips every file and exits 0
    const { NODE_TEST_CONTEXT: _, ...env } = process.env
    const r = spawnSync('bash', ['-c', MKTEMP_PREFIX + command], { cwd, env, stdio: ['ignore', fd, fd] })
    closeSync(fd)
    if (r.error) throw usage(`cannot run bash in ${cwd}: ${r.error.message}`)
    return { exit: r.status ?? 1, text: readFileSync(`${scratch}/out.txt`, 'utf8') }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

// 0.31.0 item 1: the tests a green check runs after the acceptance test. bin/testmap.ts maps the crew's diff (merge-base with the
// target ... HEAD) to the test files it reaches, or to the full suite when reach is unclear; --full forces the full suite (the run
// before merge). A targeted set runs outside the heavy slot; the full suite takes the slot for exactly its own run, then records
// its time for slotWaitMs. A slot not free within heavyWaitMs comes back as `slot: {ran: false}`, which heavy reports as busy.
function checkTests(f: Flags, dir: string, slug: string, cwd: string): { exit: number; text: string; tests: Obj; slot?: Obj } {
  let config: TestsConfig = {}
  let sel: Selection
  try {
    const t = configOf(repoOf(f)).targetedTests
    config = isObj(t) ? (t as TestsConfig) : {}
    sel = selectForCheckout(cwd, baseOf(cwd, settingsFor(f, repoOf(f)).target), config)
  } catch (e) {
    sel = { mode: 'full', why: [`the diff could not be mapped: ${e instanceof Error ? e.message : String(e)}`], files: [], commands: [] }
    const full = typeof config.full === 'string' && config.full.trim() !== '' ? config.full.trim() : existsSync(`${cwd}/package.json`) ? 'npm test' : undefined
    if (full !== undefined) sel.full = full
  }
  if (f.full === true && sel.mode !== 'full') sel = { mode: 'full', why: ['--full: the full suite before merge'], files: [], commands: [], ...(sel.full === undefined ? {} : { full: sel.full }) }
  const tests: Obj = { mode: sel.mode, why: sel.why, files: sel.files, commands: sel.mode === 'full' ? (sel.full === undefined ? [] : [sel.full]) : sel.commands }
  if (sel.mode === 'targeted') {
    let exit = 0
    let text = ''
    for (const c of sel.commands) {
      const r = bashRun(cwd, c)
      text += `\n$ ${c}\n${r.text}`
      if (r.exit !== 0 && exit === 0) exit = r.exit
    }
    return { exit, text, tests }
  }
  if (sel.full === undefined) return { exit: 0, text: '\nno full-suite command is known (set targetedTests.full)\n', tests: { ...tests, why: [...sel.why, 'no full-suite command is known (set targetedTests.full)'] } }
  const r = suiteRun(f, dir, slug, cwd, sel.full)
  return r.slot !== undefined ? { exit: 1, text: '', tests, slot: r.slot } : { exit: r.exit, text: `\n$ ${sel.full}\n${r.text}`, tests }
}

// A full-suite run inside the heavy slot (0.31.0 item 2): takes the slot for exactly its own run, then records its time for
// slotWaitMs. A slot not free within heavyWaitMs comes back as `slot: {ran: false}` and nothing runs.
function suiteRun(f: Flags, dir: string, slug: string, cwd: string, command: string): { exit: number; text: string; slot?: Obj } {
  const limit = heavyWaitMs(f, process.env, dir)
  const label = `${slug}-check`
  const a = acquireSlot(dir, { label, slug }, slotsAt(cwd), limit)
  if (a.token === null) return { exit: 1, text: '', slot: { ran: false, waitedMs: a.waitedMs, waitLimitMs: limit, why: `waited ${a.waitedMs} ms (limit ${limit} ms) for the heavy slot and free memory` } }
  const t1 = Date.now()
  let r: { exit: number; text: string }
  try {
    r = bashRun(cwd, command)
  } finally {
    releaseHeavySlot(dir, a.token)
  }
  recordHeavyTime(dir, { label, slug, ms: Date.now() - t1 })
  return r
}

export function cmdCheck(f: Flags): Obj {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  const cwd = flat(need(f, 'cwd'))
  const expect = need(f, 'expect')
  if (expect !== 'red' && expect !== 'green') throw usage('--expect must be red or green')
  const crew = loadPlan(dir).crews.find((c: Obj) => isObj(c) && c.slug === slug)
  if (crew === undefined) throw usage(`no crew ${slug} in the plan`)
  // the goal file is the one home of the acceptance command: its `## Acceptance test` fenced block wins; plan.json's acceptanceTest
  // is the fallback only when the goal file has no such section, and a malformed section is refused, never guessed at
  const goalFile = `${dir}/goals/${slug}.md`
  const fromGoal = existsSync(goalFile) ? acceptanceCommand(readFileSync(goalFile, 'utf8')) : undefined
  if (typeof fromGoal === 'object') throw refuse({ ok: false, why: `goal file ${flat(goalFile)}: ${fromGoal.error}` })
  const acceptanceTest = fromGoal ?? crew.acceptanceTest
  if (typeof acceptanceTest !== 'string' || acceptanceTest === '') throw usage(`crew ${slug} has no acceptanceTest`)
  // 0.31.0 item 1: a trailing whole-suite step (`&& npm test`) is cut; the green check adds the targeted set itself. An acceptance
  // test that is nothing but the suite stays as it is, and since it is the whole suite it runs inside the heavy slot (suiteRun,
  // item 2); its green run is then the full suite already, so no tests are added after it.
  const cut = stripBlanketSuite(acceptanceTest)
  const suiteOnly = cut.blanket && cut.command.trim() === ''
  const command = cut.blanket && !suiteOnly ? cut.command : acceptanceTest
  // a failed install goes into the check text, so the env catalog sees it
  const installs = expect === 'green' ? installMissingDeps(cwd).filter((i) => i.status !== 0) : []
  const acc = suiteOnly ? suiteRun(f, dir, slug, cwd, command) : bashRun(cwd, command)
  let exit = acc.exit
  let text = installs.map((i) => `npm ci failed in ${i.dir} (exit ${i.status}):\n${i.output}\n`).join('') + acc.text
  let tests: Obj | undefined = suiteOnly ? { mode: 'full', why: ['the acceptance test is the full suite'], files: [], commands: [command] } : undefined
  let slot: Obj | undefined = 'slot' in acc ? acc.slot : undefined
  if (expect === 'green' && exit === 0 && !suiteOnly) {
    const t = checkTests(f, dir, slug, cwd)
    exit = t.exit
    text += t.text
    tests = t.tests
    slot = t.slot
  }
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const tail = lines.slice(-40).join('\n')
  const head = gitOrFail(cwd, ['rev-parse', 'HEAD'])
  if (slot !== undefined) throw refuse({ ok: false, exit, head, tail, tests, slot })
  mkdirSync(`${dir}/checks`, { recursive: true })
  const used = readdirSync(`${dir}/checks`).map((n) => new RegExp(`^${slug.replace(/[^a-z0-9-]/g, '\\$&')}-(\\d+)\\.json$`).exec(n)?.[1]).filter((n) => n !== undefined).map(Number)
  const n = (used.length === 0 ? 0 : Math.max(...used)) + 1
  // a failing run whose env lines explain every failure carries `env`: never a red, and no fix builder for a green. One whose
  // env lines leave a code failure unexplained carries `envSeen` instead and counts as red (ADR-0024 item 34).
  const { env, envSeen } = exit === 0 ? {} : envVerdict(text)
  const envKeys = { ...(env === undefined ? {} : { env }), ...(envSeen === undefined ? {} : { envSeen }) }
  const known = exit === 0 ? [] : catalogHits(text)
  const record = `${dir}/checks/${slug}-${n}.json`
  writeFileSync(record, JSON.stringify({ command, exit, head, tail, ...(tests === undefined ? {} : { tests }), ...envKeys, ...(known.length === 0 ? {} : { catalog: known }) }) + '\n', { flag: 'wx' })
  const ok = expect === 'red' ? exit !== 0 && env === undefined : exit === 0
  const since = ok && expect === 'green' ? testsSinceOf(cwd, f) : {}
  const body = { ok, exit, head, tail, record, ...(tests === undefined ? {} : { tests }), ...envKeys, ...(known.length === 0 ? {} : { catalog: known }), ...(ok && expect === 'green' ? { sourceChanges: sourceChangesOf(cwd, f) } : {}), ...(since.list === undefined ? {} : { testsSince: since.list }), ...(since.unknown === undefined ? {} : { testsUnknown: since.unknown }) }
  if (!ok) throw refuse(body)
  return body
}


// ADR-0046 item 3: with --tests-since <sha>, the test files (isTestPath) changed in <sha>..HEAD, so stage.js can fail a stress-fix
// round that added no regression test. Undefined without the flag, or when the range can't be read (no list, no check).
// A test file is one isTestPath names or one a `testGlobs` glob of .claude/truss.json matches. When the list is empty and no
// tracked file of the worktree is a test file by either rule, truss can't tell the project's tests apart: the list is unknown
// (undefined, so stage.js checks nothing) and `testsUnknown` says why, for stage.js to log as a warning.
function testsSinceOf(cwd: string, f: Flags): { list?: string[]; unknown?: string } {
  const sha = typeof f['tests-since'] === 'string' ? f['tests-since'] : ''
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) return {}
  const r = run(cwd, ['-c', 'core.quotepath=off', 'diff', '--name-only', '--no-renames', `${sha}..HEAD`])
  if (r.status !== 0) return {}
  let globs: string[] = []
  try {
    const g = configOf(repoOf(f)).testGlobs
    globs = Array.isArray(g) ? g.filter((x: unknown): x is string => typeof x === 'string' && x !== '') : []
  } catch {
    globs = []
  }
  const isTest = (p: string): boolean => isTestPath(p) || globs.some((g) => path.matchesGlob(p, g))
  const list = r.out.split('\n').map((l) => l.trim()).filter((p) => p !== '' && isTest(p)).sort()
  if (list.length > 0) return { list }
  const all = run(cwd, ['-c', 'core.quotepath=off', 'ls-files'])
  if (all.status === 0 && !all.out.split('\n').some((p) => p.trim() !== '' && isTest(p.trim()))) {
    return { unknown: 'no tracked file is a test file by name or by testGlobs, so the stress-fix round\'s regression tests were not checked; set testGlobs in .claude/truss.json' }
  }
  return { list }
}

// ADR-0033: the non-test source files the crew's diff (merge-base with the target ... HEAD) adds, renames or deletes, from
// `git diff --name-status -M`, so the knowledge step runs for new or moved functionality even when no member reported a learned
// item. A source file has a code extension and is not a test, a fixture, a doc (docs/, doc/) or under .claude/. A plain edit is no
// change. Best effort: when the target or the diff can't be read the list is empty. At most 100 entries.
function sourceChangesOf(cwd: string, f: Flags): Obj[] {
  const code = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|rb|php|cs|c|cc|cpp|h|hpp|swift|scala|vue|svelte|sh|sql)$/
  const source = (p: string): boolean => code.test(p) && !isTestPath(p) && !/^(docs?|\.claude)\//.test(p)
  let out: string
  try {
    out = gitOrFail(cwd, ['-c', 'core.quotepath=off', 'diff', '--name-status', '-M', `${baseOf(cwd, settingsFor(f, repoOf(f)).target)}...HEAD`])
  } catch {
    return []
  }
  const changes: Obj[] = []
  for (const line of out.split('\n')) {
    const [st, a, b] = line.split('\t')
    const status = st?.[0]
    if (a === undefined || (status !== 'A' && status !== 'D' && status !== 'R')) continue
    if (status === 'R') {
      if (b !== undefined && (source(a) || source(b))) changes.push({ status, path: b, from: a })
    } else if (source(a)) changes.push({ status, path: a })
  }
  return changes.slice(0, 100)
}

// ADR-0012 Decision 10: the catalog entries a failed check's output hits, in catalog order, each with the first line that hits it.
// An unreadable catalog gives no hits: a check never fails over it.
function catalogHits(text: string): { id: string; fix: string; line: string }[] {
  let catalog: Catalog
  try {
    catalog = retro().cat.loadCatalog(`${PLUGIN}/retro/catalog.json`)
  } catch {
    return []
  }
  const first = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    const shown = line.trim()
    for (const id of retro().cat.matchLine(line, catalog)) if (!first.has(id)) first.set(id, shown.length > 300 ? `${shown.slice(0, 299)}…` : shown)
  }
  return catalog.entries.filter((e) => first.has(e.id)).map((e) => ({ id: e.id, fix: e.fix, line: first.get(e.id) as string }))
}

// ADR-0012 Decision 9: probes every crew need and every catalog probe on the host; writes nothing.
export function runProbe(probe: Obj, repo: string): { pass: boolean; detail: string } {
  if (probe.kind === 'file') {
    const p = String(probe.path)
    return existsSync(path.resolve(repo, p)) ? { pass: true, detail: '' } : { pass: false, detail: p }
  }
  const r = spawnSync('bash', ['-c', String(probe.run)], { cwd: repo, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  // bash exiting 0 passes even when a background child held the pipes until the timeout (spawnSync then sets ETIMEDOUT with status 0)
  if (r.status === 0) return { pass: true, detail: '' }
  const first = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n').map((l) => l.trim()).find((l) => l !== '')
  const why = r.error !== undefined ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`
  const detail = first ?? why
  return { pass: false, detail: detail.length > 300 ? `${detail.slice(0, 299)}…` : detail }
}
