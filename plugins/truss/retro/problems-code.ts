// Code structure and tests findings of the generic retro (ADR-0051): `codePart(ctx)` returns a Part that retro/problems.ts `problems` merges
// into the time, quality loop, rules and gates, and cost parts. It imports retro/problems.ts, which imports it: the cycle is safe because
// every import here is used only inside functions.
// Sources, all structured and none a transcript: read-only git (`log`, `show`, `rev-parse`; GIT_OPTIONAL_LOCKS=0 and a timeout, as
// retro/counts.ts `gitRun` does), the events and stage results of the run dir, `checks/*.json` runner reports, and plan.json crews' `owns`.
// Cost is measured: the commit-to-commit time of the commits that touched a file (an idle gap over RESTART_MS is no cost), the crew
// conflict time retro/timing.ts counts, and the test run time its heavy-slot reports give. A split or refactor of a product file is a
// proposed goal for the client and never an auto-fix; a plugin file of the truss repo targets the plugin.
// Erasable TypeScript, Node built-ins only (P19). No price is written here.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { finding, fmtMs, keyPart, keys, plug, plural, put } from './problems.ts'
import type { Ctx, Finding, Part, Target } from './problems.ts'

type Json = Record<string, any>

const MIN = 60000
const GIT_TIMEOUT = 60000
const RESTART_MS = 2 * 60 * MIN // a gap between two commits longer than this is idle, not the cost of the commit
const HOT_COMMITS = 4 // a file touched by this many commits of the run window is a churn hotspot
const SIZE_LINES = 800 // a file this long that the run also edited at least SIZE_TOUCHED times is a size finding
const SIZE_TOUCHED = 3
const MAX_FILES = 6 // churn and size findings, the costliest files only
const MAX_CANDIDATES = 40 // files whose size is read at HEAD
const MIN_COST_MS = MIN // a code finding that cost less than this is noise
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|cs|cpp|cc|c|h|hpp|php|swift|scala|sh|sql|vue|svelte)$/i

const list = (p: string): string[] => { try { return readdirSync(p).sort() } catch { return [] } }
const readJson = (p: string): any => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }

// ---------- read-only git ----------

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: GIT_TIMEOUT, maxBuffer: 1 << 30, windowsHide: true })
  if (r.error || r.status !== 0) return null
  try { return new TextDecoder('utf-8', { fatal: true }).decode(r.stdout).replace(/\r\n?/g, '\n') } catch { return null }
}

/** The repo working dir for a run dir shaped <repo>/.git/truss/<session>, else the dir itself when it is inside a repo, else null. */
function repoOf(dir: string): string | null {
  const abs = resolve(dir)
  const common = dirname(dirname(abs))
  const cwd = basename(dirname(abs)) === 'truss' && basename(common) === '.git' ? dirname(common) : abs
  const top = git(cwd, ['rev-parse', '--show-toplevel'])
  return top === null ? null : cwd
}

type Commit = { sha: string; ms: number; merge: boolean; crews: string[]; files: { path: string; lines: number }[] }

/** The commits of the run window, oldest first, with the files each changed and the Truss-Crew trailers it carries. */
function commitsOf(cwd: string, since: string, until: string): Commit[] {
  const out = git(cwd, ['log', '--no-renames', '--numstat', `--since=${since}`, `--until=${until}`, '--format=@@%H%x09%cI%x09%P%x09%(trailers:key=Truss-Crew,valueonly,separator=%x2C)', 'HEAD'])
  if (out === null) return []
  const commits: Commit[] = []
  for (const line of out.split('\n')) {
    if (line.startsWith('@@')) {
      const [sha, ts, parents, crews] = line.slice(2).split('\t')
      commits.push({ sha, ms: Date.parse(ts), merge: String(parents ?? '').trim().split(/\s+/).filter(Boolean).length > 1, crews: String(crews ?? '').split(',').map((c) => c.trim()).filter(Boolean), files: [] })
    } else if (line !== '' && commits.length > 0) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
      if (m) commits[commits.length - 1].files.push({ path: m[3], lines: (m[1] === '-' ? 0 : Number(m[1])) + (m[2] === '-' ? 0 : Number(m[2])) })
    }
  }
  return commits.filter((c) => !Number.isNaN(c.ms)).reverse()
}

