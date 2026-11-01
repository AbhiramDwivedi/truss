// The transcript extractor (ADR-0012 Decision 2): reads one session's transcripts mechanically into
// <truss dir>/retro/extract.json under docs/extract.schema.json. It reads untrusted text and only ever copies short
// quotes out of it; nothing it reads is run, followed or interpreted as an instruction.
// Erasable TypeScript only, Node standard library only (P19). No wall-clock time: the same transcripts and catalog
// give the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { refusalOf } from '../hooks/register.ts'
import type { Catalog } from './catalog.ts'
import { matchLine } from './catalog.ts'

type Obj = Record<string, unknown>
export type Item = Obj & { kind: string; file: string; line: number }
export type Extract = {
  v: 1
  session: string
  files: { path: string; lines: number }[]
  items: Item[]
  catalogHits: { id: string; file: string; line: number; quote: string }[]
  skipped: { json: number; type: Obj }
}

const QUOTE_MAX = 200
const LINE_CAP = 200_000 // a line longer than this is cut before it is matched or quoted; nothing downstream needs more
const TRACE_SCAN = 1_000_000
const FACTORY_JSON_MAX = 200_000
const KINDS = ['toolError', 'refusal', 'repeat', 'step', 'stop', 'qcFail', 'handEdit', 'checkFail'] as const
const MARKER = /^(BLOCKED|CHECKPOINT|QUESTION):/
// <file>.<ext>:<line>: found by its tail so a long run of path characters is scanned once, then the file name is walked back
const TRACE = /\.(?:ts|js|mjs|cjs|py):\d+/g
const PATH_CHAR = /[A-Za-z0-9_@.\/~+-]/
const FACTORY_CMD = /factory\.ts\s+([A-Za-z][A-Za-z-]*)/
const EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])
const NO_TYPE = '(no type)'

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== ''

/** The first 200 characters of a line, trimmed. */
const quoteOf = (line: string): string => line.slice(0, LINE_CAP).trim().slice(0, QUOTE_MAX)

/** The first non-empty line of a text, as a quote ('' when there is none). */
function firstLine(text: string): string {
  let pos = 0
  while (pos < text.length) {
    let e = text.indexOf('\n', pos)
    if (e === -1) e = text.length
    const q = quoteOf(text.slice(pos, Math.min(e, pos + LINE_CAP)))
    if (q !== '') return q
    pos = e + 1
  }
  return ''
}

/** True when a line, trimmed, is a quoted string literal ending in a comma: `"..."` or `'...'` then `,`. */
function isQuotedLiteral(line: string): boolean {
  const t = line.trim()
  if (t.length < 3 || !t.endsWith(',')) return false
  const q = t[0]
  return (q === '"' || q === "'") && t[t.length - 2] === q
}

/** The toolError quote: a first line `Exit code N` joins the next non-empty line. */
function errorQuote(body: string): string {
  const first = firstLine(body)
  if (!/^Exit code \d+$/.test(first)) return first
  const at = body.indexOf(first)
  const rest = firstLine(body.slice(at + first.length))
  return rest === '' ? first : `${first} ${rest}`.slice(0, QUOTE_MAX)
}

const SCRATCH_PATH = /^\/tmp\/claude-\d+\/.*\/scratchpad\//
const MEMORY_PATH = /\/\.claude\/projects\/[^/]+\/memory\//

/** True when a path is a session scratchpad or an auto-memory file. */
const isNoteFile = (p: string): boolean => SCRATCH_PATH.test(p) || MEMORY_PATH.test(p)

/** True when some line of the text, trimmed, is exactly `want`. */
function hasLine(text: string, want: string): boolean {
  let pos = 0
  while (pos < text.length) {
    let e = text.indexOf('\n', pos)
    if (e === -1) e = text.length
    if (e - pos <= want.length + 64 && text.slice(pos, e).trim() === want) return true
    pos = e + 1
  }
  return false
}

/** The marker a text's first non-empty line starts with, with that line as a quote. */
function stopOf(text: string): { marker: string; quote: string } | null {
  const q = firstLine(text)
  const m = MARKER.exec(q)
  return m === null ? null : { marker: m[1], quote: q }
}

/** The text parts of a tool_result's content: a string, or the string `text` of each part of an array. */
function partsOf(content: unknown): string[] {
  if (isStr(content)) return [content]
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const c of content) if (isObj(c) && isStr(c.text)) out.push(c.text)
  return out
}

