// The retro's command line (ADR-0012 Seams, Decisions 5, 7 and 8): extract, findings, recur, scrub and state.
// `main` returns the text and exit code; running the file prints the text and sets the code. Exit 0 means OK, 1 means
// the input failed a check (a scrub hit), 2 means a usage error or a file it cannot read. Evidence is checked against
// the extract's files and line counts, never the transcripts (R-35). Erasable TypeScript only, Node standard library
// only (P19).
import { execFileSync } from 'node:child_process'
import { existsSync,mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KINDS, loadCatalog, recurrences } from './catalog.ts'
import type { Catalog } from './catalog.ts'
import { extractSession, writeExtract } from './extract.ts'
import { scrub } from './scrub.ts'

// argument counts after the command name
export const COMMANDS = {
  extract: { min: 2, max: 3 },
  findings: { min: 3, max: 3 },
  recur: { min: 1, max: 2 },
  scrub: { min: 1, max: Infinity },
  state: { min: 3, max: 4 },
}

export type Result = { code: number; out: string }

export const STEPS = ['extract', 'judges', 'triage', 'fixGoal', 'applied'] as const
export const STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'] as const

type Obj = Record<string, unknown>
export type Evidence = { file: string; line: number; quote?: string }
export type Judged = {
  kind: string
  title: string
  evidence: Evidence[]
  cost: string
  fix: string
  target: string
  signature: string[]
  recurs?: { catalog: string; fixedBy: { finding: string; date: string } }
}
export type Finding = Judged & { id: string; judge: string }
export type FilesList = { path: string; lines: number }[]
export type Step = { status: string; at: string | null; detail: string | null }
export type RetroState = { v: 1; updatedAt: string; steps: Record<string, Step> }

// a failure that exits 2: usage, unreadable file, bad extract
class Fatal extends Error {}

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const codeOf = (e: unknown): string => (e as { code?: string }).code ?? 'error'

const read = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    throw new Fatal(`cannot read ${path} (${codeOf(e)})`)
  }
}

const writeAtomic = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

const defaultCatalog = (): string => join(dirname(fileURLToPath(import.meta.url)), 'catalog.json')

const catalogAt = (path: string | undefined): Catalog => {
  try {
    return loadCatalog(path ?? defaultCatalog())
  } catch (e) {
    throw new Fatal((e as Error).message)
  }
}

/** The extract's files list, read from <truss dir>/retro/extract.json; the catalog hits ride along for recur. */
const loadExtract = (trussDir: string): { files: FilesList; catalogHits: unknown[] } => {
  const path = join(trussDir, 'retro', 'extract.json')
  let x: unknown
  try {
    x = JSON.parse(read(path))
  } catch (e) {
    if (e instanceof Fatal) throw e
    throw new Fatal(`bad extract ${path}: not JSON`)
  }
  const bad = (why: string) => new Fatal(`bad extract ${path}: ${why}`)
  if (!isObj(x) || x.v !== 1) throw bad('not an extract of version 1')
  if (!Array.isArray(x.files)) throw bad('files must be an array')
  const files: FilesList = []
  for (const f of x.files) {
    if (!isObj(f) || !nonEmpty(f.path) || !Number.isInteger(f.lines)) throw bad('every file needs a path and a line count')
    files.push({ path: f.path, lines: f.lines as number })
  }
  return { files, catalogHits: Array.isArray(x.catalogHits) ? x.catalogHits : [] }
}

// ---------- findings (Decision 5) ----------

const onlyKeys = (o: Obj, allowed: string[]): string | null => {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return `unknown property "${k}"`
  return null
}

