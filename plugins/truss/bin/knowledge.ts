// truss ADR-0035: path-scoped knowledge. The glob matcher, the frontmatter reader, `knowledge-lint`, `knowledge-migrate` and
// `rules-index` behind bin/factory.ts. Node built-ins only; no shell globbing; every path is posix (`\` turned into `/`) and every
// git call sets core.quotepath=off. Line counts tolerate CRLF.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type Budgets = { agentsIndex: number; persona: number; personaStandards: number; rule: number; featureEntry: number; doc: number }
export const DEFAULT_BUDGETS: Budgets = { agentsIndex: 60, persona: 120, personaStandards: 15, rule: 40, featureEntry: 6, doc: 150 }
// The knowledge keys of truss.json after the caller validated each path (factory.ts repoPathOf).
export type KCfg = { featureMap: string; productDecisions: string; knowledgeDir: string; rulesDir: string; agentsIndex: string; budgets: Budgets }
export type Finding = { check: string; path: string; message: string; new: boolean }
export type LintResult = { ok: boolean; failures: Finding[]; warnings: Finding[]; predatingCount: number; warningCount: number }

const flat = (p: string): string => String(p).replace(/\\/g, '/')

// The budgets with each key that is a non-negative integer taken from `raw`, the default for the rest.
export function budgetsOf(raw: unknown): Budgets {
  const out: Budgets = { ...DEFAULT_BUDGETS }
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const k of Object.keys(DEFAULT_BUDGETS) as (keyof Budgets)[]) {
      const v = (raw as Record<string, unknown>)[k]
      if (Number.isInteger(v) && (v as number) >= 0) out[k] = v as number
    }
  }
  return out
}

// ==== glob ====
// The dialect (shared with stage.js through tests/fixtures/glob-vectors.json): paths are `/`-separated and the glob is anchored at
// the repo root. `*` is any run of characters but `/`, `?` is one character but `/`, a whole segment `**` is any number of
// segments (`a/**/b` also matches `a/b`; a trailing `a/**` needs at least one more segment). Dotfiles are matched like any other
// name. A brace group `{a,b,c}` is alternation: the glob matches when any of its expansions does (an alternative may hold `/`,
// `*`, `?` or `**`). A group is a `{`, then no `{` or `}`, then `}`, with at least one `,`, so there is no nesting: in `{a,{b}}`
// the first `{` meets another `{` first and is literal, `{b}` has no `,` and is literal, and the last `}` is literal. An
// alternative may be empty only in the form `{,x}` (two alternatives, the first empty); any other empty alternative makes the group
// literal. An unbalanced `{` or `}` is literal, and so are `[`, `!` and a `,` outside a group. A leading `./` is dropped, `\` is
// `/`, a trailing `/` means `/**`. Case-sensitive. Characters are code points, so `?` matches one non-ASCII character.
// A glob with more than MAX_BRACE_GROUPS groups, or whose groups expand to more than MAX_BRACE_ALTERNATIVES alternatives, is
// invalid (globError says why) and matches nothing; the count is taken before anything is expanded, so the work stays bounded.
export const MAX_BRACE_GROUPS = 8
export const MAX_BRACE_ALTERNATIVES = 256
type Group = { start: number; end: number; alts: string[] }
// The brace groups, left to right, at most `limit` of them. Whether a `{` opens a group depends only on what follows it.
function braceGroups(chars: string[], limit = Infinity): Group[] {
  const out: Group[] = []
  for (let i = 0; i < chars.length && out.length < limit; i++) {
    if (chars[i] !== '{') continue
    let j = i + 1
    while (j < chars.length && chars[j] !== '{' && chars[j] !== '}') j++
    if (chars[j] !== '}') continue
    const alts = chars.slice(i + 1, j).join('').split(',')
    if (alts.length < 2) continue
    const emptyOk = alts.length === 2 && alts[0] === '' && alts[1] !== ''
    if (!emptyOk && alts.some((a) => a === '')) continue
    out.push({ start: i, end: j, alts })
    i = j
  }
  return out
}
// Why a glob is invalid, or undefined when it is valid.
export function globError(glob: string): string | undefined {
  const groups = braceGroups(Array.from(flat(glob)), MAX_BRACE_GROUPS + 1)
  if (groups.length > MAX_BRACE_GROUPS) return `it has more than ${MAX_BRACE_GROUPS} brace groups`
  let n = 1
  for (const g of groups) {
    n *= g.alts.length
    if (n > MAX_BRACE_ALTERNATIVES) return `its brace groups expand to more than ${MAX_BRACE_ALTERNATIVES} alternatives`
  }
  return undefined
}
// Every expansion of a valid glob; none for an invalid one.
export function expandBraces(glob: string): string[] {
  if (globError(glob) !== undefined) return []
  const chars = Array.from(glob)
  let out = ['']
  let at = 0
  for (const g of braceGroups(chars)) {
    const lit = chars.slice(at, g.start).join('')
    out = out.flatMap((p) => g.alts.map((a) => `${p}${lit}${a}`))
    at = g.end + 1
  }
  const tail = chars.slice(at).join('')
  return out.map((p) => `${p}${tail}`)
}
function globSource(glob: string): string {
  const g = flat(glob).replace(/^(\.\/)+/, '').replace(/^\/+/, '')
  const dir = g.endsWith('/')
  const segs = g.split('/').filter((s) => s !== '')
  if (dir) segs.push('**')
  let re = ''
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1
    if (seg === '**') {
      re += last ? '.+' : '(?:[^/]+/)*'
      return
    }
    for (const ch of Array.from(seg)) re += ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&')
    if (!last) re += '/'
  })
  return re
}
export function globToRegExp(glob: string): RegExp {
  const alts = expandBraces(flat(glob))
  // an invalid glob: `(?!)` never matches (an empty alternation would match the empty path)
  if (alts.length === 0) return /(?!)/u
  return new RegExp(`^(?:${alts.map(globSource).join('|')})$`, 'u')
}
export const globMatch = (glob: string, p: string): boolean => globToRegExp(glob).test(flat(p))
const hasWild = (s: string): boolean => /[*?]/.test(s) || braceGroups(Array.from(s), 1).length > 0

