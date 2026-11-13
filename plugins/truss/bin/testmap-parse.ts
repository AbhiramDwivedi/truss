// Targeted testing, symbol level (truss 0.31.0, speed goal item 1): what one JS or TS file imports and exports, by name, read with a
// small scanner and no parser. bin/testmap.ts uses it to follow a test's imports through re-export barrels to the module that defines
// each name, and a CLI dispatcher's command table to the module of each command's handler. Anything this scanner can't read falls
// back to the whole file, so a gap here costs extra tests, never a missed one. Node built-ins only.

/** `local` imported as `orig` from `spec`; `orig` '*' is a namespace binding, 'default' the default export. */
export type Binding = { local: string; orig: string }
export type ImportStmt = {
  spec: string
  /** where the specifier's opening quote sits in the text, so the literal scan skips it */
  at: number
  /** the names this file takes from the module, or 'all' (a side-effect import, a namespace used other than as `ns.name`, `export *`) */
  names: string[] | 'all'
  bindings: Binding[]
  /** export { a as b } from / export * from: the names re-exported (export name -> name in spec), or '*' */
  reexports: Map<string, string> | '*' | null
}
export type Span = { start: number; end: number }
export type Facts = {
  imports: ImportStmt[]
  /** export name -> local binding name, for `export const|function|class n`, `export { a as n }` and `export default` */
  exports: Map<string, string>
  /** local binding name -> the import it came from */
  bindings: Map<string, { spec: string; orig: string }>
  /** a top-level declaration's text, by the name it binds */
  decls: Map<string, Span>
  /** top-level statements that are not declarations or imports: they run when the module loads */
  loose: Span[]
  /** a top-level `if (isMain) {...}` whose condition is a const built from process.argv: the CLI entry, which runs only as a script */
  guard: Span | null
  /** `const [NAME_]COMMANDS = {...}` or `= [...]`: a command table, by name */
  tables: Map<string, Table>
  /** `argv[0] === 'heavy' ? await heavyMain(...)` in the guard: a command the entry dispatches itself, to its handler's name */
  direct: Map<string, string>
  /** what its import() and require() calls may load (dynamicLoads) */
  dynamic: { text: string; unknown: boolean }
  /** every name a line declares in column 0 (`const x`, `function f`): a top-level name, even one the statement scan missed */
  top: Set<string>
  /** the text with comments, string, template and regex bodies blanked (template ${} kept), same length as the text */
  masked: string
  /** comment spans: prose, never code */
  comments: Span[]
  /** `type` and `interface` declarations: they never run */
  types: Span[]
}
/** entries: command key -> the handler expression's span; spreads: tables spread in (`...CORE`); items: tables listed (`[A, B]`) */
export type Table = { entries: Map<string, Span>; spreads: string[]; items: string[] }

const TABLE = /^(?:[A-Z][A-Z0-9_]*_)?COMMANDS$/
const KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await', 'delete', 'throw', 'new', 'instanceof'])

/** Comments, string, template and regex bodies turned to spaces (newlines kept); a template's ${} expressions stay. */
export function mask(src: string, comments?: Span[]): string {
  const out = src.split('')
  const n = src.length
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' '
  }
  const tpl: number[] = []
  let depth = 0
  let prev = ''
  let word = ''
  let i = 0
  // scans a template body from j; returns where code resumes (after the closing backtick or the ${)
  const body = (j: number): number => {
    const from = j
    while (j < n) {
      if (src[j] === '\\') j += 2
      else if (src[j] === '`') {
        blank(from, j)
        return j + 1
      } else if (src[j] === '$' && src[j + 1] === '{') {
        blank(from, j)
        tpl.push(depth)
        depth++
        return j + 2
      } else j++
    }
    blank(from, n)
    return n
  }
  while (i < n) {
    const c = src[i] as string
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i)
      const end = e < 0 ? n : e
      comments?.push({ start: i, end })
      blank(i, end)
      i = end
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2)
      const end = e < 0 ? n : e + 2
      comments?.push({ start: i, end })
      blank(i, end)
      i = end
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      blank(i + 1, j)
      i = j + 1
      prev = c
      word = ''
      continue
    }
    if (c === '`') {
      i = body(i + 1)
      prev = '`'
      word = ''
      continue
    }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || KEYWORDS.has(word))) {
      let j = i + 1
      let cls = false
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') j++
        else if (src[j] === '[') cls = true
        else if (src[j] === ']') cls = false
        else if (src[j] === '/' && !cls) break
        j++
      }
      blank(i + 1, j)
      i = j + 1
      while (i < n && /[a-z]/.test(src[i] as string)) i++
      prev = '/'
      word = ''
      continue
    }
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') {
      depth--
      if (c === '}' && tpl.length && tpl[tpl.length - 1] === depth) {
        tpl.pop()
        i = body(i + 1)
        prev = '`'
        word = ''
        continue
      }
    }
    if (!/\s/.test(c)) {
      if (/[\w$]/.test(c)) word = /[\w$]/.test(prev) ? word + c : c
      else word = ''
      prev = c
    }
    i++
  }
  return out.join('')
}

