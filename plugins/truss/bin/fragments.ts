// truss 0.31.0 item 4: shared docs stop conflicting. A crew never edits the body of a shared doc (the feature map, the product
// decisions file, the architecture doc, an existing knowledge doc or rule file); it writes its changed sections to its own
// fragment, `<doc dir>/<doc name>.d/<crew>.md` (`docs/features.md` -> `docs/features.d/<crew>.md`). A rule file's fragments sit
// outside the rules dir, which Claude Code loads whole: `.claude/rules/<area>.md` -> `.claude/rules.d/<area>/<crew>.md`.
// `factory stitch` folds every fragment into its doc and deletes it, with no agent judgement: byte-stable, idempotent, and
// git and node:fs only, so it runs the same on macOS, Linux and Windows. A merge conflict confined to YAML frontmatter
// (`verified`, `sources`) resolves here too (`resolveFrontmatterConflicts`), since every crew re-stamps the docs it re-reads.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type Git = (cwd: string, args: string[], input?: string) => { status: number; out: string; err: string }
const defaultGit: Git = (cwd, args, input) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', input, windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status ?? 1, out: (r.stdout ?? '').replace(/\n$/, ''), err: (r.stderr ?? '').trim() }
}

// The body of a fragment section that deletes the doc's section of that heading.
export const REMOVE_MARK = '<!-- remove -->'

const lf = (s: string): string => s.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
const trimEnd = (lines: string[]): string[] => {
  let n = lines.length
  while (n > 0 && lines[n - 1].trim() === '') n--
  return lines.slice(0, n)
}

// ==== where fragments live ====

// The fragment dir of a repo-relative doc path (posix separators). Under the rules dir the fragments go to `<rulesDir>.d/<name>/`.
export function fragmentDirOf(doc: string, rulesDir = '.claude/rules'): string {
  const rd = rulesDir.replace(/\/+$/, '')
  if (doc.startsWith(`${rd}/`)) return `${rd}.d/${doc.slice(rd.length + 1).replace(/\.md$/i, '')}`
  return doc.replace(/\.md$/i, '.d')
}
export const fragmentPathOf = (doc: string, crew: string, rulesDir = '.claude/rules'): string => `${fragmentDirOf(doc, rulesDir)}/${crew}.md`

// The doc a fragment belongs to, or undefined when the path is no fragment: `<x>.d/<crew>.md` -> `<x>.md`, and
// `<rulesDir>.d/<area>/<crew>.md` -> `<rulesDir>/<area>.md`.
export function docOfFragment(file: string, rulesDir = '.claude/rules'): string | undefined {
  const rd = rulesDir.replace(/\/+$/, '')
  if (file.startsWith(`${rd}.d/`)) {
    const rest = file.slice(rd.length + 3)
    const at = rest.lastIndexOf('/')
    if (at <= 0 || !/\.md$/i.test(rest)) return undefined
    return `${rd}/${rest.slice(0, at)}.md`
  }
  const m = /^(.*)\.d\/[^/]+\.md$/i.exec(file)
  return m ? `${m[1]}.md` : undefined
}
export const isFragment = (file: string, rulesDir = '.claude/rules'): boolean => docOfFragment(file, rulesDir) !== undefined

// ==== frontmatter ====

type Field = { key: string; raw: string[]; value: string | string[] }
type Front = { fields: Field[]; body: string[] }

// Splits a doc into its top-level YAML frontmatter fields and its body. A field is `key: scalar` or `key:` with `  - item` lines
// (or any indented lines, kept raw). No frontmatter: fields is [].
export function splitFront(text: string): Front {
  const lines = lf(text).split('\n')
  if (lines[0]?.trim() !== '---') return { fields: [], body: lines }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end < 0) return { fields: [], body: lines }
  const fields: Field[] = []
  for (const l of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(l)
    if (m && !/^\s/.test(l)) {
      fields.push({ key: m[1], raw: [l], value: m[2].trim() })
      continue
    }
    const last = fields[fields.length - 1]
    if (last === undefined) continue
    last.raw.push(l)
    const item = /^\s+-\s+(.*)$/.exec(l)
    if (item) last.value = [...(Array.isArray(last.value) ? last.value : last.value === '' ? [] : [last.value]), item[1].trim()]
  }
  return { fields, body: lines.slice(end + 1) }
}