/** Every string value under a value, depth-limited, in document order. */
function stringsIn(v: unknown, out: string[] = [], depth = 0): string[] {
  if (isStr(v)) out.push(v)
  else if (depth < 8 && Array.isArray(v)) for (const x of v) stringsIn(x, out, depth + 1)
  else if (depth < 8 && isObj(v)) for (const x of Object.values(v)) stringsIn(x, out, depth + 1)
  return out
}

type Run = { id: string | null; line: number; ts: string | null; agent: string }
type Pending = { fileIdx: number; seq: number; line: number; agent: string; label: string; ts: string | null; dir: string }
type Slot = { fileIdx: number; line: number; kind: number; seq: number; item: Item }

/** Read one session's transcripts into an extract. `sessionDir` is the session transcript dir (its base name is the session id). */
export function extractSession(sessionDir: string, catalog: Catalog): Extract {
  const dir = resolve(sessionDir)
  const sid = basename(dir)
  const proj = dirname(dir)

  // the files, in code-point order of their path relative to the project dir
  const paths: string[] = []
  try {
    if (readdirSync(proj, { withFileTypes: true }).some(e => e.isFile() && e.name === `${sid}.jsonl`)) paths.push(`${sid}.jsonl`)
  } catch {
    // no project dir: nothing to read
  }
  const walk = (rel: string): void => {
    let entries
    try {
      entries = readdirSync(join(proj, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const r = `${rel}/${e.name}`
      if (e.isDirectory()) walk(r)
      else if (e.isFile() && e.name.endsWith('.jsonl')) paths.push(r)
    }
  }
  walk(`${sid}/subagents`)
  paths.sort()

  const files: Extract['files'] = []
  const slots: Slot[] = []
  const hits: { fileIdx: number; line: number; seq: number; id: string; quote: string }[] = []
  const pending: Pending[] = []
  const times = new Map<string, { first: string; last: string }>()
  const skippedTypes = new Map<string, number>()
  let skippedJson = 0
  let seq = 0

  paths.forEach((path, fileIdx) => {
    const isMain = path === `${sid}.jsonl`
    const isJournal = !isMain && basename(path) === 'journal.jsonl'
    const fileAgent = isMain ? 'main' : isJournal ? 'journal' : (/^agent-(.+)\.jsonl$/.exec(basename(path))?.[1] ?? 'agent')
    const readTypes = isJournal ? ['launched', 'started', 'result'] : ['user', 'assistant', 'system']

    const tools = new Map<string, { name: string | null; command: string | null }>()
    const errored = new Set<string>()
    const quiet = new Set<string>()
    const runs = new Map<string, Run[]>()
    const seenRunIds = new Set<string>()
    let lastText: { line: number; ts: string | null; agent: string; text: string } | null = null

    const add = (kind: (typeof KINDS)[number], line: number, item: Obj): void => {
      slots.push({ fileIdx, line, kind: KINDS.indexOf(kind), seq: seq++, item: { kind, file: path, line, ...item } as Item })
    }
    // catalog hits of one record: the first matching line per entry
    const hitLines = (line: number, texts: string[]): void => {
      const seen = new Set<string>()
      for (const t of texts) {
        let pos = 0
        while (pos < t.length) {
          let e = t.indexOf('\n', pos)
          if (e === -1) e = t.length
          const l = t.slice(pos, Math.min(e, pos + LINE_CAP))
          pos = e + 1
          if (isQuotedLiteral(l)) continue
          for (const id of matchLine(l, catalog)) {
            if (seen.has(id)) continue
            seen.add(id)
            hits.push({ fileIdx, line, seq: seq++, id, quote: quoteOf(l) })
          }
        }
      }
    }

    let text: string
    try {
      text = readFileSync(join(proj, path), 'utf8')
    } catch {
      files.push({ path, lines: 0 })
      return
    }
    let lineNo = 0
    let pos = 0
    while (pos < text.length) {
      let e = text.indexOf('\n', pos)
      if (e === -1) e = text.length
      const raw = text.slice(pos, e)
      pos = e + 1
      lineNo++
      if (!/\S/.test(raw)) continue
      let rec: unknown
      try {
        rec = JSON.parse(raw)
      } catch {
        skippedJson++
        continue
      }
      if (!isObj(rec)) {
        skippedJson++
        continue
      }
      const ts = isStr(rec.timestamp) ? rec.timestamp : null
      if (!isMain && ts !== null && Number.isFinite(Date.parse(ts))) {
        const t = times.get(path)
        if (t === undefined) times.set(path, { first: ts, last: ts })
        else t.last = ts
      }
      const type = isStr(rec.type) ? rec.type : NO_TYPE
      if (!readTypes.includes(type)) {
        skippedTypes.set(type, (skippedTypes.get(type) ?? 0) + 1)
        continue
      }
      const agent = isMain ? 'main' : nonEmpty(rec.agentId) ? rec.agentId : fileAgent
      const line = lineNo

      if (isJournal) {
        if (type === 'started') {
          if (nonEmpty(rec.agentId)) pending.push({ fileIdx, seq: seq++, line, agent: rec.agentId, label: isStr(rec.label) ? rec.label : '', ts, dir: dirname(path) })
        } else if (type === 'result') {
          const res = rec.result
          const cands = isStr(res) ? [res] : isObj(res) ? [res.text, res.report].filter(isStr) : []
          // a result's own marker or stop.tag names the stop; its text only supplies the quote
          const tags = isObj(res) ? [res.marker, isObj(res.stop) ? res.stop.tag : undefined] : []
          const tag = tags.find((t): t is string => t === 'BLOCKED' || t === 'CHECKPOINT' || t === 'QUESTION')
          if (tag !== undefined) {
            const t = isObj(res) && isStr(res.text) ? res.text : ''
            add('stop', line, { agent, ts, quote: firstLine(t), marker: tag })
          } else {
            for (const c of cands) {
              const s = stopOf(c)
              if (s !== null) {
                add('stop', line, { agent, ts, quote: s.quote, marker: s.marker })
                break
              }
            }
          }
          const fail = cands.find(c => hasLine(c, 'VERDICT: FAIL'))
          if (fail !== undefined) add('qcFail', line, { agent, ts, quote: 'VERDICT: FAIL' })
          hitLines(line, stringsIn(res))
        }
        continue
      }

      const message = rec.message
      const content = isObj(message) ? message.content : undefined
      if (!Array.isArray(content)) continue

      if (type === 'assistant') {
        const texts: string[] = []
        for (const b of content) {
          if (!isObj(b)) continue
          if (b.type === 'tool_use') {
            const name = isStr(b.name) ? b.name : null
            const input = isObj(b.input) ? b.input : {}
            const id = isStr(b.id) ? b.id : null
            const command = name === 'Bash' && isStr(input.command) ? input.command : null
            // a result that only shows a file or search (Read, Grep, Glob, a command naming the catalog) is not the run hitting the problem
            if (id !== null && (name === 'Read' || name === 'Grep' || name === 'Glob' || (command !== null && (command.includes('catalog.json') || showsOnly(command))))) quiet.add(id)
            if (id !== null) tools.set(id,{ name, command: command !== null && command.includes('factory.ts') ? command : null })
            if (command !== null && !(id !== null && seenRunIds.has(id))) {
              if (id !== null) seenRunIds.add(id)
              const list = runs.get(command)
              const run = { id, line, ts, agent }
              if (list === undefined) runs.set(command, [run])
              else list.push(run)
            }
            if (isMain && name !== null && EDIT_TOOLS.has(name)) {
              const p = nonEmpty(input.file_path) ? input.file_path : nonEmpty(input.notebook_path) ? input.notebook_path : null
              if (p !== null && !p.includes('/.git/truss/') && !isNoteFile(p)) add('handEdit', line, { agent: 'main', ts, quote: quoteOf(p), tool: name, path: p })
            }
          } else if (b.type === 'text' && isStr(b.text)) texts.push(b.text)
        }
        if (texts.length > 0) {
          if (texts.some(t => hasLine(t, 'VERDICT: FAIL'))) add('qcFail', line, { agent, ts, quote: 'VERDICT: FAIL' })
          if (!isMain) lastText = { line, ts, agent, text: texts.join('\n') }
        }
      } else if (type === 'user') {
        const resultTexts: string[] = []
        for (const b of content) {
          if (!isObj(b) || b.type !== 'tool_result') continue
          const parts = partsOf(b.content)
          if (!(isStr(b.tool_use_id) && quiet.has(b.tool_use_id))) for (const p of parts) resultTexts.push(p)
          if (b.is_error !== true) continue
          const id = isStr(b.tool_use_id) ? b.tool_use_id : null
          if (id !== null) errored.add(id)
          const tool = id !== null ? tools.get(id) : undefined
          const name = tool?.name ?? null
          const body = parts.length === 1 ? parts[0] : parts.join('\n')
          const quote = firstLine(body)
          const refused = refusalOf({ isError: true, text: body })
          if (refused !== undefined) {
            add('refusal', line, { agent, ts, quote, tool: name, source: refused.source, category: refused.category })
            continue
          }
          const fm = tool?.command != null ? FACTORY_CMD.exec(tool.command) : null
          if (fm !== null && factoryBody(body)) {
            add('refusal', line, { agent, ts, quote, tool: name, source: 'factory', category: fm[1] })
            continue
          }
          add('toolError', line, { agent, ts, quote: errorQuote(body), tool: name })
          if (name === 'Bash') {
            const traces: string[] = []
            const scan = body.slice(0, TRACE_SCAN)
            for (const m of scan.matchAll(TRACE)) {
              let from = m.index
              while (from > 0 && PATH_CHAR.test(scan[from - 1])) from--
              if (from === m.index) continue // no file name before the extension
              const trace = scan.slice(from, m.index + m[0].length)
              if (!traces.includes(trace)) traces.push(trace)
              if (traces.length === 10) break
            }
            if (traces.length > 0) add('checkFail', line, { agent, ts, quote, traces })
          }
        }
        if (resultTexts.length > 0) hitLines(line, resultTexts)
      }
    }

    for (const [command, list] of runs) {
      if (list.length < 2) continue
      const first = list[0]
      add('repeat', first.line, {
        agent: first.agent,
        ts: first.ts,
        quote: firstLine(command),
        count: list.length,
        lines: list.map(r => r.line),
        retried: list.slice(0, -1).some(r => r.id !== null && errored.has(r.id)),
      })
    }
    if (lastText !== null) {
      const s = stopOf(lastText.text)
      if (s !== null) add('stop', lastText.line, { agent: lastText.agent, ts: lastText.ts, quote: s.quote, marker: s.marker })
    }
    files.push({ path, lines: lineNo })
  })

  for (const p of pending) {
    const t = times.get(`${p.dir}/agent-${p.agent}.jsonl`)
    const a = t === undefined ? NaN : Date.parse(t.first)
    const b = t === undefined ? NaN : Date.parse(t.last)
    const ms = Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, b - a) : null
    slots.push({
      fileIdx: p.fileIdx,
      line: p.line,
      kind: KINDS.indexOf('step'),
      seq: p.seq,
      item: { kind: 'step', file: paths[p.fileIdx], line: p.line, agent: p.agent, ts: p.ts, quote: quoteOf(p.label), label: p.label, start: t?.first ?? null, end: t?.last ?? null, ms },
    })
  }

  slots.sort((x, y) => x.fileIdx - y.fileIdx || x.line - y.line || x.kind - y.kind || x.seq - y.seq)
  hits.sort((x, y) => x.fileIdx - y.fileIdx || x.line - y.line || x.seq - y.seq)
  const types = [...skippedTypes.keys()].sort()
  return {
    v: 1,
    session: sid,
    files,
    items: slots.map(s => s.item),
    catalogHits: hits.map(h => ({ id: h.id, file: paths[h.fileIdx], line: h.line, quote: h.quote })),
    skipped: { json: skippedJson, type: Object.fromEntries(types.map(k => [k, skippedTypes.get(k)])) },
  }
}

/** True when every pipeline segment of a command only shows text (a diff, a log, a search, a file or its head or tail), so its result quotes text rather than running anything. */
function showsOnly(command: string): boolean {
  const segs = command.split(/\|\|?|&&|;/).map(s => s.trim())
  if (segs.length === 0) return false
  return segs.every(seg => {
    const w = seg.split(/\s+/)
    switch (w[0]) {
      case 'git':
        return w[1] === 'diff' || w[1] === 'show' || (w[1] === 'log' && w.some(x => x === '-p' || x === '--patch'))
      case 'gh':
        return w[1] === 'pr' && (w[2] === 'diff' || w[2] === 'view')
      case 'sed':
        return w[1] === '-n'
      case 'grep':
      case 'rg':
      case 'cat':
      case 'head':
      case 'tail':
        return true
      default:
        return false
    }
  })
}

/** An errored result of a factory.ts command that exited 1 with a JSON body: `Exit code 1`, then the body. */
function factoryBody(body: string): boolean {
  const m = /^\s*Exit code 1\s*\n/.exec(body.slice(0, 200))
  if (m === null) return false
  const rest = body.slice(m[0].length).trim()
  if (!rest.startsWith('{') || rest.length > FACTORY_JSON_MAX) return rest.startsWith('{') && rest.endsWith('}')
  try {
    return isObj(JSON.parse(rest))
  } catch {
    return false
  }
}

/** Write the extract whole to <truss dir>/retro/extract.json and return that path. */
export function writeExtract(trussDir: string, x: Extract): string {
  const dir = join(trussDir, 'retro')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, 'extract.json')
  writeFileSync(out, JSON.stringify(x, null, 2) + '\n')
  return out
}