/** The text between the quote at `at` and its partner, read from the unmasked text. */
const quoted = (src: string, at: number): string => {
  const q = src[at] as string
  const e = src.indexOf(q, at + 1)
  return e < 0 ? '' : src.slice(at + 1, e)
}

/** `a, b as c, type d` -> [[a, a], [b, c], [d, d]] (orig, local) */
function clause(text: string): [string, string][] {
  const out: [string, string][] = []
  for (const part of text.split(',')) {
    const m = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(part)
    if (m) out.push([m[1] as string, (m[2] ?? m[1]) as string])
  }
  return out
}

/** Identifiers a span references: tokens not after a `.` (a property), with `...spread` counted. */
export function idents(masked: string, s: Span): Set<string> {
  const out = new Set<string>()
  const text = masked.slice(s.start, s.end)
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const i = m.index as number
    if (i > 0 && text[i - 1] === '.' && text.slice(Math.max(0, i - 3), i) !== '...') continue
    if (i > 0 && /[\w$]/.test(text[i - 1] as string)) continue
    out.add(m[0])
  }
  return out
}

/** Top-level statement spans: a line at bracket depth 0 that starts in column 0 with no continuation token starts one. */
function statements(masked: string): Span[] {
  const starts: number[] = []
  let depth = 0
  let lineStart = true
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i] as string
    if (lineStart && depth === 0 && /[A-Za-z_$@]/.test(c)) starts.push(i)
    lineStart = c === '\n'
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') depth = Math.max(0, depth - 1)
  }
  return starts.map((s, k) => ({ start: s, end: starts[k + 1] ?? masked.length }))
}

/** A table's entries, split at commas at its own depth. `body` is the span inside the outer braces or brackets. */
function table(src: string, masked: string, body: Span, array: boolean): Table {
  const t: Table = { entries: new Map(), spreads: [], items: [] }
  const parts: Span[] = []
  let depth = 0
  let from = body.start
  for (let i = body.start; i < body.end; i++) {
    const c = masked[i] as string
    if (c === '{' || c === '(' || c === '[') depth++
    else if (c === '}' || c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      parts.push({ start: from, end: i })
      from = i + 1
    }
  }
  parts.push({ start: from, end: body.end })
  for (const p of parts) {
    const m = masked.slice(p.start, p.end)
    const lead = /^\s*/.exec(m)?.[0].length ?? 0
    if (m.trim() === '') continue
    if (array) {
      const id = /^\s*([\w$]+)\s*$/.exec(m)
      if (id) t.items.push(id[1] as string)
      continue
    }
    const spread = /^\s*\.\.\.\s*([\w$]+)\s*$/.exec(m)
    if (spread) {
      t.spreads.push(spread[1] as string)
      continue
    }
    const at = p.start + lead
    const q = src[at]
    let key: string
    let rest: number
    if (q === "'" || q === '"') {
      key = quoted(src, at)
      rest = at + key.length + 2
    } else {
      const k = /^[\w$-]+/.exec(src.slice(at, p.end))
      if (!k) continue
      key = k[0]
      rest = at + key.length
    }
    const colon = masked.indexOf(':', rest)
    // shorthand `key` or a method `key() {}`: the entry's whole text is the handler
    t.entries.set(key, colon < 0 || colon >= p.end ? { start: at, end: p.end } : { start: colon + 1, end: p.end })
  }
  return t
}

const ARG_GLOBALS = new Set(['import', 'require', 'await', 'pathToFileURL', 'fileURLToPath', 'href', 'path', 'join', 'resolve', 'URL', 'new', 'meta', 'url', 'dirname', 'process', 'cwd', 'String', 'toString'])