const same = (a: Field | undefined, b: Field | undefined): boolean => JSON.stringify(a?.value ?? null) === JSON.stringify(b?.value ?? null)
const listOf = (f: Field | undefined): string[] => (f === undefined ? [] : Array.isArray(f.value) ? f.value : f.value === '' ? [] : [f.value])
const listField = (key: string, items: string[]): Field => ({ key, raw: [`${key}:`, ...items.map((i) => `  - ${i}`)], value: items })
const joinFront = (fields: Field[], body: string[]): string => (fields.length === 0 ? body.join('\n') : ['---', ...fields.flatMap((f) => f.raw), '---', ...body].join('\n'))

// Three-way merge of two frontmatters. Per key: a side that left it as base gets the other side's value; both changed it to
// lists: their union, less what either side dropped; both changed `verified`: the newer commit when `newer` can tell (a descendant wins; on diverging branches the later commit date, then the larger sha); any
// other key both sides changed differently: undefined (not resolvable). Keys keep ours' order, then theirs' new keys.
export function mergeFields(base: Field[], ours: Field[], theirs: Field[], newer?: (a: string, b: string) => string | undefined): Field[] | undefined {
  const get = (fs: Field[], k: string): Field | undefined => fs.find((f) => f.key === k)
  const keys = [...ours.map((f) => f.key), ...theirs.map((f) => f.key).filter((k) => !ours.some((f) => f.key === k)), ...base.map((f) => f.key).filter((k) => !ours.some((f) => f.key === k) && !theirs.some((f) => f.key === k))]
  const out: Field[] = []
  for (const k of keys) {
    const b = get(base, k)
    const o = get(ours, k)
    const t = get(theirs, k)
    if (same(o, t)) { if (o !== undefined) out.push(o); continue }
    if (same(o, b)) { if (t !== undefined) out.push(t); continue }
    if (same(t, b)) { if (o !== undefined) out.push(o); continue }
    if (o === undefined || t === undefined) return undefined
    if (Array.isArray(o.value) || Array.isArray(t.value)) {
      const bl = listOf(b)
      const dropped = new Set(bl.filter((x) => !listOf(o).includes(x) || !listOf(t).includes(x)))
      const items = [...listOf(o), ...listOf(t).filter((x) => !listOf(o).includes(x))].filter((x) => !dropped.has(x))
      out.push(listField(k, items))
      continue
    }
    if (k === 'verified' && newer !== undefined) {
      const win = newer(String(o.value), String(t.value))
      if (win === String(o.value)) { out.push(o); continue }
      if (win === String(t.value)) { out.push(t); continue }
    }
    return undefined
  }
  return out
}

// ==== stitch ====

type Section = { depth: number; title: string; lines: string[] }
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/

