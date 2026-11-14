// `factory consolidate` (0.32.0 item 3, R-131): owns the between-wave memory consolidation. It reads the feature map, the knowledge
// docs and the architecture doc, decides in code (never through an agent) what to merge, flag, prune and re-point, and writes ONE
// reviewable unified diff plus its record under the truss dir. It changes no tracked file until `--accept`, which applies the
// diff and commits it once; `--reject` drops the proposal. Never imports factory.ts, whose top-level await would make an import cycle.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { configOf, flat, isObj, refuse, repoPathOf, usage } from '../core.ts'
import type { Flags, Obj } from '../core.ts'
import { withLock, writeJsonAtomic } from '../lock.ts'
import { featurePaths, headTree } from '../knowledge.ts'
import type { Tree } from '../knowledge.ts'
import { dirOf, repoOf, run } from './cli.ts'
import { knowledgeCfgOf } from './settings.ts'

type Row = { kind: 'merge' | 'flag' | 'prune' | 'repoint'; doc: string; reason: string }
type Sec = { start: number; end: number; level: number; title: string }

const COMMIT_SUBJECT = 'docs: consolidate knowledge'
const CODE_EXT = 'ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|cs'

// ==== markdown structure ====

// The heading sections of a doc as line ranges [start, end): a section runs to the next heading of the same or a higher level.
// Headings inside a fenced block do not count. The final empty element of a text that ends with a newline is not part of any section.
function sectionsOf(lines: string[]): Sec[] {
  const lastEnd = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
  const heads: { i: number; level: number; title: string }[] = []
  let fence = false
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence
    const m = !fence && /^(#{1,6})\s+(.*?)\s*$/.exec(l)
    if (m) heads.push({ i, level: (m[1] as string).length, title: m[2] as string })
  })
  return heads.map((h, k) => {
    let end = lastEnd
    for (let j = k + 1; j < heads.length; j++) if ((heads[j] as { level: number }).level <= h.level) { end = (heads[j] as { i: number }).i; break }
    return { start: h.i, end, level: h.level, title: h.title }
  })
}
// Line indexes outside a fenced block (a citation inside an example is not a citation).
function proseLines(lines: string[]): number[] {
  const out: number[] = []
  let fence = false
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence
    else if (!fence) out.push(i)
  })
  return out
}
const trailingBlanks = (lines: string[], from: number, to: number): number => {
  let n = 0
  while (to - 1 - n >= from && (lines[to - 1 - n] as string).trim() === '') n++
  return n
}
const titleKey = (t: string): string => t.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').replace(/[\s.:]+$/, '').trim()
// A pass never leaves more empty lines at the end of a doc than the doc had.
function keepEnding(before: string[], after: string[]): string[] {
  const empties = (l: string[]): number => { let n = 0; while (n < l.length && l[l.length - 1 - n] === '') n++; return n }
  const out = after.slice()
  while (empties(out) > empties(before) && out.length > 0) out.pop()
  return out
}

// ==== pass 1: duplicates by capability heading, merged into the first (feature map only) ====
function mergeDuplicates(text: string, doc: string): { text: string; rows: Row[] } {
  let lines = text.split('\n')
  const rows: Row[] = []
  for (;;) {
    const secs = sectionsOf(lines).filter((s) => s.level === 2)
    let pair: [Sec, Sec] | undefined
    for (let j = 1; j < secs.length && pair === undefined; j++) {
      const first = secs.slice(0, j).find((s) => titleKey(s.title) === titleKey((secs[j] as Sec).title))
      if (first !== undefined) pair = [first, secs[j] as Sec]
    }
    if (pair === undefined) return { text: lines.join('\n'), rows }
    const [a, b] = pair
    const aTrail = trailingBlanks(lines, a.start, a.end)
    const bTrail = trailingBlanks(lines, b.start, b.end)
    let bs = b.start + 1
    while (bs < b.end && (lines[bs] as string).trim() === '') bs++
    const bBody = lines.slice(bs, b.end - bTrail)
    const between = lines.slice(a.end, b.start)
    const merged = [...lines.slice(a.start, a.end - aTrail), '', ...bBody]
    const next = [...lines.slice(0, a.start), ...merged, ...(between.length === 0 ? Array(bTrail).fill('') : [...Array(aTrail).fill(''), ...between]), ...lines.slice(b.end)]
    lines = keepEnding(lines, next)
    rows.push({ kind: 'merge', doc, reason: `the entry "${b.title}" repeats "${a.title}": its content is merged into the first entry` })
  }
}

