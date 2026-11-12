// truss retro counts: count what a truss session dir recorded (ADR-0003 section 3; ported from the Python
// scripts/retro.py it replaces, P19). `node retro/cli.ts counts <truss dir>` prints one JSON object and exits 0; a
// missing dir exits 2 with "retro: NO_TRUSS_DIR: <path>" on stderr.
//
// Reads decisions.md, events*.jsonl, messages*.jsonl, reports/*/*-qc*.md and plan.json; writes nothing.
// Also reports "leftovers" and "leftoverDetails" for a dir shaped <git common dir>/truss/<session> (ADR-0006
// section 1), read from git and the disk. Git runs only these read-only commands, all with GIT_OPTIONAL_LOCKS=0:
// rev-parse and for-each-ref, worktree list --porcelain, status --porcelain --untracked-files=all,
// merge-base --is-ancestor, rev-parse HEAD^{tree}, merge-tree --write-tree (under a temporary object directory,
// removed before it returns), cherry, branch --show-current and log.
//
// Each run's "refusals" counts the tool calls refused under it, from the hooks' refusal lines. A line never holds a
// command's or a message's text (P24). The script counts and the skill judges. Where the log does not say, the
// output says "not recorded" and never a zero. Message, prompt and report text is never printed (P8): a QC report
// is read only as far as its first non-empty line.
//
// The output is byte for byte what the Python script printed: Python's JSON rules (NaN and Infinity accepted, ints
// apart from floats, strict control characters), Python's whitespace set, and ensure_ascii output with indent 2.
// Erasable TypeScript only, Node standard library only (P19).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const NR = 'not recorded'
const LINE_CAP = 1 << 20 // a line longer than 1 MiB is skipped, never held whole
const INT_CAP = 10n ** 18n // a count above this is not a plausible agent count; treated as invalid
const GIT_TIMEOUT = 30_000

// a parsed JSON value: ints are bigint and floats are number, as in Python; an object is a Map (key order, no
// prototype keys)
export type J = null | boolean | string | bigint | number | J[] | Map<string, J>
type Dict = Map<string, number>

// ---------- Python-compatible text helpers ----------

// str.isspace() for the characters Python counts as whitespace
const WS = '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const WS_RUN_START = new RegExp(`^[${WS}]+`)
const WS_RUN_END = new RegExp(`[${WS}]+$`)
const pyStrip = (s: string): string => s.replace(WS_RUN_START, '').replace(WS_RUN_END, '')
const pyRstrip = (s: string): string => s.replace(WS_RUN_END, '')
const WORD_END = '(?![\\p{L}\\p{N}_])' // Python's \b after a word character

const DATE = '\\d{4}-\\d{2}-\\d{2}'
const DATETIME = `${DATE}[Tt]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:[Zz]|[+-]\\d{2}:\\d{2})`
const STRUCTURED = new RegExp(`^- (${DATETIME}|${DATE}|\\d{1,2}:\\d{2}|HH:MM) \\| (.*)$`, 's')
const RECOMMEND = new RegExp(`^[${WS}]*checker-\\d+ RECOMMEND (answer|defer|pass)${WORD_END}`, 'u')
// A RECOMMEND in a decision line's checker field: "RECOMMEND: answer (soft)", "checker-3 RECOMMEND: answer",
// "checker-4: RECOMMEND: defer (x2)". An "(xN)" right after the outcome is N of them.
const CHECKER_FIELD = new RegExp(
  `^(?:checker-\\d+:?[${WS}]+)?RECOMMEND:?[${WS}]+(answer|defer|pass)${WORD_END}(?:[${WS}]*\\(x([1-9]\\d{0,2})\\))?`,
  'u',
)
const HEADING = /^## Run[ \t]+(.*)$/s
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/
const QC_NAME = /^(.+)-qc(-\d+)?$/s
const QC_FILE = /^.+-qc(-\d+)?\.md$/s
const GOAL_TAG = /^\[([a-z0-9]+(?:-[a-z0-9]+)*)\] /
const AGENT_ID = /^[0-9a-z]+\n?$/
const DATE_ONLY = new RegExp(`^${DATE}$`)

// ---------- Python-compatible JSON ----------

class BadJson extends Error {}

