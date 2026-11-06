// A member's task from its Claude Code workflow transcript (ADR-0029): the first non-empty line of the brief, read from
// the first line of <claudeDir>/projects/<projectKey>/<session id>/subagents/[workflows/<wf id>/]agent-<agentId>.jsonl.
// Read only: one open, at most CAP bytes, stop at the first newline, close. Never throws; any doubt gives null.
// Node built-ins only; erasable TypeScript.
import fs from 'node:fs'
import path from 'node:path'

const CAP = 128 * 1024
const MAX_TASK = 200
const MARKER = 'The computed task text follows:'

// A value that is one plain path segment: letters, digits, dot, dash, underscore; never . or ..
function plain(s: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..'
}

export function projectKeyOf(repo: string): string {
  return repo.replace(/[^A-Za-z0-9]/g, '-')
}

function firstLine(file: string): string | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(CAP)
    let n = 0
    while (n < CAP) {
      const got = fs.readSync(fd, buf, n, CAP - n, n)
      if (got === 0) break
      n += got
      const nl = buf.subarray(0, n).indexOf(0x0a)
      if (nl >= 0) return buf.subarray(0, nl).toString('utf8')
    }
    return n < CAP ? buf.subarray(0, n).toString('utf8') : null // no newline within the cap: not a line we trust
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // nothing left to do
      }
    }
  }
}

export function taskFromLine(line: string): string | null {
  try {
    const o = JSON.parse(line) as { message?: { content?: unknown } } | null
    const content = o !== null && typeof o === 'object' ? o.message?.content : undefined
    if (typeof content !== 'string') return null
    const at = content.indexOf(MARKER)
    if (at < 0) return null
    for (const l of content.slice(at + MARKER.length).split('\n')) {
      const t = l.trim()
      if (t !== '') return t.slice(0, MAX_TASK)
    }
    return null
  } catch {
    return null
  }
}

// The agent's transcript file (realpath, confined to the session dir) with `ext` swapped in: .jsonl or .meta.json.
// `by` is the spawn line's by value; workflow:<wf id> selects the workflow dir, anything else the top level.
function agentFile(sessionDir: string, agentId: string, by: string | null, ext: string): string | null {
  try {
    if (!plain(agentId)) return null
    let dir = path.join(sessionDir, 'subagents')
    if (by !== null && by.startsWith('workflow:')) {
      const wf = by.slice('workflow:'.length)
      if (!plain(wf)) return null
      dir = path.join(dir, 'workflows', wf)
    }
    const real = fs.realpathSync(path.join(dir, `agent-${agentId}${ext}`))
    const root = fs.realpathSync(sessionDir)
    return real.startsWith(root + path.sep) ? real : null
  } catch {
    return null
  }
}

// Claude Code's own description from agent-<id>.meta.json, unless it is a bare label (no whitespace).
function metaDescription(sessionDir: string, agentId: string, by: string | null): string | null {
  try {
    const real = agentFile(sessionDir, agentId, by, '.meta.json')
    if (real === null || fs.statSync(real).size > CAP) return null
    const o = JSON.parse(fs.readFileSync(real, 'utf8')) as { description?: unknown } | null
    const d = o !== null && typeof o === 'object' && typeof o.description === 'string' ? o.description.trim() : ''
    return d === '' || !/\s/.test(d) ? null : d.slice(0, MAX_TASK)
  } catch {
    return null
  }
}

// Chain after the spawn line's task: the meta description, then the first brief line.
export function readTranscriptTask(sessionDir: string, agentId: string, by: string | null): string | null {
  try {
    const meta = metaDescription(sessionDir, agentId, by)
    if (meta !== null) return meta
    const real = agentFile(sessionDir, agentId, by, '.jsonl')
    if (real === null) return null
    const line = firstLine(real)
    return line === null ? null : taskFromLine(line)
  } catch {
    return null
  }
}

const TAIL = 64 * 1024
const MAX_ACTIVITY = 120

function oneLine(s: string): string {
  return s.split('\n').find((l) => l.trim() !== '')?.trim() ?? ''
}

// `<Tool>: <short>` for a tool_use block, cut to MAX_ACTIVITY.
export function activityOf(name: string, input: unknown): string {
  const i = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const str = (k: string): string => (typeof i[k] === 'string' ? (i[k] as string) : '')
  let short = ''
  if (name === 'Bash') short = oneLine(str('description')) || oneLine(str('command'))
  else if (name === 'Read' || name === 'Edit' || name === 'Write') short = path.basename(str('file_path'))
  else if (name === 'Grep' || name === 'Glob') short = oneLine(str('pattern'))
  const out = short === '' ? name : `${name}: ${short}`
  return out.slice(0, MAX_ACTIVITY)
}

export function activityFromTail(text: string): string | null {
  const lines = text.split('\n')
  for (let k = lines.length - 1; k >= 0; k--) {
    const l = lines[k]!.trim()
    if (l === '') continue
    try {
      const o = JSON.parse(l) as { type?: unknown; message?: { content?: unknown } } | null
      const content = o?.message?.content
      if (o === null || typeof o !== 'object' || o.type !== 'assistant' || !Array.isArray(content)) continue
      for (let j = content.length - 1; j >= 0; j--) {
        const b = content[j] as { type?: unknown; name?: unknown; input?: unknown } | null
        if (b !== null && typeof b === 'object' && b.type === 'tool_use' && typeof b.name === 'string') return activityOf(b.name, b.input)
      }
    } catch {
      // a cut first line or a torn last line: skip it
    }
  }
  return null
}

export interface ActivityRead {
  sig: string
  value: string | null
}

// The latest tool call from the last TAIL bytes. `prev` is returned as is while size and mtime are unchanged.
export function readTranscriptActivity(sessionDir: string, agentId: string, by: string | null, prev?: ActivityRead): ActivityRead | null {
  let fd: number | null = null
  try {
    const real = agentFile(sessionDir, agentId, by, '.jsonl')
    if (real === null) return null
    const st = fs.statSync(real)
    const sig = `${st.size}:${st.mtimeMs}`
    if (prev !== undefined && prev.sig === sig) return prev
    fd = fs.openSync(real, 'r')
    const len = Math.min(st.size, TAIL)
    const buf = Buffer.alloc(len)
    let n = 0
    while (n < len) {
      const got = fs.readSync(fd, buf, n, len - n, st.size - len + n)
      if (got === 0) break
      n += got
    }
    return { sig, value: activityFromTail(buf.subarray(0, n).toString('utf8')) }
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // nothing left to do
      }
    }
  }
}