// ==== pass 2: prune an entry whose entry paths no longer exist (feature map only) ====
function pruneUnsupported(text: string, doc: string, tree: Tree, repo: string): { text: string; rows: Row[] } {
  const lines = text.split('\n')
  const secs = sectionsOf(lines)
  const rows: Row[] = []
  const cut: { s: Sec; note: string }[] = []
  for (const s of secs) {
    if (s.level < 2 || secs.filter((o) => o.start >= s.start && o.start < s.end).length !== 1) continue
    const paths = featurePaths(lines.slice(s.start + 1, s.end).join('\n'))
    if (paths.length === 0 || paths.some((p) => tree.files.includes(p) || existsSync(`${repo}/${p}`))) continue
    const note = `<!-- consolidate: removed the entry "${s.title}" because none of its entry paths exist any more (${paths.join(', ')}) -->`
    cut.push({ s, note })
    rows.push({ kind: 'prune', doc, reason: `the entry "${s.title}" names only paths that no longer exist: ${paths.join(', ')}` })
  }
  if (cut.length === 0) return { text, rows }
  let out = lines.slice()
  for (const { s, note } of cut.reverse()) {
    const trail = trailingBlanks(lines, s.start, s.end)
    out = [...out.slice(0, s.start), note, ...out.slice(s.end - trail)]
  }
  return { text: keepEnding(lines, out).join('\n'), rows }
}