/** Why a value breaks $defs.judged against the extract's files, or null when it holds. */
function judgedProblem(v: unknown, files: FilesList): string | null {
  if (!isObj(v)) return 'block is not a JSON object'
  const extra = onlyKeys(v, ['kind', 'title', 'evidence', 'cost', 'fix', 'target', 'signature', 'recurs'])
  if (extra) return extra
  if (!(KINDS as readonly unknown[]).includes(v.kind)) return 'kind is not one of the seven kinds'
  if (!nonEmpty(v.title)) return 'title must be 1 to 200 characters'
  // over 200: cut to the first 200 instead of dropping (v is this call's own parsed JSON)
  v.title = v.title.slice(0, 200)
  for (const k of ['cost', 'fix', 'target'] as const) if (!nonEmpty(v[k])) return `${k} must be a non-empty string`
  if (!Array.isArray(v.evidence) || v.evidence.length === 0) return 'no evidence line'
  for (const e of v.evidence) {
    if (!isObj(e)) return 'evidence entry is not an object'
    const bad = onlyKeys(e, ['file', 'line', 'quote'])
    if (bad) return `evidence ${bad}`
    if (!nonEmpty(e.file)) return 'evidence file must be a non-empty string'
    if (!Number.isInteger(e.line) || (e.line as number) < 1) return 'evidence line must be a whole number of at least 1'
    if ('quote' in e) {
      if (typeof e.quote !== 'string') return 'evidence quote must be a string of at most 200 characters'
      e.quote = e.quote.slice(0, 200)
    }
    const f = files.find((x) => x.path === e.file)
    if (!f) return `evidence file ${e.file} is not in the extract`
    if ((e.line as number) > f.lines) return `evidence line ${e.line} is past the end of ${e.file} (${f.lines} lines)`
  }
  if (!Array.isArray(v.signature) || v.signature.length === 0) return 'signature must be a non-empty array'
  for (const p of v.signature) {
    if (!nonEmpty(p)) return 'every signature pattern must be a non-empty string'
    try {
      new RegExp(p)
    } catch {
      return `signature pattern ${JSON.stringify(p)} does not compile`
    }
  }
  if ('recurs' in v) {
    const r = v.recurs
    const f = isObj(r) ? r.fixedBy : null
    if (!isObj(r) || onlyKeys(r, ['catalog', 'fixedBy']) || !nonEmpty(r.catalog) || !isObj(f) || onlyKeys(f, ['finding', 'date']) || !nonEmpty(f.finding) || !nonEmpty(f.date)) {
      return 'recurs must be {catalog, fixedBy: {finding, date}}'
    }
  }
  return null
}

/** The fenced `finding` blocks of a judge's report, in order: each is kept (a valid $defs.judged) or dropped with a reason. `n` is the block's 1-based position. */
export function parseFindings(report: string, files: FilesList): { kept: { n: number; finding: Judged }[]; dropped: { n: number; reason: string }[] } {
  const kept: { n: number; finding: Judged }[] = []
  const dropped: { n: number; reason: string }[] = []
  const lines = report.split(/\r?\n/)
  let n = 0
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() !== '```finding') continue
    const body: string[] = []
    let j = i + 1
    while (j < lines.length && lines[j].trimEnd() !== '```') body.push(lines[j++])
    n++
    const closed = j < lines.length
    i = j
    if (!closed) {
      dropped.push({ n, reason: 'block is never closed' })
      continue
    }
    let v: unknown
    try {
      v = JSON.parse(body.join('\n'))
    } catch {
      dropped.push({ n, reason: 'block is not valid JSON' })
      continue
    }
    const why = judgedProblem(v, files)
    if (why) dropped.push({ n, reason: why })
    else kept.push({ n, finding: v as Judged })
  }
  return { kept, dropped }
}

type FindingsFile = { v: 1; findings: Finding[] }

const loadFindings = (trussDir: string): FindingsFile => {
  try {
    const f = JSON.parse(readFileSync(join(trussDir, 'retro', 'findings.json'), 'utf8'))
    if (isObj(f) && f.v === 1 && Array.isArray(f.findings)) return f as FindingsFile
  } catch {
    // missing or corrupt: a reader treats it as absent
  }
  return { v: 1, findings: [] }
}

const saveFindings = (trussDir: string, f: FindingsFile): void => writeAtomic(join(trussDir, 'retro', 'findings.json'), JSON.stringify(f, null, 2) + '\n')

const nextId = (f: FindingsFile): number => f.findings.reduce((m, x) => Math.max(m, Number(/^F-(\d+)$/.exec(x.id)?.[1] ?? 0)), 0) + 1

function runFindings(trussDir: string, label: string, reportPath: string): string[] {
  const { files } = loadExtract(trussDir)
  const report = read(reportPath)
  if (label === '') throw new Fatal('judge label must not be empty')
  const { kept, dropped } = parseFindings(report, files)
  const file = loadFindings(trussDir)
  let id = nextId(file)
  const rows: { n: number; line: string }[] = []
  for (const k of kept) {
    const f: Finding = { id: `F-${id++}`, judge: label, ...k.finding }
    file.findings.push(f)
    rows.push({ n: k.n, line: `KEPT: ${f.id} | ${f.title}` })
  }
  for (const d of dropped) rows.push({ n: d.n, line: `DROPPED: ${d.n} | ${d.reason}` })
  rows.sort((a, b) => a.n - b.n)
  if (kept.length > 0) saveFindings(trussDir, file)
  return [...rows.map((r) => r.line), `OK: ${kept.length} kept, ${dropped.length} dropped`]
}

// ---------- recur (Decision 7) ----------

