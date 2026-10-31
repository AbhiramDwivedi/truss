// The retro's commit gate (ADR-0012 Seams, scrub; R-32): reports the lines of a text that hold an email address,
// a home path or a token. One hit per kind per line, in line order. Every scan walks the line with indexOf and
// bounded character runs, never a backtracking pattern, so it stays linear on large inputs.
// Erasable TypeScript only, Node standard library only (P19).

export type ScrubKind = 'email' | 'home-path' | 'token'
export type ScrubHit = { line: number; kind: ScrubKind }

const LOCAL = /[A-Za-z0-9._%+-]/
const DOMAIN = /[A-Za-z0-9.-]/
const NAME = /[A-Za-z0-9._-]/
const TOKEN_CHAR = /[A-Za-z0-9_-]/
const WORD_CHAR = /[A-Za-z0-9_]/

const TOKEN_PREFIXES = ['sk-', 'ghp_', 'gho_', 'ghs_', 'github_pat_', 'xox', 'AKIA']
const KEY_WORDS = ['token', 'secret', 'password', 'api_key', 'apikey']

// count token characters from `from`, stopping at `cap` (so a long run is never walked twice)
const run = (s: string, from: number, cap: number): number => {
  let n = 0
  while (n < cap && from + n < s.length && TOKEN_CHAR.test(s[from + n]!)) n++
  return n
}

const hasEmail = (s: string): boolean => {
  let at = s.indexOf('@')
  while (at !== -1) {
    let start = at
    while (start > 0 && LOCAL.test(s[start - 1]!)) start--
    let end = at + 1
    while (end < s.length && DOMAIN.test(s[end]!)) end++
    // a trailing dot or hyphen is sentence punctuation, not part of the domain
    while (end > at + 1 && (s[end - 1] === '.' || s[end - 1] === '-')) end--
    const local = s.slice(start, at)
    const domain = s.slice(at + 1, end).toLowerCase()
    const labels = domain.split('.')
    const shaped = local.length > 0 && labels.length >= 2 && labels.every(l => l.length > 0)
    if (shaped) {
      const allowed =
        (local === 'noreply' && domain === 'anthropic.com') || domain === 'example.com' || domain.endsWith('.invalid')
      if (!allowed) return true
    }
    at = s.indexOf('@', at + 1)
  }
  return false
}

const hasHomePath = (s: string): boolean => {
  for (const root of ['/home/', '/Users/']) {
    let i = s.indexOf(root)
    while (i !== -1) {
      let j = i + root.length
      while (j < s.length && NAME.test(s[j]!)) j++
      const name = s.slice(i + root.length, j)
      if (name.length > 0 && s[j] === '/') return true
      // the literal placeholder is the one allowed name
      if (name.length === 0 && s.startsWith('<name>/', i + root.length)) {
        i = s.indexOf(root, i + root.length)
        continue
      }
      i = s.indexOf(root, i + root.length)
    }
  }
  return false
}

const hasToken = (s: string): boolean => {
  for (const p of TOKEN_PREFIXES) {
    let i = s.indexOf(p)
    while (i !== -1) {
      const wordStart = i === 0 || !WORD_CHAR.test(s[i - 1]!)
      if (wordStart && run(s, i + p.length, 20) >= 20) return true
      i = s.indexOf(p, i + 1)
    }
  }
  const lower = s.toLowerCase()
  for (const w of KEY_WORDS) {
    let i = lower.indexOf(w)
    while (i !== -1) {
      let j = i + w.length
      if (lower[j] === '"' || lower[j] === "'") j++
      while (lower[j] === ' ' || lower[j] === '\t') j++
      if (lower[j] === '=' || lower[j] === ':') {
        j++
        while (lower[j] === ' ' || lower[j] === '\t') j++
        if (lower[j] === '"' || lower[j] === "'") j++
        if (run(lower, j, 16) >= 16) return true
      }
      i = lower.indexOf(w, i + 1)
    }
  }
  return false
}

export function scrub(text: string): ScrubHit[] {
  const hits: ScrubHit[] = []
  const lines = text.split('\n')
  for (let n = 0; n < lines.length; n++) {
    const s = lines[n]!
    if (s.length === 0) continue
    if (hasEmail(s)) hits.push({ line: n + 1, kind: 'email' })
    if (hasHomePath(s)) hits.push({ line: n + 1, kind: 'home-path' })
    if (hasToken(s)) hits.push({ line: n + 1, kind: 'token' })
  }
  return hits
}
