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

// `by` is the spawn line's by value; workflow:<wf id> selects the workflow dir, anything else the top level.
export function readTranscriptTask(sessionDir: string, agentId: string, by: string | null): string | null {
  try {
    if (!plain(agentId)) return null
    let dir = path.join(sessionDir, 'subagents')
    if (by !== null && by.startsWith('workflow:')) {
      const wf = by.slice('workflow:'.length)
      if (!plain(wf)) return null
      dir = path.join(dir, 'workflows', wf)
    }
    const file = path.join(dir, `agent-${agentId}.jsonl`)
    const real = fs.realpathSync(file)
    const root = fs.realpathSync(sessionDir)
    if (!real.startsWith(root + path.sep)) return null
    const line = firstLine(real)
    return line === null ? null : taskFromLine(line)
  } catch {
    return null
  }
}