function runRecur(trussDir: string, catalogPath: string | undefined): string[] {
  const x = loadExtract(trussDir)
  const catalog = catalogAt(catalogPath)
  const fixed = catalog.entries.filter((e) => e.fixedBy !== null)
  const hits = recurrences({ catalogHits: x.catalogHits as never }, catalog)
  const lines: string[] = []
  const byId = new Map<string, typeof hits>()
  for (const h of hits) {
    lines.push(`RECURRED: ${h.id} | fixed by ${h.fixedBy.finding} (${h.fixedBy.date}) | ${h.file}:${h.line}`)
    byId.set(h.id, [...(byId.get(h.id) ?? []), h])
  }
  const file = loadFindings(trussDir)
  let id = nextId(file)
  let added = 0
  for (const [entryId, hs] of byId) {
    const e = catalog.entries.find((c) => c.id === entryId)!
    const fixedBy = e.fixedBy!
    // running recur twice on one truss dir adds the entry once
    if (file.findings.some((f) => f.judge === 'recur' && f.recurs?.catalog === entryId && f.recurs.fixedBy.finding === fixedBy.finding && f.recurs.fixedBy.date === fixedBy.date)) continue
    const seen = new Set<string>()
    const evidence: Evidence[] = []
    for (const h of hs) {
      const key = `${h.file}:${h.line}`
      if (seen.has(key) || evidence.length >= 20) continue
      seen.add(key)
      evidence.push({ file: h.file, line: h.line })
    }
    file.findings.push({
      id: `F-${id++}`,
      judge: 'recur',
      kind: e.kind,
      title: `${e.title} came back after ${fixedBy.finding} fixed it`.slice(0, 200),
      evidence,
      cost: `catalog entry ${e.id} matched ${hs.length} line${hs.length === 1 ? '' : 's'} of this session after the fix of ${fixedBy.finding} (${fixedBy.date})`,
      fix: e.fix,
      target: 'retro/catalog.json',
      signature: [...e.patterns],
      recurs: { catalog: e.id, fixedBy: { finding: fixedBy.finding, date: fixedBy.date } },
    })
    added++
  }
  if (added > 0) saveFindings(trussDir, file)
  lines.push(`OK: ${byId.size} recurred of ${fixed.length} fixed`)
  return lines
}

// ---------- state (Decision 8) ----------

const validStep = (s: unknown): s is Step =>
  isObj(s) && (STATUSES as readonly unknown[]).includes(s.status) && (s.at === null || typeof s.at === 'string') && (s.detail === null || typeof s.detail === 'string')

const freshState = (): RetroState => ({
  v: 1,
  updatedAt: new Date().toISOString(),
  steps: Object.fromEntries(STEPS.map((s) => [s, { status: 'pending', at: null, detail: null }])),
})

const loadState = (path: string): RetroState => {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'))
    if (isObj(s) && s.v === 1 && isObj(s.steps) && STEPS.every((k) => validStep((s.steps as Obj)[k]))) {
      return { v: 1, updatedAt: String(s.updatedAt), steps: Object.fromEntries(STEPS.map((k) => [k, (s.steps as Obj)[k] as Step])) }
    }
  } catch {
    // missing or corrupt: start from every step pending
  }
  return freshState()
}

/** Set one step of <truss dir>/retro/state.json, the file's only writer. A missing or unusable file starts with every step pending. */
export function writeState(trussDir: string, step: string, status: string, detail?: string): RetroState {
  if (!(STEPS as readonly string[]).includes(step)) throw new Fatal(`step must be one of ${STEPS.join(', ')}: ${step}`)
  if (!(STATUSES as readonly string[]).includes(status)) throw new Fatal(`status must be one of ${STATUSES.join(', ')}: ${status}`)
  const text = detail === undefined ? null : detail.replace(/\s+/g, ' ').trim()
  if (text !== null && text.length > 200) throw new Fatal(`detail must be at most 200 characters, got ${text.length}`)
  const path = join(trussDir, 'retro', 'state.json')
  const state = loadState(path)
  const now = new Date().toISOString()
  state.steps[step] = { status, at: status === 'pending' ? null : now, detail: text === '' ? null : text }
  state.updatedAt = now
  writeAtomic(path, JSON.stringify(state, null, 2) + '\n')
  return state
}

// ---------- extract and scrub ----------

function runExtract(trussDir: string, sessionDir: string, catalogPath: string | undefined): string[] {
  const catalog = catalogAt(catalogPath)
  try {
    if (!statSync(sessionDir).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Fatal(`cannot read session dir ${sessionDir}`)
  }
  let x: ReturnType<typeof extractSession>
  try {
    x = extractSession(sessionDir, catalog)
    writeExtract(trussDir, x)
  } catch (e) {
    throw new Fatal(`extract failed: ${(e as Error).message}`)
  }
  return [`OK: ${x.items.length} items, ${x.catalogHits.length} catalog hits from ${x.files.length} files`]
}

// the person names scrub looks for: the git user name and TRUSS_SCRUB_NAMES (comma separated); never written to a file
function scrubNames(): string[] {
  const out: string[] = []
  const env = process.env.TRUSS_SCRUB_NAMES
  if (env) out.push(...env.split(','))
  try {
    out.push(execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }))
  } catch {
    // no git or no name set: nothing to add
  }
  // each name whole, plus each of its parts of 4 or more characters
  const all = new Set<string>()
  for (const n of out.map(s => s.trim())) {
    if (n.length >= 4) all.add(n)
    for (const part of n.split(/\s+/)) if (part.length >= 4) all.add(part)
  }
  return [...all]
}

