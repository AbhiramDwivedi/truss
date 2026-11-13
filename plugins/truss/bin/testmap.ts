// Targeted testing (truss 0.31.0, speed goal item 1): a deterministic map from a diff to the tests that cover it. No agent
// judgement: the same tree and diff always give the same selection. selectTests is the pure core; selectForCheckout reads the diff,
// the tracked files and package.json from a git checkout. Node built-ins only; never imports factory.ts (top-level await).

import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

export type MapEntry = { paths: string[]; tests?: string[]; run?: string }
/** `.claude/truss.json` `targetedTests` (docs/truss-config.schema.json). */
export type TestsConfig = { runner?: string; full?: string; maxFiles?: number; fullOn?: string[]; map?: MapEntry[] }
export type Selection = { mode: 'targeted' | 'full'; why: string[]; files: string[]; commands: string[]; full?: string }
export type SelectInput = {
  tracked: string[]
  changed: { path: string; deleted: boolean }[]
  read: (p: string) => string | null
  config: TestsConfig
  /** package.json scripts.test, or null when there is none */
  packageTest: string | null
}

export const DEFAULT_MAX_FILES = 40
const JS = /\.[cm]?[jt]sx?$/
const OTHER_CODE = /\.(py|go|rs|java|kt|kts|rb|php|cs|c|cc|cpp|h|hpp|swift|scala|vue|svelte|sh|sql)$/
const RUNNABLE = /\.(test|spec|check)\.[cm]?[jt]sx?$/
const TEST_DIRS = ['tests', 'test', '__tests__', 'spec', 'checks', 'e2e', 'fixtures']
const MANIFEST = /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig(\.[^/]*)?\.json|jsconfig\.json|\.npmrc|\.nvmrc|\.node-version)$/
const CONFIG = /\.config\.[cm]?[jt]s$|^\.(eslintrc|prettierrc|babelrc|swcrc|mocharc)/
const RESOLVE_EXTS = ['.ts', '.js', '.mjs', '.cjs', '.mts', '.cts', '.tsx', '.jsx']
const MAX_READ = 2 * 1024 * 1024

const base = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const inTestDir = (p: string): boolean => p.split('/').slice(0, -1).some((s) => TEST_DIRS.includes(s))
const quote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
const globHit = (p: string, globs: unknown): boolean => Array.isArray(globs) && globs.some((g) => typeof g === 'string' && g !== '' && path.posix.matchesGlob(p, g))

/** A trailing whole-suite step (`npm test`, `pnpm test`, `yarn test`, `npm run test`) cut from an acceptance command: the stage green
 * check adds the targeted set itself, and the full suite runs before merge. */
export function stripBlanketSuite(command: string): { command: string; blanket: boolean } {
  const suite = String.raw`(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|t)(?=$|[\s;&|>])`
  const inline = new RegExp(String.raw`\s*&&\s*${suite}[^\n]*$`)
  const line = new RegExp(String.raw`^\s*${suite}`)
  let blanket = false
  const lines = command.split('\n').filter((l) => {
    if (!line.test(l)) return true
    blanket = true
    return false
  })
  let out = lines.join('\n')
  if (inline.test(out)) {
    blanket = true
    out = out.replace(inline, '')
  }
  return { command: blanket ? out : command, blanket }
}

/** Who uses whom: A -> B when A (a JS file) imports B by a relative specifier, or when A is test-side (a test or a file in a test
 * dir) and names B's file name in a string literal (a test that reads a script or a doc). A source module's literals are data
 * paths, not test reach, so they make no edge. */
function usedBy(tracked: string[], read: (p: string) => string | null): Map<string, Set<string>> {
  const set = new Set(tracked)
  const byName = new Map<string, string[]>()
  for (const p of tracked) byName.set(base(p), [...(byName.get(base(p)) ?? []), p])
  const rev = new Map<string, Set<string>>()
  const edge = (from: string, to: string): void => {
    if (from === to) return
    if (!rev.has(to)) rev.set(to, new Set())
    rev.get(to)!.add(from)
  }
  for (const a of tracked) {
    if (!JS.test(a)) continue
    const text = read(a)
    if (text === null) continue
    const dir = path.posix.dirname(a)
    const testSide = RUNNABLE.test(a) || inTestDir(a)
    for (const m of text.matchAll(/'([^'\n]{1,300})'|"([^"\n]{1,300})"|`([^`\n]{1,300})`/g)) {
      // a template's ${...} parts are path prefixes (`${dir}/bin/factory.ts`): its file name still counts
      const lit = (m[1] ?? m[2] ?? (m[3] ?? '').replace(/\$\{[^}]*\}/g, '/')).trim()
      if (lit.startsWith('.')) {
        const r = path.posix.normalize(path.posix.join(dir, lit))
        const cands = [r, ...RESOLVE_EXTS.map((e) => r + e), ...(r.endsWith('.js') ? [r.slice(0, -3) + '.ts'] : []), ...RESOLVE_EXTS.map((e) => `${r}/index${e}`)]
        const hit = cands.find((c) => set.has(c))
        if (hit !== undefined) edge(a, hit)
      }
      const name = base(lit)
      if (testSide && name.length >= 3 && name.includes('.')) for (const b of byName.get(name) ?? []) edge(a, b)
    }
  }
  return rev
}

