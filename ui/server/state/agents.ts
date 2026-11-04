// ADR-0028 section 6: what each plugin agent is for. Reads <pluginPath>/agents/*.md once and keeps the first
// sentence of each file's `description:` line, by agent name. Reads only (R-9); a missing dir or file gives nothing.
// Node built-ins only; erasable TypeScript.
import fs from 'node:fs'
import path from 'node:path'

export type Purposes = ReadonlyMap<string, string>

const MAX = 300

// The first sentence: up to the first ". " (or the end), with the period kept.
function firstSentence(text: string): string | null {
  let t = text.trim()
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) t = t.slice(1, -1).trim()
  if (t === '') return null
  const m = /^.*?[.!?](?=\s|$)/s.exec(t)
  const s = (m === null ? t : m[0]).trim()
  return s.length > MAX ? s.slice(0, MAX - 1).trimEnd() + '…' : s
}

export function readPurposes(pluginPath: string | undefined): Purposes {
  const out = new Map<string, string>()
  if (pluginPath === undefined) return out
  const dir = path.join(pluginPath, 'agents')
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return out
  }
  for (const f of names) {
    if (!f.endsWith('.md')) continue
    try {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)
      if (lines[0] !== '---') continue
      for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
        const m = /^description:\s*(.*)$/.exec(lines[i])
        if (m === null) continue
        const s = firstSentence(m[1])
        if (s !== null) out.set(f.slice(0, -3), s)
        break
      }
    } catch {
      // an unreadable file gives no purpose
    }
  }
  return out
}

// The agent file name for a member: workflow-crew and a crew's foreman are `foreman`; truss:<name> is <name>.
export function purposeOf(purposes: Purposes, type: string | null, isForeman: boolean): string | null {
  if (isForeman || type === 'workflow-crew') return purposes.get('foreman') ?? null
  if (type === null || !type.startsWith('truss:')) return null
  return purposes.get(type.slice('truss:'.length)) ?? null
}