// ==== frontmatter ====
// A small YAML subset: `key: value`, `key: [a, b]` (also over several lines) and `key:` followed by `- item` lines. Undefined when
// the text opens with no frontmatter block. `end` is the index of the line after the closing fence.
export type Frontmatter = { data: Record<string, string | string[]>; end: number }
const splitLines = (text: string): string[] => text.replace(/^﻿/, '').split(/\r\n|\r|\n/)
const unquote = (s: string): string => {
  const t = s.trim()
  return t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'"))) ? t.slice(1, -1) : t
}
function inlineList(s: string): string[] {
  const inner = s.trim().replace(/^\[/, '').replace(/\]\s*$/, '')
  const out: string[] = []
  let cur = ''
  let q = ''
  let depth = 0
  for (const ch of inner) {
    if (q) {
      if (ch === q) q = ''
      else cur += ch
    } else if (ch === '"' || ch === "'") q = ch
    else if (ch === '{') {
      depth++
      cur += ch
    } else if (ch === '}' && depth > 0) {
      depth--
      cur += ch
    } else if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out.filter((x) => x !== '')
}
export function parseFrontmatter(text: string): Frontmatter | undefined {
  const lines = splitLines(text)
  if (lines[0]?.trim() !== '---') return undefined
  const close = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'))
  if (close < 0) return undefined
  const data: Record<string, string | string[]> = {}
  for (let i = 1; i < close; i++) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i] as string)
    if (!m) continue
    const key = m[1] as string
    let val = (m[2] as string).trim()
    if (val.startsWith('[')) {
      while (!val.includes(']') && i + 1 < close) val += ` ${(lines[++i] as string).trim()}`
      data[key] = inlineList(val)
    } else if (val === '' || val === '|' || val === '>') {
      const items: string[] = []
      const block: string[] = []
      while (i + 1 < close && (/^\s/.test(lines[i + 1] as string) || /^-\s/.test(lines[i + 1] as string))) {
        const l = lines[++i] as string
        const li = /^\s*-\s+(.*)$/.exec(l)
        if (li) items.push(unquote(li[1] as string))
        else block.push(l.trim())
      }
      data[key] = val === '' && items.length > 0 ? items : val === '' ? '' : block.join(' ')
    } else data[key] = unquote(val)
  }
  return { data, end: close + 1 }
}
export const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x !== '') : typeof v === 'string' && v !== '' ? [v] : [])

