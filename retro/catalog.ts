// The known-problems catalog (ADR-0012 Decision 3 and 7): loads retro/catalog.json under docs/catalog.schema.json,
// matches one line of text against it, and names the fixed entries a session hit again.
// Erasable TypeScript only, Node standard library only (P19).
import { readFileSync } from 'node:fs'

export const KINDS = [
  'mechanical bug',
  'friction',
  'missing agent persona',
  'missing skill',
  'missing hook or gate',
  'misleading prompt',
  'architecture decision',
] as const

export type FixedBy = { finding: string; date: string }
export type Probe = { kind: 'command'; run: string } | { kind: 'file'; path: string }
export type Entry = {
  id: string
  kind: (typeof KINDS)[number]
  title: string
  anchor: string
  patterns: string[]
  fix: string
  probe?: Probe
  fixedBy: FixedBy | null
}
export type Catalog = { v: 1; entries: Entry[] }

/** One hit of a catalog hit record, as the extract keeps it. */
export type CatalogHit = { id: string; file: string; line: number; quote?: string }
/** The part of an extract that `recurrences` reads. */
export type ExtractLike = { catalogHits?: CatalogHit[] }
export type Recurrence = { id: string; kind: Entry['kind']; fixedBy: FixedBy; file: string; line: number }

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0

const realDate = (s: unknown): boolean => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

const onlyKeys = (o: Record<string, unknown>, allowed: string[], where: string): void => {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`${where}: unknown property "${k}"`)
}

function checkProbe(p: unknown, where: string): void {
  if (!isObj(p)) throw new Error(`${where}: probe must be an object`)
  if (p.kind === 'command') {
    onlyKeys(p, ['kind', 'run'], where)
    if (!nonEmpty(p.run)) throw new Error(`${where}: probe.run must be a non-empty string`)
  } else if (p.kind === 'file') {
    onlyKeys(p, ['kind', 'path'], where)
    if (!nonEmpty(p.path)) throw new Error(`${where}: probe.path must be a non-empty string`)
  } else throw new Error(`${where}: probe.kind must be "command" or "file"`)
}

function checkEntry(e: unknown, at: number): Entry {
  const where = `entries[${at}]`
  if (!isObj(e)) throw new Error(`${where}: must be an object`)
  onlyKeys(e, ['id', 'kind', 'title', 'anchor', 'patterns', 'fix', 'probe', 'fixedBy'], where)
  if (typeof e.id !== 'string' || e.id.length > 100 || !ID.test(e.id)) throw new Error(`${where}: id must be lowercase words joined by single hyphens`)
  if (!(KINDS as readonly unknown[]).includes(e.kind)) throw new Error(`${where}: kind is not one of the R-27 kinds`)
  if (!nonEmpty(e.title) || e.title.length > 200) throw new Error(`${where}: title must be 1 to 200 characters`)
  if (!nonEmpty(e.anchor)) throw new Error(`${where}: anchor must be a non-empty string`)
  if (!Array.isArray(e.patterns) || e.patterns.length === 0) throw new Error(`${where}: patterns must be a non-empty array`)
  for (const p of e.patterns) {
    if (!nonEmpty(p)) throw new Error(`${where}: every pattern must be a non-empty string`)
    try {
      new RegExp(p)
    } catch (err) {
      throw new Error(`${where}: pattern ${JSON.stringify(p)} does not compile (${(err as Error).message})`)
    }
  }
  if (!nonEmpty(e.fix)) throw new Error(`${where}: fix must be a non-empty string`)
  if ('probe' in e) checkProbe(e.probe, where)
  if (!('fixedBy' in e)) throw new Error(`${where}: fixedBy is required (null when no retro has fixed it)`)
  if (e.fixedBy !== null) {
    const f = e.fixedBy
    if (!isObj(f)) throw new Error(`${where}: fixedBy must be null or {finding, date}`)
    onlyKeys(f, ['finding', 'date'], `${where}.fixedBy`)
    if (!nonEmpty(f.finding)) throw new Error(`${where}: fixedBy.finding must be a non-empty string`)
    if (!realDate(f.date)) throw new Error(`${where}: fixedBy.date must be YYYY-MM-DD`)
  }
  return e as unknown as Entry
}

/** Read and validate a catalog file. Throws on an unreadable file, bad JSON, a schema break, a duplicate id or a pattern that does not compile. */
export function loadCatalog(path: string): Catalog {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    throw new Error(`catalog: cannot read ${path} (${(e as { code?: string }).code ?? 'error'})`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`catalog: ${path} is not valid JSON`)
  }
  if (!isObj(raw)) throw new Error('catalog: the file must hold an object')
  onlyKeys(raw, ['v', 'entries'], 'catalog')
  if (raw.v !== 1) throw new Error('catalog: v must be 1')
  if (!Array.isArray(raw.entries)) throw new Error('catalog: entries must be an array')
  const seen = new Set<string>()
  const entries = raw.entries.map((e, i) => {
    const entry = checkEntry(e, i)
    if (seen.has(entry.id)) throw new Error(`catalog: duplicate id "${entry.id}"`)
    seen.add(entry.id)
    return entry
  })
  return { v: 1, entries }
}

/** The ids of the entries a line hits, in catalog order: the line holds the anchor as a literal substring and one pattern matches it. */
export function matchLine(line: string, catalog: Catalog): string[] {
  const ids: string[] = []
  for (const e of catalog.entries) {
    if (!line.includes(e.anchor)) continue
    if (e.patterns.some(p => new RegExp(p).test(line))) ids.push(e.id)
  }
  return ids
}

/** Every hit in the extract of an entry whose fixedBy is set: the fix did not hold. Unfixed entries and ids the catalog lacks give nothing. */
export function recurrences(x: ExtractLike, catalog: Catalog): Recurrence[] {
  const byId = new Map(catalog.entries.map(e => [e.id, e]))
  const out: Recurrence[] = []
  for (const h of x?.catalogHits ?? []) {
    const e = byId.get(h.id)
    if (e?.fixedBy) out.push({ id: e.id, kind: e.kind, fixedBy: e.fixedBy, file: h.file, line: h.line })
  }
  return out
}