/** What an `import()` or `require()` call may load: the text of its argument, plus the line that declares each variable in it.
 * `unknown` is set when an argument's variable has no `const|let|var` line here (a parameter, an import): it may load anything. */
export function dynamicLoads(src: string, masked: string): { text: string; unknown: boolean } {
  let text = ''
  let unknown = false
  for (const m of masked.matchAll(/\b(?:import|require)\s*\(/g)) {
    const open = (m.index as number) + m[0].length
    let depth = 1
    let i = open
    for (; i < masked.length && depth > 0; i++) {
      if (masked[i] === '(') depth++
      else if (masked[i] === ')') depth--
    }
    const arg = { start: open, end: i - 1 }
    const raw = src.slice(arg.start, arg.end)
    text += raw + '\n'
    // a module file name in the argument names the target; its variables are only the dir in front (`${proofPlugin()}/bin/inbox.ts`)
    if (/\.[cm]?[jt]sx?\b/.test(raw)) continue
    for (const id of idents(masked, arg)) {
      if (ARG_GLOBALS.has(id)) continue
      const decl = new RegExp(String.raw`\b(?:const|let|var)\s+${id.replace(/\$/g, '\\$')}\s*(?::[^=\n]*)?=([^\n]*)`).exec(src)
      if (decl) text += (decl[1] as string) + '\n'
      else unknown = true
    }
  }
  return { text, unknown }
}

/** What one JS or TS file imports, exports and declares at the top level. */
export function facts(src: string): Facts {
  const comments: Span[] = []
  const masked = mask(src, comments)
  const f: Facts = { imports: [], exports: new Map(), bindings: new Map(), decls: new Map(), loose: [], guard: null, tables: new Map(), direct: new Map(), top: new Set(), dynamic: { text: '', unknown: false }, masked, comments, types: [] }
  f.dynamic = dynamicLoads(src, masked)
  for (const m of masked.matchAll(/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\s*\*?|class)\s+([\w$]+)/gm)) f.top.add(m[1] as string)
  for (const m of masked.matchAll(/\bimport\s+(type\s+)?([\w$\s{},*]*?)\s*\bfrom\s*(['"])/g)) {
    const at = (m.index as number) + m[0].length - 1
    const spec = quoted(src, at)
    const cl = (m[2] as string).trim()
    const bindings: Binding[] = []
    let names: string[] | 'all' = []
    const ns = /\*\s+as\s+([\w$]+)/.exec(cl)
    const def = /^([\w$]+)\s*(?:,|$)/.exec(cl)
    if (def && def[1] !== 'type') bindings.push({ local: def[1] as string, orig: 'default' })
    const braces = /\{([^}]*)\}/.exec(cl)
    if (braces) for (const [orig, local] of clause(braces[1] as string)) bindings.push({ local, orig })
    if (ns) {
      bindings.push({ local: ns[1] as string, orig: '*' })
      // `ns.name` uses only: those names; any other use of ns (passed on, indexed, spread) takes the whole module
      const from = m.index as number
      const uses = [...masked.matchAll(new RegExp(String.raw`(?<![\w$.])${ns[1]?.replace(/\$/g, '\\$')}(?![\w$])(\s*\??\.\s*([\w$]+))?`, 'g'))].filter((u) => (u.index as number) < from || (u.index as number) >= from + m[0].length)
      names = uses.every((u) => u[2] !== undefined) ? [...new Set(uses.map((u) => u[2] as string))] : 'all'
    }
    if (names !== 'all') names = [...names, ...bindings.filter((b) => b.orig !== '*').map((b) => b.orig)]
    for (const b of bindings) f.bindings.set(b.local, { spec, orig: b.orig })
    f.imports.push({ spec, at, names, bindings, reexports: null })
  }
  for (const m of masked.matchAll(/\bimport\s*(['"])/g)) {
    const at = (m.index as number) + m[0].length - 1
    f.imports.push({ spec: quoted(src, at), at, names: 'all', bindings: [], reexports: null })
  }
  for (const m of masked.matchAll(/\bexport\s+(?:type\s+)?(\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s*from\s*(['"])/g)) {
    const at = (m.index as number) + m[0].length - 1
    const spec = quoted(src, at)
    const what = m[1] as string
    if (what.startsWith('*')) {
      const as = /as\s+([\w$]+)/.exec(what)
      if (as) {
        f.imports.push({ spec, at, names: 'all', bindings: [], reexports: new Map([[as[1] as string, '*']]) })
      } else f.imports.push({ spec, at, names: 'all', bindings: [], reexports: '*' })
      continue
    }
    const re = new Map<string, string>()
    for (const [orig, local] of clause(what.slice(1, -1))) re.set(local, orig)
    f.imports.push({ spec, at, names: [...re.values()], bindings: [], reexports: re })
  }
  for (const s of statements(masked)) {
    const text = masked.slice(s.start, s.end)
    if (/^import\b(?!\s*\()/.test(text)) continue
    if (/^export\s+(?:type\s+)?(?:\{[^}]*\}|\*[^;\n]*?)\s*from\b/.test(text)) continue
    const local = /^export\s+(?:type\s+)?\{([^}]*)\}/.exec(text)
    if (local) {
      for (const [orig, name] of clause(local[1] as string)) f.exports.set(name, orig)
      continue
    }
    const fn = /^(export\s+)?(default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/.exec(text)
    const v = /^(export\s+)?(?:declare\s+)?(?:const|let|var)\s+([\w$]+)/.exec(text)
    const cls = /^(export\s+)?(default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([\w$]+)/.exec(text)
    const ty = /^(export\s+)?(?:declare\s+)?(?:type|interface|enum)\s+([\w$]+)/.exec(text)
    const destr = /^(export\s+)?(?:const|let|var)\s*[{[]([^=]*)[}\]]\s*=/.exec(text)
    const named = fn ? { exp: fn[1], def: fn[2], name: fn[3] } : cls ? { exp: cls[1], def: cls[2], name: cls[3] } : v ? { exp: v[1], def: undefined, name: v[2] } : ty ? { exp: ty[1], def: undefined, name: ty[2] } : null
    if (named) {
      f.decls.set(named.name as string, s)
      if (ty && !/\benum\s/.test(text.slice(0, 40))) f.types.push(s)
      if (named.exp) f.exports.set(named.def ? 'default' : (named.name as string), named.name as string)
      if (v && TABLE.test(v[2] as string)) {
        // the initializer: the first `=` at depth 0 that is not `=>`, `==` or a comparison
        let depth = 0
        let eq = -1
        for (let i = 0; i < text.length; i++) {
          const c = text[i] as string
          if (c === '{' || c === '(' || c === '[' || c === '<') depth++
          else if (c === '}' || c === ')' || c === ']' || (c === '>' && text[i - 1] !== '=')) depth--
          else if (c === '=' && depth === 0 && text[i + 1] !== '>' && text[i + 1] !== '=' && !'!<>='.includes(text[i - 1] as string)) {
            eq = i
            break
          }
        }
        const init = eq < 0 ? '' : text.slice(eq + 1)
        const open = /^\s*([{[])/.exec(init)
        if (open) {
          const o = s.start + eq + 1 + init.indexOf(open[1] as string)
          let d = 0
          let close = -1
          for (let i = o; i < s.end; i++) {
            const c = masked[i]
            if (c === '{' || c === '(' || c === '[') d++
            else if (c === '}' || c === ')' || c === ']') {
              d--
              if (d === 0) {
                close = i
                break
              }
            }
          }
          if (close > o) f.tables.set(v[2] as string, table(src, masked, { start: o + 1, end: close }, open[1] === '['))
        }
      }
      continue
    }
    if (destr) {
      for (const id of idents(masked, { start: s.start + text.indexOf(destr[2] as string), end: s.start + text.indexOf(destr[2] as string) + (destr[2] as string).length })) f.decls.set(id, s)
      continue
    }
    if (/^export\s+default\b/.test(text)) {
      f.decls.set('default', s)
      f.exports.set('default', 'default')
      continue
    }
    f.loose.push(s)
  }
  // the CLI entry: `if (isMain) {` where isMain's declaration reads process.argv
  for (const s of f.loose) {
    const g = /^if\s*\(\s*([\w$]+)\s*\)/.exec(masked.slice(s.start, s.end))
    const d = g ? f.decls.get(g[1] as string) : undefined
    if (d && /\bprocess\s*\.\s*argv\b/.test(masked.slice(d.start, d.end))) {
      f.guard = s
      for (const m of src.slice(s.start, s.end).matchAll(/===\s*(['"])([\w-]+)\1\s*\?\s*(?:await\s+)?([\w$]+)\s*\(/g)) f.direct.set(m[2] as string, m[3] as string)
      break
    }
  }
  if (f.guard) f.loose = f.loose.filter((s) => s !== f.guard)
  return f
}