// ==== code reading: symbols ====
const DECLS: RegExp[] = [
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let|var|abstract\s+class|namespace)\s+([A-Za-z_$][\w$]*)/,
  /^(?:async\s+)?(?:def|class)\s+(\w+)/,
  /^func\s+(?:\([^)]*\)\s*)?(\w+)/,
  /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl)\s+(\w+)/,
]
const declAt = (line: string): string | undefined => {
  for (const re of DECLS) {
    const m = re.exec(line)
    if (m) return m[1]
  }
  return undefined
}
// The top-level symbol whose body holds 1-based line `n`, or undefined when n falls between declarations.
export function enclosingSymbol(text: string, n: number): string | undefined {
  const lines = text.split('\n')
  let at = -1
  for (let i = Math.min(n, lines.length) - 1; i >= 0; i--) if (declAt(lines[i] as string) !== undefined) { at = i; break }
  if (at < 0) return undefined
  let next = lines.length
  for (let i = at + 1; i < lines.length; i++) if (declAt(lines[i] as string) !== undefined) { next = i; break }
  let end = next - 1
  for (let i = at + 1; i < next; i++) if (/^[}\])]/.test(lines[i] as string)) { end = i; break }
  while (end > at && /^\s*(?:$|\/\/|#|\/\*|\*|@)/.test(lines[end] as string) && !/^[}\])]/.test(lines[end] as string)) end--
  return n - 1 <= end ? declAt(lines[at] as string) : undefined
}
const MODS = '(?:(?:public|private|protected|static|async|readonly|get|set|override|abstract)\\s+)*'
// True when the code declares `sym` (a dotted `Class.method` is judged by its last part). A call alone is not a declaration.
export function declares(text: string, sym: string): boolean {
  const last = sym.split('.').pop() as string
  const e = last.replace(/[$]/g, '\\$')
  const forms = [
    `\\b(?:function\\*?|class|interface|type|enum|namespace|const|let|var|def|fn|func|struct|trait|object|val)\\s+\\*?${e}(?![\\w$])`,
    `^\\s*(?:export\\s+)?${MODS}\\*?${e}\\s*(?:<[^>]*>)?\\([^)]*\\)\\s*(?::[^={]*)?\\{\\s*$`,
    `^\\s*${MODS}${e}\\s*[:=]`,
    `export\\s*\\{[^}]*(?<![\\w$])${e}(?![\\w$])`,
    `\\bas\\s+${e}(?![\\w$])`,
  ]
  return forms.some((f) => new RegExp(f, 'm').test(text))
}
const fileText = (tree: Tree, doc: string, rel: string): string | undefined => {
  const p = flat(rel).replace(/^(\.\/)+/, '')
  return tree.read(p) ?? tree.read(path.posix.normalize(`${path.posix.dirname(doc)}/${p}`))
}

// ==== pass 3: a line citation re-pointed to the enclosing top-level symbol ====
const LINE_CITE = new RegExp(`(?<![\\w./-])(\`?)((?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\\.(?:${CODE_EXT})):(\\d+)(?:[-–]\\d+)?(\`?)`, 'g')
function repointLines(text: string, doc: string, tree: Tree): { text: string; rows: Row[] } {
  const lines = text.split('\n')
  const rows: Row[] = []
  for (const i of proseLines(lines)) {
    lines[i] = (lines[i] as string).replace(LINE_CITE, (whole, open: string, file: string, n: string, close: string) => {
      if (open !== close) return whole
      const code = fileText(tree, doc, file)
      const sym = code === undefined ? undefined : enclosingSymbol(code, Number(n))
      if (sym === undefined) return whole
      rows.push({ kind: 'repoint', doc, reason: `the line citation ${file}:${n} is inside the top-level symbol ${sym}` })
      return `\`${file}\` \`${sym}\``
    })
  }
  return { text: lines.join('\n'), rows }
}

// ==== pass 4: a cited symbol the cited file no longer declares is flagged, never resolved ====
const SYMBOL_CITE = new RegExp(`\`([^\`\\s]+\\.(?:${CODE_EXT}))\`\\s+\`([A-Za-z_$][\\w$.]*)\``, 'g')
const flagLine = (sym: string, file: string): string => `> consolidate: the cited symbol ${sym} is no longer declared in ${file}; check this claim.`
function flagMissing(text: string, doc: string, tree: Tree): { text: string; rows: Row[] } {
  const lines = text.split('\n')
  const rows: Row[] = []
  const inserts: { after: number; line: string }[] = []
  for (const i of proseLines(lines)) {
    const flags: string[] = []
    for (const m of (lines[i] as string).matchAll(SYMBOL_CITE)) {
      const code = fileText(tree, doc, m[1] as string)
      if (code === undefined || declares(code, m[2] as string)) continue
      const line = flagLine(m[2] as string, m[1] as string)
      let after = i
      if (/^\s*\|/.test(lines[i] as string)) while (/^\s*\|/.test(lines[after + 1] ?? '')) after++
      if (lines.includes(line) || flags.includes(line)) continue
      flags.push(line)
      inserts.push({ after, line })
      rows.push({ kind: 'flag', doc, reason: `the cited symbol ${m[2]} is not declared in ${m[1]}` })
    }
  }
  if (inserts.length === 0) return { text, rows }
  const out: string[] = []
  lines.forEach((l, i) => {
    out.push(l)
    for (const ins of inserts) if (ins.after === i) out.push(ins.line)
  })
  return { text: out.join('\n'), rows }
}

// ==== the diff ====
// A unified diff of one file, three lines of context, as `git apply` reads it. The last line of a file with no final newline is
// told apart from the same text with one.
export function unifiedDiff(rel: string, before: string, after: string): string {
  const split = (t: string) => { const l = t.split('\n'); const nl = l[l.length - 1] === ''; if (nl) l.pop(); return { l, nl } }
  const A = split(before)
  const B = split(after)
  const ka = A.l.map((s, i) => (i === A.l.length - 1 && !A.nl ? `${s}\u0000` : s))
  const kb = B.l.map((s, i) => (i === B.l.length - 1 && !B.nl ? `${s}\u0000` : s))
  let pre = 0
  while (pre < ka.length && pre < kb.length && ka[pre] === kb[pre]) pre++
  let suf = 0
  while (suf < ka.length - pre && suf < kb.length - pre && ka[ka.length - 1 - suf] === kb[kb.length - 1 - suf]) suf++
  const n = ka.length - pre - suf
  const m = kb.length - pre - suf
  type Op = { t: ' ' | '-' | '+'; s: string }
  const ops: Op[] = []
  for (let i = 0; i < pre; i++) ops.push({ t: ' ', s: A.l[i] as string })
  if (n * m > 25_000_000) {
    for (let i = 0; i < n; i++) ops.push({ t: '-', s: A.l[pre + i] as string })
    for (let j = 0; j < m; j++) ops.push({ t: '+', s: B.l[pre + j] as string })
  } else {
    const w = m + 1
    const t = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = ka[pre + i] === kb[pre + j] ? (t[(i + 1) * w + j + 1] as number) + 1 : Math.max(t[(i + 1) * w + j] as number, t[i * w + j + 1] as number)
      }
    }
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && ka[pre + i] === kb[pre + j]) { ops.push({ t: ' ', s: A.l[pre + i] as string }); i++; j++ }
      else if (i < n && (j >= m || (t[(i + 1) * w + j] as number) >= (t[i * w + j + 1] as number))) { ops.push({ t: '-', s: A.l[pre + i] as string }); i++ }
      else { ops.push({ t: '+', s: B.l[pre + j] as string }); j++ }
    }
  }
  for (let i = 0; i < suf; i++) ops.push({ t: ' ', s: A.l[A.l.length - suf + i] as string })
  // line numbers of each op
  const pos = ops.map(() => ({ o: 0, n: 0 }))
  let o = 0
  let nn = 0
  ops.forEach((op, k) => {
    pos[k] = { o: o + 1, n: nn + 1 }
    if (op.t !== '+') o++
    if (op.t !== '-') nn++
  })
  const changed = ops.map((op, k) => (op.t === ' ' ? -1 : k)).filter((k) => k >= 0)
  if (changed.length === 0) return ''
  const hunks: [number, number][] = []
  for (const k of changed) {
    const lo = Math.max(0, k - 3)
    const hi = Math.min(ops.length, k + 4)
    const last = hunks[hunks.length - 1]
    if (last !== undefined && lo <= last[1]) last[1] = hi
    else hunks.push([lo, hi])
  }
  const lastOld = A.l.length
  const lastNew = B.l.length
  let out = `diff --git a/${rel} b/${rel}\n--- a/${rel}\n+++ b/${rel}\n`
  for (const [lo, hi] of hunks) {
    const slice = ops.slice(lo, hi)
    const oc = slice.filter((x) => x.t !== '+').length
    const nc = slice.filter((x) => x.t !== '-').length
    const p = pos[lo] as { o: number; n: number }
    out += `@@ -${oc === 0 ? p.o - 1 : p.o},${oc} +${nc === 0 ? p.n - 1 : p.n},${nc} @@\n`
    slice.forEach((op, q) => {
      out += `${op.t}${op.s}\n`
      const at = pos[lo + q] as { o: number; n: number }
      if (op.t !== '+' && at.o === lastOld && !A.nl) out += '\\ No newline at end of file\n'
      else if (op.t === '+' && at.n === lastNew && !B.nl) out += '\\ No newline at end of file\n'
    })
  }
  return out
}