const parseJson = (text: string): J => {
  let i = 0
  const n = text.length
  const skip = (): void => {
    while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++
  }
  const str = (): string => {
    i++ // opening quote
    let out = ''
    for (;;) {
      let j = i
      while (j < n) {
        const c = text.charCodeAt(j)
        if (c === 0x22 || c === 0x5c || c < 0x20) break
        j++
      }
      if (j >= n) throw new BadJson('unterminated string')
      out += text.slice(i, j)
      const c = text.charCodeAt(j)
      if (c === 0x22) {
        i = j + 1
        return out
      }
      if (c < 0x20) throw new BadJson('control character')
      const e = text[j + 1]
      const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
      if (e !== undefined && Object.hasOwn(simple, e)) {
        out += simple[e]
        i = j + 2
      } else if (e === 'u') {
        const hex = text.slice(j + 2, j + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new BadJson('bad \\u escape')
        out += String.fromCharCode(parseInt(hex, 16))
        i = j + 6
      } else throw new BadJson('bad escape')
    }
  }
  const value = (depth: number): J => {
    if (depth > 900) throw new BadJson('too deep') // Python raises RecursionError, read as not JSON
    skip()
    const c = text[i]
    if (c === '"') return str()
    if (c === '{') {
      i++
      const m = new Map<string, J>()
      skip()
      if (text[i] === '}') {
        i++
        return m
      }
      for (;;) {
        skip()
        if (text[i] !== '"') throw new BadJson('expected key')
        const k = str()
        skip()
        if (text[i] !== ':') throw new BadJson('expected colon')
        i++
        m.set(k, value(depth + 1))
        skip()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === '}') {
          i++
          return m
        }
        throw new BadJson('expected , or }')
      }
    }
    if (c === '[') {
      i++
      const a: J[] = []
      skip()
      if (text[i] === ']') {
        i++
        return a
      }
      for (;;) {
        a.push(value(depth + 1))
        skip()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === ']') {
          i++
          return a
        }
        throw new BadJson('expected , or ]')
      }
    }
    for (const [word, v] of [['null', null], ['true', true], ['false', false], ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity]] as const) {
      if (text.startsWith(word, i)) {
        i += word.length
        return v
      }
    }
    const num = /(-?(?:0|[1-9][0-9]*))(\.[0-9]+)?([eE][-+]?[0-9]+)?/y
    num.lastIndex = i
    const m = num.exec(text)
    if (!m) throw new BadJson('bad value')
    i += m[0].length
    if (m[2] === undefined && m[3] === undefined) {
      if (m[1].replace('-', '').length > 4300) throw new BadJson('int too large') // Python's int digit limit
      return BigInt(m[1])
    }
    return Number(m[0])
  }
  const v = value(0)
  skip()
  if (i !== n) throw new BadJson('extra data')
  return v
}

// json.loads that never raises: anything unusable reads as 'not JSON' (null). Callers treat null as unusable input.
const loads = (text: string): J => {
  try {
    return parseJson(text)
  } catch {
    return null
  }
}

const isMap = (v: J | undefined): v is Map<string, J> => v instanceof Map
const get = (m: Map<string, J>, k: string): J => m.get(k) ?? null
const isStr = (v: J | undefined): v is string => typeof v === 'string'
const isInt = (v: J | undefined): v is bigint => typeof v === 'bigint'
// a real int of sane size
const goodInt = (v: J | undefined): v is bigint => isInt(v) && v >= -INT_CAP && v <= INT_CAP
const bump = (d: Dict, k: string, by = 1): void => {
  d.set(k, (d.get(k) ?? 0) + by)
}

// json.dumps(value, indent=2, ensure_ascii=True)
const esc = (s: string): string => {
  let out = '"'
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k)
    if (c === 0x22) out += '\\"'
    else if (c === 0x5c) out += '\\\\'
    else if (c === 0x0a) out += '\\n'
    else if (c === 0x0d) out += '\\r'
    else if (c === 0x09) out += '\\t'
    else if (c === 0x08) out += '\\b'
    else if (c === 0x0c) out += '\\f'
    else if (c < 0x20 || c > 0x7e) out += `\\u${c.toString(16).padStart(4, '0')}`
    else out += s[k]
  }
  return `${out}"`
}
type Out = null | boolean | string | bigint | number | Out[] | Map<string, Out> | { [k: string]: Out }
const dumps = (v: Out, ind = ''): string => {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'string') return esc(v)
  if (typeof v === 'bigint' || typeof v === 'number') return String(v)
  const inner = `${ind}  `
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    return `[\n${v.map((x) => inner + dumps(x, inner)).join(',\n')}\n${ind}]`
  }
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v)
  if (entries.length === 0) return '{}'
  return `{\n${entries.map(([k, x]) => `${inner}${esc(k)}: ${dumps(x, inner)}`).join(',\n')}\n${ind}}`
}

// ---------- time ----------