// ==== trees ====
// What a lint reads: the file names and their text, at HEAD (the working tree's tracked files) or at a base commit.
export type Tree = { files: string[]; read(p: string): string | undefined }

function git(cwd: string, args: string[]): { status: number; out: string } {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 })
  if (r.error) throw new Error(`git failed to run: ${r.error.message}`)
  return { status: r.status ?? 1, out: r.stdout ?? '' }
}
const nameLines = (out: string): string[] => out.split('\n').map((l) => flat(l.replace(/\r$/, ''))).filter((l) => l !== '')

export function headTree(repo: string): Tree {
  const r = git(repo, ['ls-files'])
  if (r.status !== 0) throw new Error(`git ls-files failed in ${repo}`)
  const files = nameLines(r.out).filter((p) => existsSync(`${repo}/${p}`))
  return { files, read: (p) => { try { return readFileSync(`${repo}/${p}`, 'utf8') } catch { return undefined } } }
}
export function baseTree(repo: string, base: string): Tree {
  const r = git(repo, ['ls-tree', '-r', '--name-only', base])
  if (r.status !== 0) throw new Error(`git ls-tree ${base} failed in ${repo}`)
  return { files: nameLines(r.out), read: (p) => { const s = git(repo, ['show', `${base}:${p}`]); return s.status === 0 ? s.out : undefined } }
}

// ==== text helpers ====
export function countLines(text: string): number {
  const l = splitLines(text)
  if (l.length > 0 && l[l.length - 1] === '') l.pop()
  return l.length
}
const isTrackedSource = (src: string, files: string[], set: Set<string>): boolean => {
  const s = flat(src).replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  if (s === '') return false
  if (hasWild(s)) { const re = globToRegExp(s); return files.some((f) => re.test(f)) }
  return set.has(s) || files.some((f) => f.startsWith(`${s}/`))
}
const sourceTouches = (src: string, file: string): boolean => {
  const s = flat(src).replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  return s !== '' && (hasWild(s) ? globToRegExp(s).test(file) : file === s || file.startsWith(`${s}/`))
}
// The code paths a feature map names: backticked tokens with a `/` and a file extension, no space and no placeholder characters.
export function featurePaths(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    let t = flat(m[1] as string).replace(/^(\.\/)+/, '')
    if (!t.includes('/') || !/\.[A-Za-z0-9]{1,8}$/.test(t) || /^[/~@]|:\/\/|[*?<>{}$[\]|]|(^|\/)\.\.(\/|$)/.test(t) || /^[A-Za-z]:/.test(t)) continue
    out.add(t)
  }
  return [...out]
}
// Every file path a markdown file points at: links, backticked tokens and @imports, as repo-relative and as relative to the file.
function linkTargets(text: string, from: string): Set<string> {
  const cands: string[] = []
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+)/g)) cands.push(m[1] as string)
  for (const m of text.matchAll(/`([^`\n]+)`/g)) cands.push((m[1] as string).trim())
  for (const m of text.matchAll(/(?:^|[\s(])@([^\s)`]+)/gm)) cands.push(m[1] as string)
  const out = new Set<string>()
  for (const c of cands) {
    let t = flat(c).replace(/[#?].*$/, '').replace(/^(\.\/)+/, '')
    if (t === '' || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) continue
    out.add(path.posix.normalize(t))
    out.add(path.posix.normalize(`${path.posix.dirname(from)}/${t}`))
  }
  return out
}
// Entries of a feature map: leaf heading sections (level 2 and deeper), or the top-level list items when the map has no such heading.
function featureEntries(text: string): { name: string; lines: number }[] {
  const lines = splitLines(text)
  const heads: { i: number; level: number; text: string }[] = []
  let fence = false
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence
    const m = !fence && /^(#{1,6})\s+(.*)$/.exec(l)
    if (m) heads.push({ i, level: (m[1] as string).length, text: (m[2] as string).trim() })
  })
  const out: { name: string; lines: number }[] = []
  const deep = heads.filter((h) => h.level >= 2)
  if (deep.length > 0) {
    heads.forEach((h, k) => {
      const next = heads[k + 1]
      if (h.level < 2 || (next !== undefined && next.level > h.level)) return
      const end = next === undefined ? lines.length : next.i
      out.push({ name: h.text, lines: lines.slice(h.i, end).filter((l) => l.trim() !== '').length })
    })
    return out
  }
  let cur: { name: string; lines: number } | undefined
  for (const l of lines) {
    const m = /^[-*+]\s+(.*)$/.exec(l)
    if (m) {
      if (cur) out.push(cur)
      cur = { name: (m[1] as string).slice(0, 60), lines: 1 }
    } else if (cur && /^\s+\S/.test(l)) cur.lines++
    else if (cur && l.trim() === '') continue
    else if (cur) { out.push(cur); cur = undefined }
  }
  if (cur) out.push(cur)
  return out
}
const standardsItems = (text: string): number => {
  const lines = splitLines(text)
  const at = lines.findIndex((l) => /^##\s+Standards\b/i.test(l))
  if (at < 0) return 0
  let n = 0
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i] as string
    if (/^#{1,2}\s/.test(l)) break
    if (/^ {0,3}([-*+]|\d+[.)])\s+\S/.test(l)) n++
  }
  return n
}