// ==== the command ====
const fileOf = (dir: string): { patch: string; record: string } => ({ patch: `${dir}/consolidation.patch`, record: `${dir}/consolidation.json` })

function docsOf(repo: string, tree: Tree): { feature: string; docs: string[] } {
  const cfg = knowledgeCfgOf(repo)
  const arch = repoPathOf(configOf(repo).architecture) ?? 'docs/architecture.md'
  const known = tree.files.filter((p) => p.startsWith(`${cfg.knowledgeDir}/`) && p.endsWith('.md') && !p.split('/').some((s) => s.endsWith('.d'))).sort()
  const docs = [...new Set([cfg.featureMap, ...known, arch])].filter((p) => tree.files.includes(p))
  return { feature: cfg.featureMap, docs }
}

function propose(repo: string, dir: string): Obj {
  const tree = headTree(repo)
  const { feature, docs } = docsOf(repo, tree)
  const rows: Row[] = []
  let patch = ''
  const files: string[] = []
  for (const doc of docs) {
    const before = tree.read(doc) as string
    let text = before
    const steps: ((t: string) => { text: string; rows: Row[] })[] = []
    if (doc === feature) steps.push((t) => mergeDuplicates(t, doc), (t) => pruneUnsupported(t, doc, tree, repo))
    steps.push((t) => repointLines(t, doc, tree), (t) => flagMissing(t, doc, tree))
    for (const step of steps) {
      const r = step(text)
      text = r.text
      rows.push(...r.rows)
    }
    const d = unifiedDiff(doc, before, text)
    if (d !== '') { patch += d; files.push(doc) }
  }
  const { patch: patchFile, record } = fileOf(dir)
  if (files.length === 0) {
    rmSync(patchFile, { force: true })
    rmSync(record, { force: true })
    return { ok: true, proposed: false, changes: [], files: [] }
  }
  const tmp = `${patchFile}.tmp-${process.pid}`
  writeFileSync(tmp, patch)
  renameSync(tmp, patchFile)
  writeJsonAtomic(record, { head: run(repo, ['rev-parse', 'HEAD']).out, files, changes: rows })
  return { ok: true, proposed: true, patch: patchFile, changes: rows, files }
}