// microseconds since the epoch as a bigint, or null when text is not an RFC 3339 date-time Python would accept
const parseRfc3339 = (text: J | undefined): bigint | null => {
  if (!isStr(text)) return null
  const m = RFC3339.exec(pyStrip(text))
  if (!m) return null
  const [, ys, mos, ds, hs, mis, ss, frac, zone] = m
  const y = Number(ys), mo = Number(mos), d = Number(ds), h = Number(hs), mi = Number(mis), s = Number(ss)
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > dim || h > 23 || mi > 59 || s > 59) return null
  let offset = 0
  if (zone !== 'Z' && zone !== 'z') {
    const minutes = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))
    if (minutes >= 24 * 60) return null // datetime.timezone needs an offset inside a day
    offset = zone[0] === '+' ? minutes : -minutes
  }
  const micro = Number((frac ?? '0').slice(0, 6).padEnd(6, '0'))
  // days from civil (Howard Hinnant)
  const yy = mo <= 2 ? y - 1 : y
  const era = Math.floor(yy / 400)
  const yoe = yy - era * 400
  const doy = Math.floor((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  const days = era * 146097 + doe - 719468
  const secs = BigInt(days) * 86400n + BigInt(h * 3600 + mi * 60 + s - offset * 60)
  return secs * 1_000_000n + BigInt(micro)
}

// ---------- reading files ----------

// Yield each line as text (BOM, CR and LF stripped, bad bytes replaced), or null for a line over LINE_CAP. Streams:
// never holds more than one capped line. An unreadable file yields nothing.
function* readLines(path: string): Generator<string | null> {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return
  }
  try {
    const chunk = Buffer.alloc(1 << 16)
    let parts: Buffer[] = []
    let len = 0
    let over = false
    let first = true
    let any = false // bytes of a line not yet ended
    const finish = function* (): Generator<string | null> {
      if (over) yield null
      else {
        let text = Buffer.concat(parts).toString('utf8')
        if (first) text = text.replace(/^﻿+/, '')
        yield text.replaceAll('\r', '')
      }
      first = false
      parts = []
      len = 0
      over = false
      any = false
    }
    for (;;) {
      let got: number
      try {
        got = readSync(fd, chunk, 0, chunk.length, null)
      } catch {
        return
      }
      if (got === 0) break
      let pos = 0
      while (pos < got) {
        const nl = chunk.indexOf(10, pos)
        const end = nl === -1 || nl >= got ? got : nl
        if (end > pos) {
          any = true
          len += end - pos
          if (len > LINE_CAP) {
            over = true
            parts = []
          } else if (!over) parts.push(Buffer.from(chunk.subarray(pos, end)))
        }
        if (nl !== -1 && nl < got) {
          any = true
          yield* finish()
          pos = nl + 1
        } else pos = got
      }
    }
    if (any) yield* finish()
  } finally {
    closeSync(fd)
  }
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// the files in a directory named <prefix>*<suffix>, sorted
const listFiles = (directory: string, prefix: string, suffix: string): string[] => {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }
  return names
    .sort(cmp)
    .filter((nm) => nm.length >= prefix.length + suffix.length && nm.startsWith(prefix) && nm.endsWith(suffix))
    .map((nm) => join(directory, nm))
    .filter(isFile)
}

const fileDigest = (path: string): string => {
  const h = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(1 << 20)
    for (;;) {
      const got = readSync(fd, buf, 0, buf.length, null)
      if (got === 0) break
      h.update(buf.subarray(0, got))
    }
  } finally {
    closeSync(fd)
  }
  return h.digest('hex')
}

// Drop a file whose bytes equal an earlier file in the list. A half-failed roll in register.ts's appendLine copies
// events.jsonl to events.<n>.jsonl and then fails to rewrite events.jsonl, leaving two identical files; reading both
// counts every line twice. Only whole-file duplicates go; a rolled file that is a prefix of the live one still
// counts. Size is compared first and the hash is streamed, so a big log is never loaded whole.
const dropDuplicateFiles = (paths: string[]): string[] => {
  const kept: string[] = []
  const bySize = new Map<number, string[]>()
  const digests = new Map<string, string>()
  const digest = (p: string): string => {
    let d = digests.get(p)
    if (d === undefined) {
      d = fileDigest(p)
      digests.set(p, d)
    }
    return d
  }
  for (const path of paths) {
    try {
      const size = statSync(path).size
      let same = bySize.get(size)
      if (same === undefined) {
        same = []
        bySize.set(size, same)
      }
      if (same.length > 0 && same.some((k) => digest(k) === digest(path))) continue
      same.push(path)
      kept.push(path)
    } catch {
      kept.push(path) // unreadable: let the normal reader deal with it
    }
  }
  return kept
}

// ---------- runs ----------

type Run = {
  started: string
  goal: string
  dt: bigint | null
  decisions: { total: number; clock: number; dateOnly: number; notRecorded: number; followed: number; overruled: number; other: number }
  freeform: number
  recommendations: { total: number; answer: number; defer: number; pass: number }
  messages: number
  spawns: { total: number; byModelEffort: Dict }
  stalls: { agent: number; idleProjectManager: number }
  esc: { QUESTION: number; BLOCKED: number; PROPOSAL: number }
  qcs: { pass: number; fail: number }
  allowanceCrews: Set<string>
  knowledge: Map<string, { items: number; ran: boolean }>
  fetches: { total: number; perAgent: Dict }
  refusals: { total: number; bySource: Dict; byTool: Dict; byCategory: Dict; byProgram: Dict; byShape: Dict }
  goals: Dict
}

const newRun = (started: string, goal: string, dt: bigint | null): Run => ({
  started,
  goal,
  dt,
  decisions: { total: 0, clock: 0, dateOnly: 0, notRecorded: 0, followed: 0, overruled: 0, other: 0 },
  freeform: 0,
  recommendations: { total: 0, answer: 0, defer: 0, pass: 0 },
  messages: 0,
  spawns: { total: 0, byModelEffort: new Map() },
  stalls: { agent: 0, idleProjectManager: 0 },
  esc: { QUESTION: 0, BLOCKED: 0, PROPOSAL: 0 },
  qcs: { pass: 0, fail: 0 },
  allowanceCrews: new Set(),
  knowledge: new Map(),
  fetches: { total: 0, perAgent: new Map() },
  refusals: { total: 0, bySource: new Map(), byTool: new Map(), byCategory: new Map(), byProgram: new Map(), byShape: new Map() },
  goals: new Map(),
})