/** Files a merge commit changed against both parents: the combined diff holds only the paths a conflict resolution touched. */
function conflictFiles(cwd: string, since: string, until: string): Map<string, string[]> {
  const out = git(cwd, ['log', '--merges', '--cc', '--name-only', `--since=${since}`, `--until=${until}`, '--format=@@%H', 'HEAD'])
  const by = new Map<string, string[]>()
  if (out === null) return by
  let sha = ''
  for (const line of out.split('\n')) {
    if (line.startsWith('@@')) sha = line.slice(2)
    else if (line !== '' && sha) by.set(sha, [...(by.get(sha) ?? []), line])
  }
  return by
}

const lineCount = (cwd: string, path: string): number => {
  const text = git(cwd, ['show', `HEAD:${path}`])
  return text === null || text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/** A path of the truss plugin on a truss run is a plugin file; any other file is the client's product, so its fix is a proposed goal. */
const targetOf = (ctx: Ctx, path: string): Target => (ctx.truss && path.startsWith('plugins/truss/') ? { kind: 'plugin', path } : { kind: 'proposed-goal', path })

// ---------- code structure ----------

function structurePart(ctx: Ctx): Part {
  const M = ctx.M
  const F: (Finding | null)[] = []
  const stamps = [...ctx.events, ...ctx.usage].map((r) => Date.parse(r.ts)).filter((t) => !Number.isNaN(t))
  const cwd = stamps.length ? repoOf(ctx.dir) : null
  if (cwd === null) return { measures: M, findings: [] }
  const since = new Date(Math.min(...stamps)).toISOString()
  const until = new Date(Math.max(...stamps)).toISOString()
  const commits = commitsOf(cwd, since, until)
  const conflicts = conflictFiles(cwd, since, until)

  // the cost of a commit is the time since the commit before it, when that gap is not idle
  type Acc = { commits: number; ms: number; added: number; crews: Set<string>; conflicts: number; conflictMs: number }
  const files = new Map<string, Acc>()
  commits.forEach((c, i) => {
    const gap = i === 0 ? 0 : c.ms - commits[i - 1].ms
    const ms = gap > 0 && gap <= RESTART_MS ? gap : 0
    const merged = new Set(conflicts.get(c.sha) ?? [])
    const names = new Set([...c.files.map((f) => f.path), ...merged])
    for (const p of names) {
      if (!SOURCE_EXT.test(p)) continue
      const a = files.get(p) ?? { commits: 0, ms: 0, added: 0, crews: new Set<string>(), conflicts: 0, conflictMs: 0 }
      if (!c.merge) a.commits++
      a.ms += c.merge ? 0 : ms
      a.added += c.files.find((f) => f.path === p)?.lines ?? 0
      for (const crew of c.crews) a.crews.add(crew)
      if (merged.has(p)) { a.conflicts++; a.conflictMs += ms }
      files.set(p, a)
    }
  })

  const ranked = [...files.entries()].filter(([, a]) => a.commits >= SIZE_TOUCHED || a.conflicts > 0).sort((x, y) => y[1].ms + y[1].conflictMs - (x[1].ms + x[1].conflictMs) || (x[0] < y[0] ? -1 : 1)).slice(0, MAX_CANDIDATES)
  let made = 0
  for (const [path, a] of ranked) {
    if (made >= MAX_FILES) break
    const hot = a.commits >= HOT_COMMITS
    const lines = lineCount(cwd, path)
    const big = lines >= SIZE_LINES && a.commits >= SIZE_TOUCHED
    const conflicted = a.conflicts > 0
    if (!hot && !big && !conflicted) continue
    const cost = a.ms
    if (cost < MIN_COST_MS && !(conflicted && a.conflictMs >= MIN_COST_MS)) continue
    const k = keyPart(path)
    const ev = keys(put(M, `code.commits.${k}`, a.commits), put(M, `code.commitMs.${k}`, a.ms), put(M, `code.lines.${k}`, lines), put(M, `code.linesChanged.${k}`, a.added),
      put(M, `code.crews.${k}`, a.crews.size), put(M, `code.mergeConflicts.${k}`, a.conflicts), put(M, `code.mergeConflictMs.${k}`, a.conflictMs))
    const why = [hot && `${plural(a.commits, 'commit')} of the run changed it`, big && `it is ${plural(lines, 'line')} long`, conflicted && `it conflicted in ${plural(a.conflicts, 'merge')}`, a.crews.size > 1 && `${a.crews.size} crews changed it`].filter(Boolean)
    const wall = Math.max(a.ms, a.conflictMs)
    F.push(finding(M, `P-code-structure-${k}`, 'code structure', `${path}: ${why.join(', ')}; the commits that touched it took ${fmtMs(wall)} of commit-to-commit time`, ev, { wallMs: wall, tokens: null, usd: null },
      conflicted && a.crews.size > 1
        ? 'Split this file along the seams the crews work on, so two crews stop editing the same file, and put each part in the owns of one crew.'
        : big ? 'Split this file into modules by responsibility, and move the part that changes most into its own file.' : 'Find what makes this file change in every round and move that part out into its own module, so a change touches a small file.',
      targetOf(ctx, path)))
    made++
  }

  // coupling between crews' owns: two crews whose owns patterns overlap, with the conflict time their crews counted
  const plan = readJson(join(ctx.dir, 'plan.json'))
  const crews: { slug: string; owns: string[] }[] = (Array.isArray(plan?.crews) ? plan.crews : []).filter((c: Json) => c && typeof c.slug === 'string' && Array.isArray(c.owns)).map((c: Json) => ({ slug: c.slug, owns: c.owns.filter((o: unknown) => typeof o === 'string') }))
  const timed = new Map<string, Json>((ctx.timing.crews as Json[]).map((c) => [String(c.slug), c]))
  const base = (g: string): string => g.replace(/\/?\*\*?.*$/, '')
  const covers = (a: string, b: string): boolean => a === b || (/\*/.test(a) && (b === base(a) || b.startsWith(`${base(a)}/`)))
  // a crew's conflict time is charged once: it is split evenly over the overlapping pairs the crew is in, so the pairs never add up to more than the crews' own
  const overlap = (i: number, j: number): string[] => [...new Set(crews[i].owns.flatMap((a) => crews[j].owns.filter((b) => covers(a, b) || covers(b, a)).map((b) => (a.length <= b.length ? a : b))))]
  const pairsOf = crews.map((_, i) => crews.filter((_c, j) => j !== i && overlap(Math.min(i, j), Math.max(i, j)).length > 0).length)
  const share = (i: number): number => Number(timed.get(crews[i].slug)?.conflictMs ?? 0) / Math.max(1, pairsOf[i])
  for (let i = 0; i < crews.length; i++) {
    for (let j = i + 1; j < crews.length; j++) {
      const uniq = overlap(i, j)
      if (uniq.length === 0) continue
      const ms = Math.round(share(i) + share(j))
      if (ms < MIN_COST_MS) continue
      const k = `${keyPart(crews[i].slug)}.${keyPart(crews[j].slug)}`
      F.push(finding(M, `P-code-owns-${k}`, 'code structure', `Crews ${crews[i].slug} and ${crews[j].slug} own overlapping paths (${uniq.slice(0, 3).join(', ')}) and their conflict resolution took ${fmtMs(ms)}`,
        keys(put(M, `code.ownsOverlap.${k}`, uniq.length), put(M, `code.ownsConflictMs.${k}`, ms)), { wallMs: ms, tokens: null, usd: null },
        'Plan these crews with owns that do not overlap, or merge the shared files in one crew; if the overlap is a file both need, split that file.', plug(ctx, 'agents/planning-engineer.md')))
    }
  }
  return { measures: M, findings: F.filter((f): f is Finding => f !== null) }
}

// ---------- tests ----------

const FULL = /\bnpm (?:run )?test\b|\byarn test\b|\bpnpm (?:run )?test\b|\bpytest\b(?!\s+\S)|\bgo test \.\/\.\.\./

function testsPart(ctx: Ctx): Part {
  const M = ctx.M
  const F: (Finding | null)[] = []
  type Run = { n: number; exit: number; head: string; command: string; full: boolean; ms: number | null }
  const by = new Map<string, Run[]>()
  for (const f of list(join(ctx.dir, 'checks'))) {
    const m = /^(.+)-(\d+)\.json$/.exec(f)
    const j = m ? readJson(join(ctx.dir, 'checks', f)) : null
    if (!m || j === null || typeof j !== 'object') continue
    const d = [...String(j.tail ?? '').matchAll(/duration_ms\s+([0-9.]+)/g)].pop()
    const run: Run = { n: Number(m[2]), exit: Number(j.exit), head: String(j.head ?? ''), command: String(j.command ?? ''), full: FULL.test(String(j.command ?? '')), ms: d ? Number(d[1]) : null }
    by.set(m[1], [...(by.get(m[1]) ?? []), run])
  }
  for (const [slug, all] of by) {
    const runs = all.sort((a, b) => a.n - b.n)
    const s = keyPart(slug)
    const heavy = (ctx.timing.heavyRuns as Json[]).filter((h) => h.crew === slug && h.ran && typeof h.runMs === 'number' && h.runMs > 0).map((h) => h.runMs as number)
    const runMs = median(heavy)

    // flaky: a run failed at a head and a later run passed at the same head, so the code did not change between them
    const flaky = runs.filter((r, i) => r.exit !== 0 && runs.slice(i + 1).some((x) => x.exit === 0 && x.head === r.head && x.full === r.full)).length
    if (flaky > 0 && runMs > 0) {
      F.push(finding(M, `P-tests-flaky-${s}`, 'tests', `Crew ${slug} had ${plural(flaky, 'check run')} that failed and then passed on the same head, so a test failed at random; each rerun cost about the median ${fmtMs(runMs)} test run`,
        keys(put(M, `tests.flakyRuns.${s}`, flaky), put(M, `tests.medianRunMs.${s}`, runMs), put(M, `tests.checkRuns.${s}`, runs.length)), { wallMs: flaky * runMs, tokens: null, usd: null },
        'Find the test that fails and passes on the same head, and fix its timing or shared state, or mark it as flaky in the test report so the crew does not spend a round on it.', { kind: 'proposed-goal' }))
    }

    // tests run vs needed: a crew needs the full suite once at its merge; each other full run repeats what a targeted run proves
    const fulls = runs.filter((r) => r.full).length
    const targeted = runs.length - fulls
    const excess = fulls - 1
    if (excess > 0 && runMs > 0) {
      F.push(finding(M, `P-tests-selection-${s}`, 'tests', `Crew ${slug} ran the full suite ${plural(fulls, 'time')} in ${plural(runs.length, 'check run')} and only ${plural(targeted, 'run')} were targeted; one full run at the merge is needed`,
        keys(put(M, `tests.fullRuns.${s}`, fulls), put(M, `tests.targetedRuns.${s}`, targeted), put(M, `tests.excessFullRuns.${s}`, excess), put(M, `tests.medianRunMs.${s}`, runMs)), { wallMs: excess * runMs, tokens: null, usd: null },
        'Run the tests of the files a change touches while the crew works, and keep the full suite for the stage green and the merge.', plug(ctx, 'workflows-src/stage/green.js')))
    }

    // suite duration trend: the run time the test reporter printed, first run against the later ones
    // only green runs of one command are compared: a red run stops early and a different command runs a different set of tests
    const byCommand = new Map<string, number[]>()
    for (const r of runs) if (r.exit === 0 && r.ms !== null) byCommand.set(r.command, [...(byCommand.get(r.command) ?? []), r.ms])
    const timed = [...byCommand.values()].sort((a, b) => b.length - a.length)[0] ?? []
    if (timed.length >= 3) {
      const first = timed[0]
      const excessMs = timed.slice(1).reduce((n, d) => n + Math.max(0, d - first), 0)
      const last = timed[timed.length - 1]
      if (last >= first * 1.25 && excessMs >= MIN_COST_MS) {
        F.push(finding(M, `P-tests-trend-${s}`, 'tests', `Crew ${slug}'s test run grew from ${fmtMs(first)} to ${fmtMs(last)} over ${plural(timed.length, 'timed run')}; the later runs took ${fmtMs(excessMs)} more than the first`,
          keys(put(M, `tests.firstRunMs.${s}`, first), put(M, `tests.lastRunMs.${s}`, last), put(M, `tests.timedRuns.${s}`, timed.length), put(M, `tests.growthMs.${s}`, excessMs)), { wallMs: excessMs, tokens: null, usd: null },
          'Find the tests that grew the run: split the slow files, remove duplicate fixtures, and run the slowest ones in parallel.', { kind: 'proposed-goal' }))
      }
    }
  }
  return { measures: M, findings: F.filter((f): f is Finding => f !== null) }
}

/** The code structure and tests parts of the generic retro, for retro/problems.ts to merge with its own. */
export function codePart(ctx: Ctx): Part[] {
  return [structurePart(ctx), testsPart(ctx)]
}