// ADR-0016 Decision 3: the plugin manifest's published author.name is accepted, and nothing wider. Returns the
// 1-based line that holds the author.name value when the text parses as JSON with a string author.name and that
// line carries the name only as that value; 0 (nothing accepted) otherwise. Only the `name` hit on that line is
// dropped by the caller; email, home-path and token hits there, and every other line, stay.
function manifestAuthorLine(text: string, names: string[]): number {
  let value: unknown
  try {
    const author = (JSON.parse(text) as { author?: { name?: unknown } } | null)?.author
    value = author?.name
  } catch {
    return 0
  }
  if (typeof value !== 'string' || value.length === 0) return 0
  const quoted = JSON.stringify(value)
  const lines = text.split('\n')
  const from = lines.findIndex(l => l.includes('"author"'))
  if (from === -1) return 0
  for (let i = from; i < lines.length; i++) {
    const l = lines[i]!
    const k = l.indexOf(quoted)
    if (k === -1 || !/"name"\s*:\s*$/.test(l.slice(0, k))) continue
    // the name must not also sit elsewhere on that line (a one-line manifest)
    const rest = l.slice(0, k) + l.slice(k + quoted.length)
    if (scrub(rest, names).some(h => h.kind === 'name')) return 0
    return i + 1
  }
  return 0
}

function runScrub(paths: string[]): { code: number; lines: string[] } {
  const lines: string[] = []
  const names = scrubNames()
  let checked = 0
  for (const arg of paths) {
    // --deleted=PATH names a file the fix removed: absent is fine, present is scrubbed like any other
    const deleted = arg.startsWith('--deleted=')
    const p = deleted ? arg.slice('--deleted='.length) : arg
    if (p.length === 0) throw new Fatal('--deleted= needs a path')
    if (deleted && !existsSync(p)) {
      lines.push(`GONE: ${p}`)
      continue
    }
    if (!existsSync(p)) throw new Fatal(`cannot read ${p} (ENOENT)`)
    checked++
    const text = read(p)
    const accepted = p.replace(/\\/g, '/').endsWith('.claude-plugin/plugin.json') ? manifestAuthorLine(text, names) : 0
    for (const h of scrub(text, names)) {
      if (h.kind === 'name' && h.line === accepted) continue
      lines.push(`HIT: ${p}:${h.line} | ${h.kind}`)
    }
  }
  if (lines.some(l => l.startsWith('HIT: '))) return { code: 1, lines: lines.filter(l => l.startsWith('HIT: ')) }
  const gone = lines.length
  return { code: 0, lines: [`OK: ${checked} files clean${gone > 0 ? `, ${gone} deleted` : ''}`, ...lines] }
}

const run = (cmd: string, a: string[]): { code: number; lines: string[] } => {
  if (cmd === 'extract') return { code: 0, lines: runExtract(a[0], a[1], a[2]) }
  if (cmd === 'findings') return { code: 0, lines: runFindings(a[0], a[1], a[2]) }
  if (cmd === 'recur') return { code: 0, lines: runRecur(a[0], a[1]) }
  if (cmd === 'scrub') return runScrub(a)
  writeState(a[0], a[1], a[2], a[3])
  return { code: 0, lines: [`OK: ${a[1]} ${a[2]}`] }
}

export const main = (argv: string[]): Result => {
  const [cmd, ...args] = argv
  try {
    if (cmd === undefined || !Object.hasOwn(COMMANDS, cmd)) {
      throw new Fatal(`USAGE: retro/cli.ts <${Object.keys(COMMANDS).join('|')}> <args>`)
    }
    const { min, max } = COMMANDS[cmd as keyof typeof COMMANDS]
    if (args.length < min || args.length > max) {
      throw new Fatal(`USAGE: ${cmd} takes ${min === max ? min : max === Infinity ? `${min} or more` : `${min}-${max}`} arguments, got ${args.length}`)
    }
    const r = run(cmd, args)
    return { code: r.code, out: `${r.lines.join('\n')}\n` }
  } catch (e) {
    if (e instanceof Fatal) return { code: 2, out: `FAIL: ${e.message}\n` }
    throw e
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const r = main(process.argv.slice(2))
  process.stdout.write(r.out)
  process.exitCode = r.code
}