// ADR-0033: the retro's count of optional learning: crews, the learned items their members reported, and knowledge steps run versus skipped
const knowledgeOf = (m: Map<string, { items: number; ran: boolean }>): Out => {
  const all = [...m.values()]
  const ran = all.filter((k) => k.ran).length
  return { crews: all.length, items: all.reduce((n, k) => n + k.items, 0), ran, skipped: all.length - ran }
}

const classifyTime = (token: string): 'notRecorded' | 'dateOnly' | 'clock' => {
  if (token === 'HH:MM') return 'notRecorded'
  if (DATE_ONLY.test(token)) return 'dateOnly'
  return 'clock'
}

type Rec = 'answer' | 'defer' | 'pass'

// Return the heading runs, the pre-heading run, and whether the pre-heading run holds any '- ' line.
export const readDecisions = (path: string): { runs: Run[]; pre: Run; preUsed: boolean } => {
  const pre = newRun(NR, NR, null)
  let preUsed = false
  const runs: Run[] = []
  let cur = pre
  for (const line of readLines(path)) {
    if (line === null) continue
    const h = HEADING.exec(line)
    if (h) {
      const at = h[1].indexOf(' | ')
      const start = pyStrip(at === -1 ? h[1] : h[1].slice(0, at))
      const goal = at === -1 ? '' : pyStrip(h[1].slice(at + 3))
      const dt = parseRfc3339(start)
      cur = newRun(dt !== null ? start : NR, goal || NR, dt)
      runs.push(cur)
      continue
    }
    if (!line.startsWith('- ')) continue
    if (cur === pre) preUsed = true
    const m = STRUCTURED.exec(line)
    if (!m) {
      cur.freeform++
      continue
    }
    const rest = m[2]
    const rec = RECOMMEND.exec(rest)
    if (rec) {
      cur.recommendations.total++
      cur.recommendations[rec[1] as Rec]++
      continue
    }
    const d = cur.decisions
    d.total++
    d[classifyTime(m[1])]++
    const fields = rest.split('|')
    const tag = GOAL_TAG.exec(pyStrip(fields[0]))
    if (tag) bump(cur.goals, tag[1])
    const cyn = fields.length >= 4 ? CHECKER_FIELD.exec(pyStrip(fields[fields.length - 2])) : null
    if (cyn) {
      const n = Number(cyn[2] ?? 1)
      cur.recommendations.total += n
      cur.recommendations[cyn[1] as Rec] += n
    }
    const outcome = pyStrip(fields[fields.length - 1])
    if (outcome === 'followed' || outcome === 'followed (deferred)') d.followed++
    else if (outcome.startsWith('overruled')) d.overruled++
    else d.other++
  }
  return { runs, pre, preUsed }
}

// The run whose parsed start is the latest at or before ts; null when ts precedes them all.
const assign = (runs: Run[], ts: bigint): Run | null => {
  let best: Run | null = null
  for (const r of runs) {
    if (r.dt !== null && r.dt <= ts && (best === null || r.dt >= (best.dt as bigint))) best = r
  }
  return best
}

// a usable v:1 line, else null. The caller counts the skip.
const validEvent = (line: string): { ev: Map<string, J>; ts: bigint } | null => {
  const ev = loads(line)
  if (!isMap(ev)) return null
  const v = ev.get('v')
  if (v !== 1n && v !== 1) return null
  const ts = parseRfc3339(get(ev, 'ts'))
  return ts === null ? null : { ev, ts }
}

const named = (ev: Map<string, J>, k: string): string => {
  const v = ev.get(k)
  return isStr(v) && v !== '' ? v : 'unset'
}