// ==== product calls in a persona ====
export type Span = { start: number; end: number }
// A heading that names a log of calls: its text starts with "Product calls", "Product decisions" or "Product call log" (an optional
// "Crew" first, emphasis allowed). A heading that only mentions them, such as "How I judge product calls", holds judging rules.
const PRODUCT_HEAD = /^(#{1,6})\s+(?:\*\*|__|\*|_)?(?:crew\s+)?product\s+(?:calls?|decisions?)(?:\s+log)?(?![\w-])/i
const LOOSE_CALL = [
  /^ {0,3}[-*+]\s+(?:\*\*)?(?:question|q)(?:\*\*)?\s*[:.]/i,
  /^ {0,3}[-*+]\s+(?:\*\*)?product call\b/i,
  /^ {0,3}[-*+]\s+.*(?:->|→).*\((?:decided by|overruled by)[^)]*\)/i,
]
const LIST_ITEM = /^( {0,3})([-*+]|\d+[.)])\s+\S/
// Where a persona's body holds product-call entries (the format the 0.23.0 knowledge writer used: a "Product calls" section of list
// items or sub-headings, or loose list items that open with a question or end with who decided). `from` is the first body line.
export function callSpans(lines: string[], from: number, pointer?: string): { entries: Span[]; sections: Span[] } {
  const entries: Span[] = []
  const sections: Span[] = []
  const covered = new Set<number>()
  const headLevel = (l: string): number => { const m = /^(#{1,6})\s/.exec(l); return m ? (m[1] as string).length : 0 }
  const itemEnd = (k: number, limit: number): number => {
    let m = k + 1
    while (m < limit && lines[m]!.trim() !== '' && /^\s{2,}\S|^\t/.test(lines[m]!) && !LIST_ITEM.test(lines[m]!)) m++
    return m
  }
  let fence = false
  for (let i = from; i < lines.length; i++) {
    const l = lines[i] as string
    if (/^\s*(```|~~~)/.test(l)) fence = !fence
    if (fence || covered.has(i)) continue
    const pm = PRODUCT_HEAD.exec(l)
    if (!pm) continue
    const level = (pm[1] as string).length
    let j = i + 1
    while (j < lines.length && !(headLevel(lines[j] as string) > 0 && headLevel(lines[j] as string) <= level)) j++
    sections.push({ start: i, end: j })
    for (let k = i; k < j; k++) covered.add(k)
    for (let k = i + 1; k < j; ) {
      const lv = headLevel(lines[k] as string)
      if (lv > 0) {
        let e = k + 1
        while (e < j && !(headLevel(lines[e] as string) > 0 && headLevel(lines[e] as string) <= lv)) e++
        entries.push({ start: k, end: e })
        k = e
      } else if (LIST_ITEM.test(lines[k] as string)) {
        const e = itemEnd(k, j)
        entries.push({ start: k, end: e })
        k = e
      } else k++
    }
  }
  fence = false
  for (let i = from; i < lines.length; i++) {
    const l = lines[i] as string
    if (/^\s*(```|~~~)/.test(l)) fence = !fence
    if (fence || covered.has(i) || !LOOSE_CALL.some((re) => re.test(l))) continue
    const e = itemEnd(i, lines.length)
    entries.push({ start: i, end: e })
    for (let k = i; k < e; k++) covered.add(k)
  }
  // an entry that already points at the productDecisions file is the pointer line, not a call
  const kept = entries.filter((e) => pointer === undefined || !lines.slice(e.start, e.end).join('\n').includes(pointer))
  kept.sort((a, b) => a.start - b.start)
  return { entries: kept, sections }
}
const PERSONA = /^\.claude\/agents\/[^/]+\.md$/
const personaFiles = (files: string[]): string[] => files.filter((f) => PERSONA.test(f)).sort()
// The other files Claude Code loads into every prompt: CLAUDE.md, CLAUDE.local.md and AGENTS.md at any depth (case folded: a
// macOS or Windows file system opens `claude.md` for `CLAUDE.md`) and the agents index. Personas are checked on their own.
const ALWAYS_LOADED = /(?:^|\/)(?:CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md)$/i
const alwaysLoadedFiles = (files: string[], agentsIndex: string): string[] => files.filter((f) => !PERSONA.test(f) && (ALWAYS_LOADED.test(f) || f === agentsIndex)).sort()
const bodyFrom = (text: string): number => parseFrontmatter(text)?.end ?? 0

// ==== lint ====
// `subjects` say what a finding is about beyond its file: the dead glob or missing path, the budget kind, the normalised call
// texts. A finding is new when one of its subjects did not fail the same check on the same path at the base. `stale` has none:
// it is computed against the base already.
type Raw = { severity: 'failure' | 'warning'; check: string; path: string; message: string; subjects?: string[] }
const callKey = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()

function structural(tree: Tree, cfg: KCfg): Raw[] {
  const out: Raw[] = []
  const add = (severity: Raw['severity'], check: string, p: string, message: string, subjects: string[] = ['']): void => { out.push({ severity, check, path: p, message, subjects }) }
  const files = tree.files
  const set = new Set(files)
  const under = (dir: string): string[] => files.filter((f) => f.startsWith(`${dir}/`) && f.toLowerCase().endsWith('.md')).sort()
  const rules = under(cfg.rulesDir)
  const docs = under(cfg.knowledgeDir).filter((f) => !rules.includes(f))
  const personas = personaFiles(files)
  const text = (p: string): string => tree.read(p) ?? ''
  const exists = (p: string): boolean => set.has(p)

  for (const f of [...rules, ...docs]) {
    const fm = parseFrontmatter(text(f))
    if (!fm) continue
    if (rules.includes(f)) {
      for (const g of asList(fm.data.paths)) {
        const bad = globError(g)
        if (bad !== undefined) { add('failure', 'bad-glob', f, `paths glob "${g}" is invalid: ${bad}; split it into fewer, simpler globs`, [g]); continue }
        const re = globToRegExp(g)
        if (!files.some((x) => re.test(x))) add('failure', 'dead-glob', f, `paths glob "${g}" matches no tracked file: fix or remove it`, [g])
      }
    }
    for (const s of asList(fm.data.sources)) {
      const bad = globError(s)
      if (bad !== undefined) add('failure', 'bad-glob', f, `sources glob "${s}" is invalid: ${bad}; split it into fewer, simpler globs`, [s])
      else if (!isTrackedSource(s, files, set)) add('failure', 'missing-source', f, `sources path "${s}" is not tracked: fix it or drop the fact it backs`, [s])
    }
  }

  let mapText: string | undefined
  if (exists(cfg.featureMap)) {
    mapText = text(cfg.featureMap)
    for (const t of featurePaths(mapText)) if (!isTrackedSource(t, files, set)) add('failure', 'missing-source', cfg.featureMap, `the feature map names code path "${t}", which is not tracked: fix or drop the entry`, [t])
    for (const e of featureEntries(mapText)) {
      if (e.lines > cfg.budgets.featureEntry) add('warning', 'over-budget', cfg.featureMap, `feature entry "${e.name}" is ${e.lines} lines, budget ${cfg.budgets.featureEntry}: point to a doc in ${cfg.knowledgeDir}/ instead of listing details`, [`featureEntry:${e.name}`])
    }
  }

  // a knowledge doc or a rule file is reachable when the feature map or the agents index links it (ADR-0035 C); rule files are
  // checked only when the project has an agents index
  const indexText = exists(cfg.agentsIndex) ? text(cfg.agentsIndex) : undefined
  const linked = new Set<string>([...(mapText === undefined ? [] : linkTargets(mapText, cfg.featureMap)), ...(indexText === undefined ? [] : linkTargets(indexText, cfg.agentsIndex))])
  for (const d of docs) if (!linked.has(d)) add('failure', 'unreachable', d, `no link to it from ${cfg.featureMap} or ${cfg.agentsIndex}: add a markdown link or a backticked path`)
  if (indexText !== undefined) for (const r of rules) if (!linked.has(r)) add('failure', 'unreachable', r, `rule file is not linked from ${cfg.agentsIndex} or ${cfg.featureMap}: add a pointer line for it`)

  if (indexText !== undefined) {
    const n = countLines(indexText)
    if (n > cfg.budgets.agentsIndex) add('failure', 'over-budget', cfg.agentsIndex, `${n} lines, budget ${cfg.budgets.agentsIndex}: keep pointers only and move detail to ${cfg.knowledgeDir}/<topic>.md`, ['agentsIndex'])
  }
  for (const p of personas) {
    const t = text(p)
    const n = countLines(t)
    if (n > cfg.budgets.persona) add('failure', 'over-budget', p, `${n} lines, budget ${cfg.budgets.persona}: move area rules to ${cfg.rulesDir}/<area>.md`, ['persona'])
    const s = standardsItems(t)
    if (s > cfg.budgets.personaStandards) add('failure', 'over-budget', p, `${s} Standards items, budget ${cfg.budgets.personaStandards}: fold entries into fewer cross-cutting rules and move area rules to ${cfg.rulesDir}/<area>.md`, ['personaStandards'])
    const pl = splitLines(t)
    const calls = callSpans(pl, bodyFrom(t), cfg.productDecisions).entries.map((e) => callKey(pl.slice(e.start, e.end).join('\n')))
    if (calls.length > 0) add('failure', 'persona-calls', p, `${calls.length} product-call entr${calls.length === 1 ? 'y' : 'ies'} in the persona: run \`factory knowledge-migrate\` to move them to ${cfg.productDecisions}`, calls)
  }
  for (const p of alwaysLoadedFiles(files, cfg.agentsIndex)) {
    const t = text(p)
    const pl = splitLines(t)
    const calls = callSpans(pl, bodyFrom(t), cfg.productDecisions).entries.map((e) => callKey(pl.slice(e.start, e.end).join('\n')))
    if (calls.length > 0) add('failure', 'always-loaded-calls', p, `${calls.length} product-call entr${calls.length === 1 ? 'y' : 'ies'} in an always-loaded file: run \`factory knowledge-migrate\` to move them to ${cfg.productDecisions}`, calls)
  }
  for (const r of rules) {
    const n = countLines(text(r))
    if (n > cfg.budgets.rule) add('failure', 'over-budget', r, `${n} lines, budget ${cfg.budgets.rule}: split by area or fold entries into fewer rules`, ['rule'])
  }
  for (const d of docs) {
    const n = countLines(text(d))
    if (n > cfg.budgets.doc) add('warning', 'over-budget', d, `${n} lines, budget ${cfg.budgets.doc}: fold entries into fewer, or split the topic`, ['doc'])
  }
  return out
}

// Docs (rules and knowledge docs) that carry sources: [{path, sources, verified}].
function sourcedDocs(tree: Tree, cfg: KCfg): { path: string; sources: string[]; verified: string | undefined }[] {
  const out: { path: string; sources: string[]; verified: string | undefined }[] = []
  for (const f of tree.files.filter((x) => (x.startsWith(`${cfg.rulesDir}/`) || x.startsWith(`${cfg.knowledgeDir}/`)) && x.toLowerCase().endsWith('.md')).sort()) {
    const fm = parseFrontmatter(tree.read(f) ?? '')
    const sources = fm ? asList(fm.data.sources) : []
    if (!fm || sources.length === 0) continue
    out.push({ path: f, sources, verified: typeof fm.data.verified === 'string' && fm.data.verified !== '' ? fm.data.verified : undefined })
  }
  return out
}

function staleRaw(repo: string, head: Tree, cfg: KCfg, base: string | undefined): Raw[] {
  const out: Raw[] = []
  const docs = sourcedDocs(head, cfg)
  if (base !== undefined) {
    const d = git(repo, ['diff', '--name-only', `${base}..HEAD`])
    if (d.status !== 0) throw new Error(`git diff ${base}..HEAD failed`)
    const changed = nameLines(d.out)
    const bt = baseTree(repo, base)
    for (const doc of docs) {
      const touched = changed.filter((c) => c !== doc.path && doc.sources.some((s) => sourceTouches(s, c)))
      if (touched.length === 0) continue
      const was = bt.read(doc.path)
      if (was === undefined) continue
      const fmWas = parseFrontmatter(was)
      const vWas = fmWas && typeof fmWas.data.verified === 'string' && fmWas.data.verified !== '' ? fmWas.data.verified : undefined
      if (vWas === doc.verified) out.push({ severity: 'failure', check: 'stale', path: doc.path, message: `${touched[0]}${touched.length > 1 ? ` and ${touched.length - 1} more source file(s)` : ''} changed in this diff but \`verified\` did not: re-check the doc and set \`verified\` to the head` })
    }
    return out
  }
  for (const doc of docs) {
    if (doc.verified === undefined) { out.push({ severity: 'warning', check: 'stale', path: doc.path, message: 'sources are set but `verified` is not: set it to the sha the doc was last checked at' }); continue }
    const ok = /^[0-9a-f]{4,40}$/i.test(doc.verified) && git(repo, ['rev-parse', '--verify', '--quiet', `${doc.verified}^{commit}`]).status === 0
    if (!ok) { out.push({ severity: 'warning', check: 'stale', path: doc.path, message: `\`verified\` ${doc.verified} is not a known commit: re-check the doc and set it to the head` }); continue }
    // git pathspecs have no braces, so a brace source is passed as its expansions; an invalid glob has none (it is a bad-glob
    // failure), and with no pathspec left `git log` would count every commit, so the doc is skipped
    const specs = doc.sources.flatMap((s) => expandBraces(flat(s).replace(/^(\.\/)+/, '').replace(/\/+$/, ''))).map((s) => `:(${/[*?]/.test(s) ? 'glob' : 'literal'})${s}`)
    if (specs.length === 0) continue
    const r = git(repo, ['log', '--format=%H', `${doc.verified}..HEAD`, '--', ...specs])
    const n = nameLines(r.out).length
    if (r.status === 0 && n > 0) out.push({ severity: 'warning', check: 'stale', path: doc.path, message: `${n} commit(s) touched its sources since \`verified\` ${doc.verified.slice(0, 12)}: re-check the doc and set \`verified\` to the head` })
  }
  return out
}

// How many predating (new: false) failures, and how many predating warnings, the output lists; predatingCount and warningCount
// carry the true totals.
export const LIST_CAP = 20
export function lint(repo: string, cfg: KCfg, base?: string): LintResult {
  const head = headTree(repo)
  const raw = [...structural(head, cfg), ...staleRaw(repo, head, cfg, base)]
  const keys = (r: Raw): string[] => (r.subjects ?? ['']).map((s) => `${r.check}\0${r.path}\0${s}`)
  const atBase = new Set<string>(base === undefined ? [] : structural(baseTree(repo, base), cfg).flatMap(keys))
  const fin = (r: Raw): Finding => ({ check: r.check, path: r.path, message: r.message, new: base === undefined || r.check === 'stale' || keys(r).some((k) => !atBase.has(k)) })
  const order = (a: Finding, b: Finding): number => (a.check < b.check ? -1 : a.check > b.check ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : a.message < b.message ? -1 : a.message > b.message ? 1 : 0)
  const failures = raw.filter((r) => r.severity === 'failure').map(fin).sort(order)
  const warnings = raw.filter((r) => r.severity === 'warning').map(fin).sort(order)
  // every new failure and every new warning in full; the predating ones capped at LIST_CAP each, in the same order
  const capped = (list: Finding[]): Finding[] => {
    let kept = 0
    return list.filter((f) => f.new || kept++ < LIST_CAP)
  }
  return { ok: failures.length === 0, failures: capped(failures), warnings: capped(warnings), predatingCount: failures.filter((f) => !f.new).length, warningCount: warnings.length }
}

// ==== rules-index ====
// Tracked rule files only: an untracked file in the checkout is not in any crew's worktree.
export function rulesIndex(repo: string, cfg: KCfg): { rules: { path: string; paths: string[] }[] } {
  const r = git(repo, ['ls-files', '--cached'])
  if (r.status !== 0) throw new Error(`git ls-files failed in ${repo}`)
  const names = [...new Set(nameLines(r.out))].filter((f) => f.startsWith(`${cfg.rulesDir}/`) && f.toLowerCase().endsWith('.md') && existsSync(`${repo}/${f}`)).sort()
  return { rules: names.map((p) => { const fm = parseFrontmatter(readFileSync(`${repo}/${p}`, 'utf8')); return { path: p, paths: fm ? asList(fm.data.paths) : [] } }) }
}

// ==== migrate ====
export type Move = { from: string; to: string; entries: string[] }
// Moves the product-call entries out of every persona and every other always-loaded file (CLAUDE.md, CLAUDE.local.md, AGENTS.md,
// the agents index) into the productDecisions file, leaving one pointer line in each. Without `apply` nothing is written.
export function migrate(repo: string, cfg: KCfg, apply: boolean): { moves: Move[]; applied: boolean; notes: string[] } {
  const r = git(repo, ['ls-files', '--cached', '--others', '--exclude-standard'])
  if (r.status !== 0) throw new Error(`git ls-files failed in ${repo}`)
  const files = [...new Set(nameLines(r.out))].filter((f) => existsSync(`${repo}/${f}`))
  const moves: Move[] = []
  const writes: { path: string; text: string }[] = []
  const pointer = `Product calls are recorded in \`${cfg.productDecisions}\`.`
  for (const p of [...personaFiles(files), ...alwaysLoadedFiles(files, cfg.agentsIndex)]) {
    const raw = readFileSync(`${repo}/${p}`, 'utf8')
    const eol = raw.includes('\r\n') ? '\r\n' : '\n'
    const lines = splitLines(raw)
    const { entries, sections } = callSpans(lines, bodyFrom(raw), cfg.productDecisions)
    if (entries.length === 0) continue
    const texts = entries.map((e) => lines.slice(e.start, e.end).join('\n').replace(/\s+$/, ''))
    const remove = new Set<number>()
    for (const e of entries) for (let k = e.start; k < e.end; k++) remove.add(k)
    for (const s of sections) {
      const left = lines.slice(s.start + 1, s.end).filter((_, k) => !remove.has(s.start + 1 + k) && lines[s.start + 1 + k]!.trim() !== '')
      if (left.length === 0) for (let k = s.start; k < s.end; k++) remove.add(k)
    }
    // a blank line before a removed block goes with it when the block is followed by a blank line or the end
    for (const k of [...remove].sort((a, b) => a - b)) {
      if (!remove.has(k - 1) && k > 0 && lines[k - 1]!.trim() === '' && !remove.has(k - 1)) {
        let e = k
        while (remove.has(e)) e++
        if (e >= lines.length || lines[e]!.trim() === '') remove.add(k - 1)
      }
    }
    const kept = lines.filter((_, k) => !remove.has(k))
    while (kept.length > 0 && kept[kept.length - 1]!.trim() === '') kept.pop()
    if (!raw.includes(cfg.productDecisions)) kept.push('', pointer)
    writes.push({ path: p, text: kept.join(eol) + eol })
    moves.push({ from: p, to: cfg.productDecisions, entries: texts })
  }
  if (moves.length > 0) {
    const target = `${repo}/${cfg.productDecisions}`
    let cur = existsSync(target) ? readFileSync(target, 'utf8') : `# Product decisions\n\nThe crew product calls, newest last. Moved out of the always-loaded files by \`factory knowledge-migrate\`.\n`
    const eol = cur.includes('\r\n') ? '\r\n' : '\n'
    for (const m of moves) for (const e of m.entries) if (!cur.includes(e)) cur = `${cur.replace(/\s+$/, '')}${eol}${eol}${e.replace(/\n/g, eol)}${eol}`
    writes.push({ path: cfg.productDecisions, text: cur })
  }
  if (apply) {
    for (const w of writes) {
      mkdirSync(path.dirname(`${repo}/${w.path}`), { recursive: true })
      writeFileSync(`${repo}/${w.path}`, w.text)
    }
  }
  const notes = moves.length > 0 ? [`link ${cfg.productDecisions} from ${cfg.agentsIndex} or ${cfg.featureMap} so the lint finds it reachable`] : []
  return { moves, applied: apply, notes }
}