/** The selection for one diff: the targeted set and why, or the full suite and why. */
export function selectTests(input: SelectInput): Selection {
  const { config } = input
  const max = Number.isInteger(config.maxFiles) && (config.maxFiles as number) >= 1 ? (config.maxFiles as number) : DEFAULT_MAX_FILES
  const runner = typeof config.runner === 'string' && config.runner.trim() !== '' ? config.runner.trim() : /\bnode\s+--test\b/.test(input.packageTest ?? '') ? 'node --test' : null
  const full = typeof config.full === 'string' && config.full.trim() !== '' ? config.full.trim() : input.packageTest ? 'npm test' : undefined
  const fullWhy: string[] = []
  const why: string[] = []
  const files = new Set<string>()
  const runs: string[] = []
  const changed = input.changed.filter((c) => c.path !== '')
  if (changed.length > max) fullWhy.push(`the diff changes ${changed.length} files, over the limit of ${max} (targetedTests.maxFiles)`)
  let rev: Map<string, Set<string>> | undefined
  // a test inside a nested package (a dir with its own package.json) is that package's: the root runner can't run it, so only a
  // targetedTests.map entry reaches it
  const roots = input.tracked.filter((t) => t !== 'package.json' && base(t) === 'package.json').map((t) => t.slice(0, -'package.json'.length))
  const nested = (x: string): boolean => roots.some((r) => x.startsWith(r))
  const map = Array.isArray(config.map) ? config.map.filter((e) => e && Array.isArray(e.paths)) : []
  for (const { path: p, deleted } of fullWhy.length ? [] : changed) {
    const name = base(p)
    if (globHit(p, config.fullOn)) {
      fullWhy.push(`${p} matches targetedTests.fullOn`)
      continue
    }
    if (p === '.claude/truss.json' || MANIFEST.test(name) || CONFIG.test(name)) {
      fullWhy.push(`${p} is a config file or dependency manifest`)
      continue
    }
    let covered = false
    for (const e of map) {
      if (!globHit(p, e.paths)) continue
      covered = true
      for (const t of Array.isArray(e.tests) ? e.tests : []) if (typeof t === 'string' && t !== '') files.add(t)
      if (typeof e.run === 'string' && e.run.trim() !== '' && !runs.includes(e.run.trim())) runs.push(e.run.trim())
      why.push(`${p}: targetedTests.map entry ${JSON.stringify(e.paths)}`)
    }
    if (deleted) {
      if ((JS.test(p) || OTHER_CODE.test(p)) && !RUNNABLE.test(p) && !covered) fullWhy.push(`${p} was deleted, so what used it can't be traced`)
      continue
    }
    if (inTestDir(p) && !RUNNABLE.test(p) && !covered) {
      fullWhy.push(`${p} is a shared test helper or fixture`)
      continue
    }
    if (OTHER_CODE.test(p) && !JS.test(p)) {
      if (!covered) fullWhy.push(`${p}: no targetedTests.map entry covers this file`)
      continue
    }
    rev ??= usedBy(input.tracked, input.read)
    const seen = new Set<string>([p])
    const queue = [p]
    while (queue.length) for (const u of rev.get(queue.shift() as string) ?? []) if (!seen.has(u)) (seen.add(u), queue.push(u))
    const tests = [...seen].filter((x) => RUNNABLE.test(x) && !nested(x)).sort()
    for (const t of tests) files.add(t)
    if (tests.length) why.push(`${p}: reached by ${tests.join(', ')}`)
    else if (JS.test(p) && !covered) fullWhy.push(`${p} is code that no test reaches`)
  }
  const sorted = [...files].sort()
  if (!fullWhy.length && sorted.some((f) => JS.test(f)) && runner === null) fullWhy.push('no runner is known for the selected JS tests (set targetedTests.runner)')
  if (fullWhy.length) return { mode: 'full', why: fullWhy, files: [], commands: [], ...(full ? { full } : {}) }
  const commands = sorted.length ? [`${runner} ${sorted.map(quote).join(' ')}`, ...runs] : runs
  return { mode: 'targeted', why: why.length ? why : ['no changed file reaches a test'], files: sorted, commands, ...(full ? { full } : {}) }
}

/** selectTests on a git checkout: the diff is base...HEAD; package.json's scripts.test names the runner and the full suite. */
export function selectForCheckout(cwd: string, base: string, config: TestsConfig): Selection {
  const git = (args: string[]) => spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  let packageTest: string | null = null
  try {
    const t = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'))?.scripts?.test
    packageTest = typeof t === 'string' && t.trim() !== '' ? t : null
  } catch {
    packageTest = null
  }
  const full = typeof config.full === 'string' && config.full.trim() !== '' ? config.full.trim() : packageTest ? 'npm test' : undefined
  const diff = git(['diff', '--name-only', '-z', '--no-renames', `${base}...HEAD`])
  const ls = git(['ls-files', '-z'])
  if (diff.status !== 0 || ls.status !== 0) return { mode: 'full', why: [`the diff ${base}...HEAD could not be read`], files: [], commands: [], ...(full ? { full } : {}) }
  const tracked = ls.stdout.split('\0').filter(Boolean)
  const have = new Set(tracked)
  const changed = diff.stdout.split('\0').filter(Boolean).map((p) => ({ path: p, deleted: !have.has(p) }))
  const read = (p: string): string | null => {
    try {
      const f = path.join(cwd, p)
      return statSync(f).size > MAX_READ ? null : readFileSync(f, 'utf8')
    } catch {
      return null
    }
  }
  return selectTests({ tracked, changed, read, config, packageTest })
}