// Fill the runs' event counters. With no runs, every valid event is outside: a dir without headings cannot be split.
// fetchSeen and refusalSeen say whether the log holds any valid fetch line, and any valid refusal line.
const processEvents = (files: string[], runs: Run[]): { skipped: number; outside: number; fetchSeen: boolean; refusalSeen: boolean } => {
  let skipped = 0
  let outside = 0
  let fetchSeen = false
  let refusalSeen = false
  for (const path of files) {
    for (const line of readLines(path)) {
      if (line === null) {
        skipped++
        continue
      }
      if (pyStrip(line) === '') continue
      const got = validEvent(line)
      if (got === null) {
        skipped++
        continue
      }
      const { ev, ts } = got
      const kind = get(ev, 'event')
      if (kind === 'fetch') fetchSeen = true
      else if (kind === 'refusal') refusalSeen = true
      const run = assign(runs, ts)
      if (run === null) {
        outside++
        continue
      }
      if (kind === 'spawn') {
        run.spawns.total++
        bump(run.spawns.byModelEffort, `${named(ev, 'model')}/${named(ev, 'effort')}`)
      } else if (kind === 'fetch') {
        run.fetches.total++
        bump(run.fetches.perAgent, named(ev, 'agent'))
      } else if (kind === 'refusal') {
        // counts only: the line holds the refusal's reason and the command's first word, never its text (P24)
        const f = run.refusals
        f.total++
        const source = named(ev, 'source')
        const tool = named(ev, 'tool')
        bump(f.bySource, source)
        bump(f.byTool, tool)
        bump(f.byCategory, `${source}: ${named(ev, 'category')}`)
        if (tool === 'Bash') bump(f.byProgram, named(ev, 'program'))
        const shape = get(ev, 'shape')
        if (Array.isArray(shape)) {
          for (const part of [...new Set(shape.filter(isStr))].sort()) bump(f.byShape, part)
        }
      } else if (kind === 'stall') {
        const k = get(ev, 'kind')
        if (k === 'agent') run.stalls.agent++
        else if (k === 'idle-project-manager') run.stalls.idleProjectManager++
      } else if (kind === 'tag') {
        const tag = get(ev, 'tag')
        if (tag === 'QUESTION' || tag === 'BLOCKED' || tag === 'PROPOSAL') run.esc[tag]++
      } else if (kind === 'allowance-spent') {
        const crew = get(ev, 'crew')
        if (isStr(crew) && crew !== '') run.allowanceCrews.add(crew)
      } else if (kind === 'knowledge') {
        // ADR-0033: one line per crew and run; a later line for the same crew (a resume) merges into the earlier one: ran is true when
        // any line says so, items is the largest count seen, so a merge-ready resume (ran false, items 0) erases nothing
        const crew = get(ev, 'crew')
        const items = get(ev, 'items')
        const ran = get(ev, 'ran')
        if (isStr(crew) && crew !== '' && typeof ran === 'boolean' && (typeof items === 'number' || typeof items === 'bigint') && Number.isInteger(Number(items)) && Number(items) >= 0) {
          const old = run.knowledge.get(crew)
          run.knowledge.set(crew, { items: Math.max(old?.items ?? 0, Number(items)), ran: (old?.ran ?? false) || ran })
        }
      } else if (kind === 'report') {
        const agent = get(ev, 'agent')
        const m = isStr(agent) ? QC_NAME.exec(agent) : null
        if (m && m[1] === get(ev, 'crew')) {
          const marker = get(ev, 'marker')
          if (marker === 'VERDICT: PASS') run.qcs.pass++
          else if (marker === 'VERDICT: FAIL') run.qcs.fail++
        }
      }
    }
  }
  return { skipped, outside, fetchSeen, refusalSeen }
}

// Count messages per run. Returns true when any landed in the pre-heading run.
const processMessages = (files: string[], runs: Run[], pre: Run): boolean => {
  let used = false
  for (const path of files) {
    for (const line of readLines(path)) {
      if (!line || pyStrip(line) === '') continue
      const msg = loads(line)
      if (!isMap(msg)) continue
      let run: Run | null = null
      if (runs.length > 0) {
        const ts = parseRfc3339(get(msg, 'ts'))
        run = ts !== null ? assign(runs, ts) : null
      }
      if (run === null) {
        run = pre
        used = true
      }
      run.messages++
    }
  }
  return used
}

const qcFiles = (directory: string): { files: number; pass: number; fail: number; other: number } => {
  const out = { files: 0, pass: 0, fail: 0, other: 0 }
  const root = join(directory, 'reports')
  let crews: string[]
  try {
    crews = readdirSync(root).sort(cmp)
  } catch {
    return out
  }
  for (const crew of crews) {
    const sub = join(root, crew)
    if (!isDir(sub)) continue
    let names: string[]
    try {
      names = readdirSync(sub).sort(cmp)
    } catch {
      continue
    }
    for (const nm of names) {
      const p = join(sub, nm)
      if (!QC_FILE.test(nm) || !isFile(p)) continue
      let first = ''
      for (const line of readLines(p)) {
        if (line === null) break
        if (pyStrip(line) !== '') {
          first = pyStrip(line)
          break
        }
      }
      out.files++
      if (first.startsWith('VERDICT: PASS')) out.pass++
      else if (first.startsWith('VERDICT: FAIL')) out.fail++
      else out.other++
    }
  }
  return out
}

// ---------- plan ----------

const readPlanFile = (directory: string): Map<string, J> | null => {
  let text: string
  try {
    text = readFileSync(join(directory, 'plan.json')).toString('utf8').replace(/^﻿+/, '')
  } catch {
    return null
  }
  const plan = loads(text)
  return isMap(plan) ? plan : null
}

const crewsOf = (plan: Map<string, J>): Map<string, J>[] => {
  const crews = plan.get('crews')
  return Array.isArray(crews) ? crews.filter(isMap) : []
}

// a set key that follows Python equality: 1 and 1.0 are one value, "1" is another
const stageKey = (w: string | bigint | number): string => {
  if (typeof w === 'string') return `s:${w}`
  if (typeof w === 'bigint') return `n:${w}`
  return Number.isInteger(w) ? `n:${BigInt(w)}` : `n:${w}`
}

const statusKey = (st: J): string => (isStr(st) && st !== '' ? st : 'unset')

const readPlan = (directory: string): Out => {
  const plan = readPlanFile(directory)
  if (plan === null) return NR
  const crews = crewsOf(plan)
  const stages = new Set<string>()
  let est = 0n
  const status: Dict = new Map()
  for (const c of crews) {
    const w = c.get('stage')
    if (isStr(w) || isInt(w) || typeof w === 'number') stages.add(stageKey(w))
    const e = c.get('estAgents')
    if (goodInt(e)) est += e // NaN, Infinity, floats, bools and absurd ints are skipped
    bump(status, statusKey(c.get('status')))
  }
  const cap = plan.get('agentCap')
  return { crews: crews.length, stages: stages.size, estAgents: est, agentCap: goodInt(cap) ? cap : NR, status }
}

