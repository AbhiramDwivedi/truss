// A foreman's fallback task (ADR-0029): the first non-empty line after the `# Goal:` heading of <truss dir>/goals/<slug>.md.
// Read only: one open, at most 16 KiB. Never throws; any doubt gives null. Node built-ins only; erasable TypeScript.
import fs from 'node:fs'
import path from 'node:path'

const CAP = 16 * 1024
const MAX_TASK = 200

export function readGoalTask(trussDir: string, slug: string): string | null {
  if (slug === '' || slug === '.' || slug === '..' || /[/\\\0]/.test(slug)) return null
  let fd: number | null = null
  try {
    fd = fs.openSync(path.join(trussDir, 'goals', `${slug}.md`), 'r')
    const buf = Buffer.alloc(CAP)
    const n = fs.readSync(fd, buf, 0, CAP, 0)
    const lines = buf.subarray(0, n).toString('utf8').split('\n')
    const at = lines.findIndex((l) => l.startsWith('# Goal:'))
    if (at < 0) return null
    for (const l of lines.slice(at + 1)) {
      const t = l.trim()
      if (t !== '') return t.slice(0, MAX_TASK)
    }
    return null
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
