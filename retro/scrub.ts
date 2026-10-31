// The retro's commit gate (ADR-0012 Seams, scrub; R-32): reports the lines of a text that hold an email address,
// a home path or a token. One hit per kind per line, in line order. Every scan walks the line with indexOf and
// bounded character runs, never a backtracking pattern, so it stays linear on large inputs.
// Erasable TypeScript only, Node standard library only (P19).

export type ScrubKind = 'email' | 'home-path' | 'token' | 'name'
export type ScrubHit = { line: number; kind: ScrubKind }

const LOCAL = /[A-Za-z0-9._%+-]/
const DOMAIN = /[A-Za-z0-9.-]/
const NAME = /[A-Za-z0-9._-]/
const TOKEN_CHAR = /[A-Za-z0-9_-]/
const KEY_VALUE_CHAR = /[A-Za-z0-9_/+-]/
const WORD_CHAR =/[A-Za-z0-9_]/

const TOKEN_PREFIXES = ['sk-', 'ghp_', 'gho_', 'ghs_', 'github_pat_', 'xox', 'AKIA', 'glpat-', 'npm_']
const KEY_WORDS = ['token', 'secret', 'password', 'api_key', 'apikey']

// count token characters from `from`, stopping at `cap` (so a long run is never walked twice)
const run = (s: string, from: number, cap: number, chars: RegExp = TOKEN_CHAR): number => {
  let n = 0
  while (n < cap && from + n < s.length && chars.test(s[from + n]!)) n++
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
    // the last label must start with a letter: a version such as playwright@1.48.2 is a pin, not an address
    const shaped = local.length > 0 && labels.length >= 2 && labels.every(l => l.length > 0) && /^[a-z]/.test(labels[labels.length - 1]!)
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
      // a user dir with or without a trailing slash
      // the fixture user "u" (as in /home/u/p) is a placeholder too, not a person
      if (name.length > 0 && name !== 'u' && (s[j] === '/' || name !== '<name>')) return true
      // the literal placeholder is the one allowed name
      if (name.length === 0 && s.startsWith('<name>/', i + root.length)) {
        i = s.indexOf(root, i + root.length)
        continue
      }
      i = s.indexOf(root, i + root.length)
    }
  }
  // Claude Code's encoded project dir carries the user name: -home-<user>-<project>
  for (const root of ['-home-', '-Users-']) {
    let i = s.indexOf(root)
    while (i !== -1) {
      const before = i === 0 ? ' ' : s[i - 1]!
      if (/[\s/`'"(=]/.test(before) && NAME.test(s[i + root.length] ?? ' ')) return true
      i = s.indexOf(root, i + 1)
    }
  }
  return hasWindowsHome(s)
}

const isSep = (c: string | undefined): boolean => c === '\\' || c === '/'

// C:\Users\<name>\, C:/Users/<name>/ and the JSON-escaped C:\\Users\\<name>\\ (any drive letter, either case)
function hasWindowsHome(s: string): boolean {
  let i = s.indexOf(':')
  while (i !== -1) {
    if (i > 0 && /[A-Za-z]/.test(s[i - 1]!) && (i === 1 || !WORD_CHAR.test(s[i - 2]!))) {
      let k = i + 1
      let seps = 0
      while (seps < 2 && isSep(s[k])) {
        k++
        seps++
      }
      if (seps > 0 && s.slice(k, k + 5).toLowerCase() === 'users') {
        k += 5
        seps = 0
        while (seps < 2 && isSep(s[k])) {
          k++
          seps++
        }
        if (seps > 0) {
          let j = k
          while (j < s.length && NAME.test(s[j]!)) j++
          // the literal placeholder is the one allowed name
          if (j > k) return true
        }
      }
    }
    i = s.indexOf(':', i + 1)
  }
  return false
}

// whether `needle` (lower case) is in `low` with no word character on either side
function hasName(low: string, needle: string): boolean {
  let i = low.indexOf(needle)
  while (i !== -1) {
    const before = i === 0 || !WORD_CHAR.test(low[i - 1]!)
    const after = i + needle.length >= low.length || !WORD_CHAR.test(low[i + needle.length]!)
    if (before && after) return true
    i = low.indexOf(needle, i + 1)
  }
  return false
}

// each prefix and how many token characters must follow it
const TOKEN_MIN: Record<string, number> = { 'sk-': 20, ghp_: 20, gho_: 20, ghs_: 20, github_pat_: 20, xox: 20, AKIA: 16, 'glpat-': 20, npm_: 20 }

const hasToken = (s: string): boolean => {
  for (const p of TOKEN_PREFIXES) {
    let i = s.indexOf(p)
    while (i !== -1) {
      const wordStart = i === 0 || !WORD_CHAR.test(s[i - 1]!)
      if (wordStart && run(s, i + p.length, TOKEN_MIN[p]!) >= TOKEN_MIN[p]!) return true
      i = s.indexOf(p, i + 1)
    }
  }
  // a JWT: eyJ header, a dot, then more
  let j0 = s.indexOf('eyJ')
  while (j0 !== -1) {
    const wordStart = j0 === 0 || !WORD_CHAR.test(s[j0 - 1]!)
    const n = run(s, j0 + 3, 200)
    if (wordStart && n >= 10 && s[j0 + 3 + n] === '.' && run(s, j0 + 4 + n, 10) >= 10) return true
    j0 = s.indexOf('eyJ', j0 + 1)
  }
  // an Authorization bearer value
  const lowerS = s.toLowerCase()
  let b = lowerS.indexOf('bearer ')
  while (b !== -1) {
    const k = b + 7
    let n = 0
    while (n < 40 && k + n < s.length && /[A-Za-z0-9_.~+/=-]/.test(s[k + n]!)) n++
    if (n >= 20) return true
    b = lowerS.indexOf('bearer ', b + 1)
  }
  const lower = s.toLowerCase()
  for (const w of KEY_WORDS) {
    let i = lower.indexOf(w)
    while (i !== -1) {
      let j = i + w.length
      // aws_secret_access_key, token_id: a short word tail before the separator
      let tail = 0
      while (tail < 24 && /[a-z_]/.test(lower[j] ?? '')) {
        j++
        tail++
      }
      if (lower[j] === '"' || lower[j] === "'") j++
      while (lower[j] === ' ' || lower[j] === '\t') j++
      if (lower[j] === '=' || lower[j] === ':') {
        j++
        while (lower[j] === ' ' || lower[j] === '\t') j++
        if (lower[j] === '"' || lower[j] === "'") j++
        // the value after a key word also continues through `/` and `+` (base64 secrets); the prefix, JWT and bearer scans keep their own classes
        if (run(lower, j, 16, KEY_VALUE_CHAR) >= 16) return true
      }
      i = lower.indexOf(w, i + 1)
    }
  }
  return false
}

/** `names` are person names (4+ characters) to find, case-insensitively; the caller supplies them so no name is kept in source. */
export function scrub(text: string, names: string[] = []): ScrubHit[] {
  const hits: ScrubHit[] = []
  const lines = text.split('\n')
  const needles = names.filter(x => x.length >= 4).map(x => x.toLowerCase())
  for (let n = 0; n < lines.length; n++) {
    const s = lines[n]!
    if (s.length === 0) continue
    if (needles.length > 0) {
      const low = s.toLowerCase()
      if (needles.some(x => hasName(low, x))) hits.push({ line: n + 1, kind: 'name' })
    }
    if (hasEmail(s)) hits.push({ line: n + 1, kind: 'email' })
    if (hasHomePath(s)) hits.push({ line: n + 1, kind: 'home-path' })
    if (hasToken(s)) hits.push({ line: n + 1, kind: 'token' })
  }
  return hits
}