// A crew's goal: its `goal` when a string, else `run` (the same rule as goalOf in intake.ts).
const goalOf = (crew: Map<string, J>): string => {
  const g = crew.get('goal')
  return isStr(g) ? g : 'run'
}

// Per-goal rows (run first, then plan goals in order), or null when plan.json has no non-empty `goals` array.
const readGoals = (directory: string, last: Run): Out | null => {
  const plan = readPlanFile(directory)
  const goals = plan?.get('goals')
  if (plan === null || !Array.isArray(goals) || goals.length === 0) return null
  const entries = goals.filter((g): g is Map<string, J> => isMap(g) && isStr(g.get('id')))
  const ids = new Set(entries.map((g) => g.get('id') as string))
  const crews = crewsOf(plan)
  let tagged = 0
  for (const [t, n] of last.goals) if (ids.has(t)) tagged += n
  const top = plan.get('goal')
  const rows: [string, string, string, number][] = [['run', isStr(top) ? top : NR, NR, last.decisions.total - tagged]]
  for (const g of entries) {
    const text = g.get('goal')
    const added = g.get('addedAt')
    rows.push([g.get('id') as string, isStr(text) ? text : NR, isStr(added) ? added : NR, last.goals.get(g.get('id') as string) ?? 0])
  }
  return rows.map(([id, goal, addedAt, n]) => {
    let est = 0n
    const status: Dict = new Map()
    const mine = crews.filter((c) => goalOf(c) === id)
    for (const c of mine) {
      const e = c.get('estAgents')
      if (goodInt(e)) est += e
      bump(status, statusKey(c.get('status')))
    }
    return { id, goal, addedAt, crews: mine.length, estAgents: est, status, decisions: n }
  })
}

// ---------- git ----------

const gitRun = (cwd: string, args: string[], extraEnv?: Record<string, string>): { code: number; out: string } | null => {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...extraEnv }
  const r = spawnSync('git', args, { cwd, env, timeout: GIT_TIMEOUT, maxBuffer: 1 << 30 })
  if (r.error || r.status === null) return null
  let out: string
  try {
    out = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(r.stdout)
  } catch {
    return null
  }
  return { code: r.status, out: out.replace(/\r\n?/g, '\n') }
}

// Run a read-only git command; return stdout, or null on any failure.
const gitOut = (cwd: string, ...args: string[]): string | null => {
  const r = gitRun(cwd, args)
  return r !== null && r.code === 0 ? r.out : null
}

const splitLines = (s: string): string[] => {
  const lines = s.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

const realOrSelf = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
const normcase = (p: string): string => (process.platform === 'win32' ? p.toLowerCase().replaceAll('/', '\\') : p)
const samePath = (a: string, b: string): boolean => normcase(realOrSelf(a)) === normcase(realOrSelf(b))

const spawnedIds = (files: string[]): Set<string> => {
  const ids = new Set<string>()
  for (const path of files) {
    for (const line of readLines(path)) {
      if (line === null || pyStrip(line) === '') continue
      const got = validEvent(line)
      if (got === null || got.ev.get('event') !== 'spawn') continue
      const i = got.ev.get('agentId')
      if (isStr(i) && AGENT_ID.test(i)) ids.add(i)
    }
  }
  return ids
}

// The repo root for a dir shaped <repo>/.git/truss/<session>, or null when it is not.
const repoRoot = (directory: string): string | null => {
  const common = dirname(dirname(directory))
  if (basename(dirname(directory)) !== 'truss' || basename(common) !== '.git') return null
  const top = gitOut(common, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  if (top === null || !samePath(pyStrip(top), common)) return null
  return dirname(common)
}

// Branches and folders still left by this dir's spawned agents, or NR when it cannot be told.
const leftovers = (directory: string, eventFiles: string[]): Out => {
  if (eventFiles.length === 0) return NR
  const main = repoRoot(directory)
  if (main === null) return NR
  const refs = gitOut(main, 'for-each-ref', '--format=%(refname)', 'refs/heads/')
  if (refs === null) return NR
  const have = new Set(splitLines(refs))
  const branches: string[] = []
  const folders: string[] = []
  const agents = new Set<string>()
  for (const i of [...spawnedIds(eventFiles)].sort(cmp)) {
    const name = `worktree-agent-${i}`
    if (have.has(`refs/heads/${name}`)) {
      branches.push(name)
      agents.add(i)
    }
    if (isDir(join(main, '.claude', 'worktrees', `agent-${i}`))) {
      folders.push(`.claude/worktrees/agent-${i}`)
      agents.add(i)
    }
  }
  return { branches: branches.sort(cmp), folders: folders.sort(cmp), count: agents.size }
}

type Worktree = { path: string; head: string | null; branch: string | null; locked: string | null }

// git worktree list --porcelain
const parseWorktrees = (text: string): Worktree[] => {
  const out: Worktree[] = []
  for (const block of text.replaceAll('\r\n', '\n').split('\n\n')) {
    let cur: Worktree | null = null
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) cur = { path: line.slice('worktree '.length), head: null, branch: null, locked: null }
      else if (cur === null) continue
      else if (line.startsWith('HEAD ')) cur.head = pyStrip(line.slice(5))
      else if (line.startsWith('branch ')) {
        const ref = pyStrip(line.slice(7))
        cur.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
      } else if (line === 'locked' || line.startsWith('locked ')) cur.locked = pyStrip(line.slice(7)) || 'locked'
    }
    if (cur !== null) out.push(cur)
  }
  return out
}

