// stage.js module: rule-file globs (a copy of bin/knowledge.ts's dialect) and rulesFor. Edit here, then run `npm run build:stage`.
// rule globs: begin
// ADR-0035: the glob dialect of a rule file's `paths`, as bin/knowledge.ts globToRegExp. Paths are `/`-separated (a `\` is a `/`, in
// the glob and in the path) and anchored at the repo root; a leading `./` or `/` is dropped and a trailing `/` means everything below.
// `*` is any run of characters but `/`, `?` one code point but `/`. A double star is special only as a whole segment: any number of
// segments in the middle (so `a/` double star `/b` also matches `a/b`), at least one more segment at the end; inside a segment it is
// two stars. `{a,b,c}` is alternation, each alternative a literal or a glob, with no nesting; an alternative may be empty only as
// `{,x}`, and an unbalanced or malformed brace group is literal. No negation; a dot and `[` are literal. This copy must pass
// tests/fixtures/glob-vectors.json with the factory's matcher (stage.js is a workflow script and cannot import factory code).
const flatPath = (p) => String(p).replace(/\\/g, '/')
// the brace expansion of a glob: one glob per alternative (the glob itself when it has no valid brace group). A glob with more than
// MAX_BRACE_GROUPS groups, or whose expansion would pass MAX_BRACE_ALTS alternatives, is invalid: null, counted before expanding.
const MAX_BRACE_GROUPS = 8
const MAX_BRACE_ALTS = 256
function braceAlternatives(glob) {
  const parts = [['']]
  let count = 1
  let lit = ''
  let i = 0
  while (i < glob.length) {
    const close = glob[i] === '{' ? glob.indexOf('}', i + 1) : -1
    const inner = close > i ? glob.slice(i + 1, close) : null
    const alts = inner !== null && !inner.includes('{') ? inner.split(',') : null
    const valid = alts && alts.length >= 2 && (alts.every((a) => a !== '') || (alts.length === 2 && alts[0] === '' && alts[1] !== ''))
    if (!valid) {
      lit += glob[i]
      i++
      continue
    }
    parts.push([lit], alts)
    count *= alts.length
    if ((parts.length - 1) / 2 > MAX_BRACE_GROUPS || count > MAX_BRACE_ALTS) return null
    lit = ''
    i = close + 1
  }
  parts.push([lit])
  return parts.reduce((acc, alts) => acc.flatMap((a) => alts.map((b) => a + b)), [''])
}
// the regular expression body of one brace-free glob
function globBody(glob) {
  const g = glob.replace(/^(\.\/)+/, '').replace(/^\/+/, '')
  const segs = g.split('/').filter((s) => s !== '')
  if (g.endsWith('/')) segs.push('**')
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
const globRegExpCache = new Map()
function ruleGlobRegExp(glob) {
  if (globRegExpCache.has(glob)) return globRegExpCache.get(glob)
  const alts = braceAlternatives(flatPath(glob))
  const re = alts ? new RegExp(`^(?:${alts.map(globBody).join('|')})$`, 'u') : /(?!)/u // an invalid glob matches nothing
  globRegExpCache.set(glob, re)
  return re
}
const hasWildcard = (p) => /[*?]/.test(p)
function globMatches(glob, path) {
  return typeof glob === 'string' && typeof path === 'string' && ruleGlobRegExp(glob).test(flatPath(path))
}
// the directory part of a glob before its first wildcard segment ('src/ui' for a glob that goes on with a double star), and its literal extension, if any
const staticDirs = (g) => {
  const parts = g.split('/')
  const out = []
  for (const part of parts.slice(0, -1)) {
    if (hasWildcard(part)) break
    out.push(part)
  }
  return out
}
const literalExt = (g) => {
  const last = g.slice(g.lastIndexOf('/') + 1)
  const m = /\.([A-Za-z0-9]+)$/.exec(last)
  return m && !hasWildcard(m[1]) ? m[1] : null
}
// a glob or path without its leading `./` or `/` (the caller turns `\` into `/` first)
const plainGlob = (g) => g.replace(/^(\.\/)+/, '').replace(/^\/+/, '')
// a task file that is itself a glob overlaps a rule glob when, for some pair of their brace alternatives, the literal directory
// prefixes nest and the extensions do not differ
function globsOverlap(taskGlob, ruleGlob) {
  const one = (t, r) => {
    const a = staticDirs(t)
    const b = staticDirs(r)
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false
    const ea = literalExt(t)
    const eb = literalExt(r)
    return !(ea && eb && ea !== eb)
  }
  // each side is at most MAX_BRACE_ALTS alternatives, so the pairs stay at 256 x 256; an invalid glob on either side overlaps nothing
  const ra = braceAlternatives(flatPath(ruleGlob))
  const ta = braceAlternatives(flatPath(taskGlob))
  if (!ra || !ta) return false
  const rs = ra.map(plainGlob)
  return ta.map(plainGlob).some((t) => rs.some((r) => one(t, r)))
}
const isGlob = (f) => hasWildcard(f) || (braceAlternatives(f) || []).length !== 1
// the rule files (repo-relative paths) whose `paths` globs match any of the task's files, in rule order, once each. A planner's
// task file may carry `\` separators: it is matched as `/`.
function rulesFor(rules, files) {
  if (!Array.isArray(rules)) return []
  const fs = (files || []).filter((f) => typeof f === 'string' && f).map(flatPath)
  const out = []
  for (const r of rules) {
    if (!r || typeof r.path !== 'string' || !r.path || !Array.isArray(r.paths) || out.includes(r.path)) continue
    const hit = r.paths.some((g) => typeof g === 'string' && g && fs.some((f) => (isGlob(f) ? globsOverlap(f, g) : globMatches(g, f))))
    if (hit) out.push(r.path)
  }
  return out
}
// rule globs: end