// The heading line indexes of a markdown body, fenced code skipped.
function headings(lines: string[]): { i: number; depth: number; title: string }[] {
  const out: { i: number; depth: number; title: string }[] = []
  let fence: string | null = null
  lines.forEach((l, i) => {
    const f = /^\s*(```+|~~~+)/.exec(l)
    if (f) { if (fence === null) fence = f[1][0]; else if (f[1][0] === fence) fence = null; return }
    if (fence !== null) return
    const m = HEADING.exec(l)
    if (m) out.push({ i, depth: m[1].length, title: m[2] })
  })
  return out
}

// A fragment's sections: each heading of the fragment's shallowest depth starts one, which runs to the next such heading.
// Text before the first heading is returned as `preamble` (the stitch ignores it, with a warning).
export function fragmentSections(body: string[]): { sections: Section[]; preamble: string[] } {
  const hs = headings(body)
  if (hs.length === 0) return { sections: [], preamble: trimEnd(body).filter((l) => l.trim() !== '') }
  const top = Math.min(...hs.map((h) => h.depth))
  const starts = hs.filter((h) => h.depth === top)
  const sections = starts.map((h, n) => ({ depth: h.depth, title: h.title, lines: trimEnd(body.slice(h.i, n + 1 < starts.length ? starts[n + 1].i : body.length)) }))
  return { sections, preamble: body.slice(0, starts[0].i).filter((l) => l.trim() !== '') }
}

// Applies one section to a doc body: replaces the doc's section with the same depth and title (to the next heading of that depth
// or shallower), or appends it at the end; a section whose body is only REMOVE_MARK deletes the doc's section.
function applySection(body: string[], s: Section): string[] {
  const remove = s.lines.slice(1).map((l) => l.trim()).filter(Boolean).join('\n') === REMOVE_MARK
  const hs = headings(body)
  const at = hs.findIndex((h) => h.depth === s.depth && h.title === s.title)
  if (at < 0) {
    if (remove) return body
    const head = trimEnd(body)
    return [...head, ...(head.length ? [''] : []), ...s.lines]
  }
  const start = hs[at].i
  const next = hs.slice(at + 1).find((h) => h.depth <= s.depth)
  const before = body.slice(0, start)
  const after = next === undefined ? [] : body.slice(next.i)
  if (remove) return [...(after.length ? before : trimEnd(before)), ...after]
  return [...before, ...s.lines, ...(after.length ? [''] : []), ...after]
}

export type Fragment = { name: string; text: string }

// Folds fragments into a doc, in byte order of their names, so the result never depends on read order. Fragment frontmatter
// merges into the doc's: list keys gain the fragment's items, a scalar key takes the fragment's value. Idempotent: stitching the
// result with the same fragments again changes nothing. The result ends with exactly one newline.
export function stitchDoc(doc: string, fragments: Fragment[]): { text: string; warnings: string[] } {
  const warnings: string[] = []
  const front = splitFront(doc)
  let fields = front.fields
  let body = front.body
  const seen = new Map<string, string>()
  for (const f of [...fragments].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const fr = splitFront(f.text)
    for (const fl of fr.fields) {
      const cur = fields.find((x) => x.key === fl.key)
      const merged = Array.isArray(fl.value) || Array.isArray(cur?.value) ? listField(fl.key, [...listOf(cur), ...listOf(fl).filter((x) => !listOf(cur).includes(x))]) : fl
      fields = cur === undefined ? [...fields, merged] : fields.map((x) => (x.key === fl.key ? merged : x))
    }
    const { sections, preamble } = fragmentSections(fr.body)
    if (preamble.length) warnings.push(`${f.name}: text before the first heading is ignored`)
    for (const s of sections) {
      const key = `${s.depth} ${s.title}`
      if (seen.has(key)) warnings.push(`${f.name}: section "${s.title}" also comes from ${seen.get(key)}; ${f.name} wins`)
      seen.set(key, f.name)
      body = applySection(body, s)
    }
  }
  return { text: `${trimEnd(lf(joinFront(fields, body)).split('\n')).join('\n')}\n`, warnings }
}

// ==== the repo step ====

export type StitchResult = { stitched: { doc: string; fragments: string[] }[]; removed: string[]; warnings: string[] }

// Stitches every fragment among `files` (repo-relative, posix) under `root` into its doc and deletes the fragment. A fragment
// whose doc does not exist creates it. Writes only when `write`; returns what it did (or would do), sorted.
export function stitchTree(root: string, files: string[], opts: { rulesDir?: string; write?: boolean } = {}): StitchResult {
  const rulesDir = opts.rulesDir ?? '.claude/rules'
  const byDoc = new Map<string, string[]>()
  for (const f of [...new Set(files.map((x) => x.replace(/\\/g, '/')))].sort()) {
    const doc = docOfFragment(f, rulesDir)
    if (doc === undefined) continue
    byDoc.set(doc, [...(byDoc.get(doc) ?? []), f])
  }
  const out: StitchResult = { stitched: [], removed: [], warnings: [] }
  for (const [doc, frags] of [...byDoc.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const abs = (p: string): string => path.join(root, ...p.split('/'))
    const cur = existsSync(abs(doc)) ? readFileSync(abs(doc), 'utf8') : ''
    const r = stitchDoc(cur, frags.map((f) => ({ name: f, text: readFileSync(abs(f), 'utf8') })))
    out.warnings.push(...r.warnings.map((w) => `${doc}: ${w}`))
    if (opts.write) {
      if (r.text !== cur) writeFileSync(abs(doc), r.text)
      for (const f of frags) rmSync(abs(f), { force: true })
    }
    out.stitched.push({ doc, fragments: frags })
    out.removed.push(...frags)
  }
  return out
}

// ==== frontmatter-only merge conflicts ====

// Resolves each conflicted file of an in-progress merge in `cwd` whose body merges cleanly and whose frontmatter `mergeFields`
// can merge, then stages it. `left` names the files it could not resolve; the caller aborts the merge when any is left.
export function resolveFrontmatterConflicts(cwd: string, git: Git = defaultGit): { resolved: string[]; left: string[] } {
  const u = git(cwd, ['-c', 'core.quotepath=off', 'diff', '--name-only', '--diff-filter=U'])
  const files = u.status === 0 ? u.out.split('\n').map((s) => s.trim()).filter(Boolean) : []
  const out = { resolved: [] as string[], left: [] as string[] }
  const newer = (a: string, b: string): string | undefined => {
    if (git(cwd, ['merge-base', '--is-ancestor', a, b]).status === 0) return b
    if (git(cwd, ['merge-base', '--is-ancestor', b, a]).status === 0) return a
    // Two crews stamp their own branch heads (`crew.head`, `rev-parse HEAD`), so the stamps can sit on diverging branches. The later
    // commit date wins, the larger sha on a tie, so both merge directions give the same stamp. A stamp that is no commit stays unresolved.
    const at = (c: string): number | undefined => {
      const r = git(cwd, ['show', '-s', '--format=%ct', `${c}^{commit}`])
      const n = r.status === 0 ? Number(r.out.trim()) : NaN
      return Number.isFinite(n) ? n : undefined
    }
    const [ta, tb] = [at(a), at(b)]
    if (ta === undefined || tb === undefined) return undefined
    return ta !== tb ? (ta > tb ? a : b) : a > b ? a : b
  }
  for (const file of files) {
    const stage = (n: number): string | undefined => {
      const r = git(cwd, ['show', `:${n}:${file}`])
      return r.status === 0 ? r.out : undefined
    }
    const [b, o, t] = [stage(1), stage(2), stage(3)]
    const fb = b === undefined ? undefined : splitFront(b)
    const fo = o === undefined ? undefined : splitFront(o)
    const ft = t === undefined ? undefined : splitFront(t)
    if (!fb || !fo || !ft || (fo.fields.length === 0 && ft.fields.length === 0)) { out.left.push(file); continue }
    const fields = mergeFields(fb.fields, fo.fields, ft.fields, newer)
    const body = fields === undefined ? undefined : mergeBodies(cwd, git, fb.body.join('\n'), fo.body.join('\n'), ft.body.join('\n'))
    if (fields === undefined || body === undefined) { out.left.push(file); continue }
    writeFileSync(path.join(cwd, ...file.split('/')), `${joinFront(fields, body.replace(/\n$/, '').split('\n'))}\n`)
    if (git(cwd, ['add', '--', file]).status !== 0) { out.left.push(file); continue }
    out.resolved.push(file)
  }
  return out
}

// git merge-file on three texts in a private temp dir; undefined on a conflict.
function mergeBodies(cwd: string, git: Git, base: string, ours: string, theirs: string): string | undefined {
  if (ours === theirs) return ours
  if (ours === base) return theirs
  if (theirs === base) return ours
  const d = mkdtempSync(path.join(os.tmpdir(), 'truss-fm-'))
  try {
    const p = (n: string, s: string): string => {
      const f = path.join(d, n)
      writeFileSync(f, `${s}\n`)
      return f
    }
    const r = git(cwd, ['merge-file', '-p', p('ours', ours), p('base', base), p('theirs', theirs)])
    return r.status === 0 ? r.out : undefined
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
}

// After a `git merge` in `cwd` that stopped on conflicts: resolves the frontmatter-only ones and, when none is left, commits the
// merge with git's own message. True when the merge is now concluded; false leaves it in progress for the caller to abort or report.
export function concludeFrontmatterMerge(cwd: string, git: Git = defaultGit): { concluded: boolean; resolved: string[]; left: string[] } {
  const r = resolveFrontmatterConflicts(cwd, git)
  if (r.left.length > 0 || r.resolved.length === 0) return { concluded: false, ...r }
  const c = git(cwd, ['commit', '--no-edit'])
  return { concluded: c.status === 0, ...r }
}