// True when merge-tree of HEAD and ref gives HEAD's own tree; objects go to a throwaway dir.
const mergesToSameTree = (main: string, ref: string, objects: string): boolean => {
  const t = gitRun(main, ['rev-parse', 'HEAD^{tree}'])
  if (t === null || t.code !== 0 || pyStrip(t.out) === '') return false
  const scratch = mkdtempSync(join(tmpdir(), 'tmp'))
  let r: { code: number; out: string } | null
  try {
    r = gitRun(main, ['merge-tree', '--write-tree', 'HEAD', ref], { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects })
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // a leftover scratch dir is only temp space
    }
  }
  const lines = r !== null && r.code === 0 ? splitLines(r.out) : []
  return lines.length > 0 && pyStrip(lines[0]) === pyStrip(t.out)
}

const inMainBy = (main: string, ref: string, objects: string, allowCherry: boolean): 'ancestor' | 'tree' | 'cherry' | null => {
  if (gitRun(main, ['merge-base', '--is-ancestor', ref, 'HEAD'])?.code === 0) return 'ancestor'
  if (mergesToSameTree(main, ref, objects)) return 'tree'
  if (allowCherry) {
    const r = gitRun(main, ['cherry', 'HEAD', ref])
    const lines = r !== null && r.code === 0 ? splitLines(r.out) : []
    if (lines.length > 0 && lines.every((ln) => ln.startsWith('- '))) return 'cherry'
  }
  return null
}

// One entry per leftover agent (ADR-0006 s1), or NR whenever leftovers is or worktree list fails.
const leftoverDetails = (directory: string, eventFiles: string[], left: Out): Out => {
  if (left === NR) return NR
  const main = repoRoot(directory)
  if (main === null) return NR
  const listing = gitOut(main, 'worktree', 'list', '--porcelain')
  if (listing === null) return NR
  const refs = gitOut(main, 'for-each-ref', '--format=%(refname)', 'refs/heads/')
  if (refs === null) return NR
  const have = new Set(splitLines(refs))
  const worktrees = parseWorktrees(listing)
  const common = gitOut(main, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const objects = common ? join(pyStrip(common), 'objects') : join(main, '.git', 'objects')
  const current = pyStrip(gitOut(main, 'branch', '--show-current') ?? '')
  const entries: Out[] = []
  for (const i of [...spawnedIds(eventFiles)].sort(cmp)) {
    const name = `worktree-agent-${i}`
    const rel = `.claude/worktrees/agent-${i}`
    const path = join(main, '.claude', 'worktrees', `agent-${i}`)
    const branch = have.has(`refs/heads/${name}`) ? name : null
    const folder = isDir(path) ? rel : null
    if (branch === null && folder === null) continue
    const wt = worktrees.find((w) => samePath(w.path, path)) ?? null
    let head: string | null = null
    let dirty: boolean | null = null
    if (wt !== null) {
      head = wt.branch ? wt.branch : `detached ${wt.head ?? ''}`
      const status = gitOut(path, 'status', '--porcelain', '--untracked-files=all')
      dirty = status === null || status !== ''
    }
    const ref = head !== null && !head.startsWith('detached ') ? head : branch
    let inMain: string | null = null
    if (ref !== null) inMain = inMainBy(main, ref, objects, (wt === null || wt.locked === null) && dirty !== true)
    const notIn = `${head} is not in the main checkout's HEAD yet`
    let skip: string
    if (wt === null) skip = 'no longer a registered worktree'
    else if ((head as string).startsWith('detached ')) skip = 'not on a worktree-* branch (detached)'
    else if (!(head as string).startsWith('worktree-')) skip = `not on a worktree-* branch (${head})`
    else if (wt.locked !== null) skip = `locked (${wt.locked})`
    else if (dirty) skip = 'uncommitted changes'
    else if (inMain === null) skip = notIn
    else if (!current) skip = 'the main checkout is on no branch (detached or unreadable)'
    else if (inMain === 'ancestor') skip = 'passes every check retro can see'
    else if (current.startsWith('worktree-')) skip = notIn
    else skip = 'passes every check retro can see'
    entries.push({ id: i, branch, folder, head, dirty, inMain, skip })
  }
  return entries
}

// ---------- repo files ----------

// The absolute path truss.json's string `key` names under root, or null.
const readConfigPath = (root: string, key: string): string | null => {
  let cfg: J
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(join(root, '.claude', 'truss.json')))
    cfg = parseJson(text.replace(/^﻿/, ''))
  } catch {
    return null
  }
  const val = isMap(cfg) ? cfg.get(key) : null
  return isStr(val) && val !== '' ? resolve(root, val) : null
}