function accept(repo: string, dir: string): Obj {
  const { patch, record } = fileOf(dir)
  if (!existsSync(patch) || !existsSync(record)) throw refuse({ ok: false, why: 'no consolidation proposal in --dir to accept' })
  const rec = JSON.parse(readFileSync(record, 'utf8')) as unknown
  const files = isObj(rec) && Array.isArray(rec.files) ? rec.files.filter((x): x is string => typeof x === 'string') : []
  if (files.length === 0) throw refuse({ ok: false, why: 'the consolidation proposal names no file' })
  const dirty = run(repo, ['-c', 'core.quotepath=off', 'status', '--porcelain', '--', ...files]).out.split('\n').filter((l) => l.trim() !== '')
  if (dirty.length > 0) throw refuse({ ok: false, why: 'commit or discard the changes to these docs first', dirty })
  const check = run(repo, ['apply', '--check', patch])
  if (check.status !== 0) throw refuse({ ok: false, why: `the proposal no longer applies: ${check.err}. Run consolidate again` })
  const ap = run(repo, ['apply', '--index', patch])
  if (ap.status !== 0) throw usage(`git apply failed: ${ap.err}`)
  const c = run(repo, ['commit', '-m', COMMIT_SUBJECT, '--', ...files])
  if (c.status !== 0) throw usage(`git commit failed: ${c.err || c.out}`)
  rmSync(patch, { force: true })
  rmSync(record, { force: true })
  return { ok: true, accepted: true, committed: true, files, head: run(repo, ['rev-parse', 'HEAD']).out }
}

function reject(dir: string): Obj {
  const { patch, record } = fileOf(dir)
  const had = existsSync(patch) || existsSync(record)
  rmSync(patch, { force: true })
  rmSync(record, { force: true })
  return { ok: true, rejected: had }
}

// `consolidate --repo R --dir D [--accept | --reject]`: without a flag, writes D/consolidation.patch and D/consolidation.json and
// changes no tracked file. --accept applies the patch and commits `docs: consolidate knowledge` once; --reject removes the proposal.
export function cmdConsolidate(f: Flags): Obj {
  const repo = repoOf(f)
  const dir = dirOf(f)
  if (f.accept !== undefined && f.reject !== undefined) throw usage('consolidate takes --accept or --reject, not both')
  return withLock(dir, 'consolidation', () => (f.accept !== undefined ? accept(repo, dir) : f.reject !== undefined ? reject(dir) : propose(repo, dir)))
}
