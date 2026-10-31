// The jsonl reader of ui-state (ADR-0011 Decision 4, "Reading" and "Rolling").
// One reader follows one family of files in the Truss dir: events.jsonl with its rolled
// events.<n>.jsonl, or messages.jsonl with messages.<n>.jsonl. It keeps a byte offset per file
// and a line count, reads to the last newline (a partial last line waits), and never writes.
// Node built-ins only; erasable TypeScript.
import fs from 'node:fs'
import path from 'node:path'

export type SkipReason = 'json' | 'version'

export interface JsonlReader {
  // Reads what is new in the family. Returns true when it consumed any line.
  poll(): boolean
}

// Called with each line that parsed to a JSON object. Return 'version' to have the line recorded as skipped.
export type OnObject = (obj: Record<string, unknown>, file: string, line: number) => 'version' | undefined
export type OnSkip = (file: string, line: number, reason: SkipReason) => void

interface FileState {
  offset: number // bytes consumed: up to and including the last newline read
  lines: number // lines consumed
  dup: boolean // a rolled file equal to the newest older rolled file: never read
  stale: string | null // live file only: its signature while it still holds a copy that is already rolled
}

const CHUNK = 8 * 1024 * 1024

function statOf(p: string): fs.Stats | null {
  try {
    const s = fs.statSync(p)
    return s.isFile() ? s : null
  } catch {
    return null
  }
}

function sigOf(s: fs.Stats): string {
  return `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`
}

function sameBytes(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a)
    const sb = fs.statSync(b)
    if (sa.size !== sb.size) return false
    return fs.readFileSync(a).equals(fs.readFileSync(b))
  } catch {
    return false
  }
}

export function createJsonlReader(dir: string, prefix: 'events' | 'messages', onObject: OnObject, onSkip: OnSkip): JsonlReader {
  const rolledRe = new RegExp(`^${prefix}\\.(\\d+)\\.jsonl$`)
  const liveName = `${prefix}.jsonl`
  const livePath = path.join(dir, liveName)
  const files = new Map<string, FileState>()
  const live: FileState = { offset: 0, lines: 0, dup: false, stale: null }
  files.set(liveName, live)
  let started = false

  function handle(text: string, name: string, state: FileState): void {
    const lines = text.split('\n')
    lines.pop() // the text ends with \n, so the last piece is empty
    for (const raw of lines) {
      state.lines++
      const t = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (t.trim() === '') continue
      let v: unknown
      try {
        v = JSON.parse(t)
      } catch {
        onSkip(name, state.lines, 'json')
        continue
      }
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        onSkip(name, state.lines, 'json')
        continue
      }
      if (onObject(v as Record<string, unknown>, name, state.lines) === 'version') onSkip(name, state.lines, 'version')
    }
  }

  // Reads from state.offset to the last newline on disk. A file that shrank below the offset is a torn
  // rewrite (or a roll not seen yet): it waits for the next poll and resets nothing.
  function readNew(name: string, state: FileState): boolean {
    const p = path.join(dir, name)
    const st = statOf(p)
    if (st === null || st.size <= state.offset) return false
    let fd: number
    try {
      fd = fs.openSync(p, 'r')
    } catch {
      return false
    }
    let any = false
    try {
      let cap = CHUNK
      while (state.offset < st.size) {
        const len = Math.min(st.size - state.offset, cap)
        const buf = Buffer.allocUnsafe(len)
        let got = 0
        while (got < len) {
          const n = fs.readSync(fd, buf, got, len - got, state.offset + got)
          if (n === 0) break
          got += n
        }
        const nl = buf.subarray(0, got).lastIndexOf(10)
        if (nl < 0) {
          if (got < len || state.offset + len >= st.size) break // a partial last line: it waits
          cap *= 2 // one line longer than the chunk
          continue
        }
        cap = CHUNK
        const text = buf.toString('utf8', 0, nl + 1)
        state.offset += nl + 1
        handle(text, name, state)
        any = true
      }
    } catch {
      // a read that fails waits for the next poll
    } finally {
      try {
        fs.closeSync(fd)
      } catch {
        // nothing left to do
      }
    }
    return any
  }

  function poll(): boolean {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      return false
    }
    const rolled: { name: string; n: number }[] = []
    for (const f of names) {
      const m = rolledRe.exec(f)
      if (m !== null) rolled.push({ name: f, n: Number(m[1]) })
    }
    rolled.sort((a, b) => a.n - b.n)
    for (const name of [...files.keys()]) if (name !== liveName && !rolled.some((r) => r.name === name)) files.delete(name)

    let lastNew: string | null = null
    for (const r of rolled) if (!files.has(r.name)) lastNew = r.name

    let any = false
    rolled.forEach((r, i) => {
      let st = files.get(r.name)
      const rp = path.join(dir, r.name)
      if (st === undefined) {
        const older = i > 0 ? rolled[i - 1].name : null
        const dup = older !== null && sameBytes(path.join(dir, older), rp)
        st = { offset: 0, lines: 0, dup, stale: null }
        files.set(r.name, st)
        if (!dup && started && r.name === lastNew) {
          // The hooks copied the live file here and start it over: this file holds what the live file held,
          // so it takes over the live file's offset, and the live file is read from 0.
          st.offset = live.offset
          st.lines = live.lines
          live.offset = 0
          live.lines = 0
          live.stale = null
          const ls = statOf(livePath)
          if (ls !== null && ls.size > 0 && sameBytes(livePath, rp)) live.stale = sigOf(ls) // the rewrite hasn't landed yet
        }
      }
      if (!st.dup && readNew(r.name, st)) any = true
    })

    if (!started) {
      // A live file equal to the newest rolled file is the copy a failed rewrite left behind: already read.
      let newest: string | null = null
      for (const r of rolled) if (!files.get(r.name)!.dup) newest = r.name
      const ls = statOf(livePath)
      if (newest !== null && ls !== null && ls.size > 0 && sameBytes(livePath, path.join(dir, newest))) live.stale = sigOf(ls)
    }
    started = true

    if (live.stale !== null) {
      const ls = statOf(livePath)
      if (ls !== null && sigOf(ls) === live.stale) return any
      live.stale = null
    }
    if (readNew(liveName, live)) any = true
    return any
  }

  return { poll }
}