// [(committer instant, subject)] from HEAD, or null when git cannot be read.
const commitLog = (root: string | null): [bigint, string][] | null => {
  if (root === null) return null
  const out = gitOut(root, 'log', '--format=%cI%x09%s', 'HEAD')
  if (out === null) return null
  const log: [bigint, string][] = []
  for (const line of splitLines(out)) {
    const tab = line.indexOf('\t')
    const dt = parseRfc3339(tab === -1 ? line : line.slice(0, tab))
    if (dt !== null) log.push([dt, tab === -1 ? '' : line.slice(tab + 1)])
  }
  return log
}

const isExtendPass = (subject: string): boolean => subject.startsWith('docs(arch): extend ') || subject === 'docs(arch): adopt learned items' || subject === 'docs(arch): reconcile learned items'

const countDefaultDecisions = (root: string | null): number | string => {
  if (root === null) return NR
  const adr = readConfigPath(root, 'adr')
  if (adr === null || !isDir(adr)) return NR
  let names: string[]
  try {
    names = readdirSync(adr).sort(cmp)
  } catch {
    return NR
  }
  let n = 0
  for (const name of names) {
    const path = join(adr, name)
    if (!name.endsWith('.md') || !isFile(path)) continue
    for (const l of readLines(path)) {
      if (l !== null && pyRstrip(l) === 'Decided by: default') {
        n++
        break
      }
    }
  }
  return n
}

const countOpenClientActions = (root: string | null): number | string => {
  if (root === null) return NR
  const path = readConfigPath(root, 'architecture')
  if (path === null || !isFile(path)) return NR
  let n = 0
  let under = false
  for (const line of readLines(path)) {
    if (line === null) continue
    const h = /^#{1,6}[ \t]+(.*?)[ \t#]*$/s.exec(line)
    if (h) under = pyStrip(h[1]) === 'Client actions'
    else if (under && line.startsWith('- [ ] ')) n++
  }
  return n
}

// ---------- the report ----------

export const retro = (directory: string): Out => {
  const { runs, pre, preUsed } = readDecisions(join(directory, 'decisions.md'))
  const hasHeadings = runs.length > 0
  const eventFiles = dropDuplicateFiles(listFiles(directory, 'events', '.jsonl'))
  const messageFiles = dropDuplicateFiles(listFiles(directory, 'messages', '.jsonl'))

  const preMsgs = processMessages(messageFiles, runs, pre)
  const { skipped, outside, fetchSeen, refusalSeen } = processEvents(eventFiles, runs)
  const root = repoRoot(directory)
  const log = commitLog(root)
  const defaults = countDefaultDecisions(root)
  const clientOpen = countOpenClientActions(root)
  const starts = runs.map((r) => r.dt).filter((d): d is bigint => d !== null).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  const ordered = hasHeadings ? [...(preUsed || preMsgs ? [pre] : []), ...runs] : [pre]
  const outRuns: Out[] = ordered.map((r) => {
    const placed = eventFiles.length > 0 && r.dt !== null
    let extend: number | string
    if (log === null || r.dt === null) extend = NR
    else {
      const start = r.dt
      const end = starts.find((d) => d > start) ?? null
      extend = log.filter(([d, subj]) => d >= start && (end === null || d < end) && isExtendPass(subj)).length
    }
    return {
      started: r.started,
      goal: r.goal,
      decisions: r.decisions,
      freeform: r.freeform,
      recommendations: r.recommendations,
      messages: r.messages,
      spawns: placed ? r.spawns : NR,
      stalls: placed ? r.stalls : NR,
      escalations: placed ? r.esc : NR,
      qcs: placed ? r.qcs : NR,
      allowancesSpent: placed && r.allowanceCrews.size > 0 ? r.allowanceCrews.size : NR,
      knowledge: placed && r.knowledge.size > 0 ? knowledgeOf(r.knowledge) : NR,
      fetches: placed && fetchSeen ? r.fetches : NR,
      refusals: placed && refusalSeen ? r.refusals : NR,
      extendPasses: extend,
      defaultDecisions: defaults,
      openClientActions: clientOpen,
    }
  })
  const left = leftovers(directory, eventFiles)
  const goals = readGoals(directory, hasHeadings ? runs[runs.length - 1] : pre)
  const result: { [k: string]: Out } = {
    retro: 1,
    dir: directory,
    split: hasHeadings ? 'headings' : NR,
    runs: outRuns,
    qcFiles: qcFiles(directory),
    plan: readPlan(directory),
    eventsSkipped: skipped,
    eventsOutsideRuns: outside,
    leftovers: left,
    leftoverDetails: leftoverDetails(directory, eventFiles, left),
  }
  if (goals !== null) result.goals = goals
  return result
}

export type Counts = { code: number; out: string; err: string }

// `counts <truss dir>`: the JSON report on stdout, or the usage and missing-dir failures on stderr with code 2
export const counts = (args: string[]): Counts => {
  if (args.length !== 1) return { code: 2, out: '', err: 'retro: usage: cli.ts counts <truss dir>\n' }
  const directory = resolve(args[0])
  if (!isDir(directory)) return { code: 2, out: '', err: `retro: NO_TRUSS_DIR: ${directory}\n` }
  return { code: 0, out: `${dumps(retro(directory))}\n`, err: '' }
}
