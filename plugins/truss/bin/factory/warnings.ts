// The warnings start adds: member, stress and role-file changes since the session started, and the session start time.
// Moved unchanged from bin/factory.ts (0.31.0 item 5). Never imports factory.ts, whose top-level await would make an import
// cycle.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { isObj } from '../core.ts'
import type { Obj } from '../core.ts'
import { READ_ONLY_HOST } from './personas.ts'
import { PLUGIN, run } from './cli.ts'
import { goalSections } from './start.ts'
import type { Members, StartCtx } from './start.ts'

// ADR-0026 item 49 (b): <truss dir>/agent-warnings.json maps each agent file a newer-than-session warning named (absolute
// path) to the sha256 of its content then. A file whose content still has that hash warns no more; a new hash warns again.
// `seen` is the record as this call found it, `now` what this call warned; every crew of one call still gets its warning.
// The file is per session and cheap to drop: a missing or bad one is an empty record, and a failed write only repeats warnings.
type Warned = { seen: Record<string, string>; now: Record<string, string> }
const WARNED_FILE = (dir: string): string => `${dir}/agent-warnings.json`
export function loadWarned(dir: string): Warned {
  const seen: Record<string, string> = {}
  try {
    const v = JSON.parse(readFileSync(WARNED_FILE(dir), 'utf8'))
    if (isObj(v)) for (const [k, h] of Object.entries(v)) if (typeof h === 'string') seen[k] = h
  } catch {
    // missing or bad: nothing warned yet
  }
  return { seen, now: {} }
}
export function saveWarned(dir: string, w: Warned): void {
  if (Object.keys(w.now).length === 0) return
  try {
    writeFileSync(WARNED_FILE(dir), JSON.stringify({ ...w.seen, ...w.now }, null, 2) + '\n')
  } catch {
    // the warnings repeat next start; nothing else depends on the record
  }
}
// The detail text for a newer-than-session warning about the plugin's agent file `file`, or null for no warning: the
// file is not newer than the session start, git shows it unchanged since then (item 49 (a)), or this content was warned before.
function newerDetail(file: string, changed: number, started: number, w: Warned): string | null {
  if (!(changed > started)) return null
  const detail = changeDetail(file, changed, started)
  if (detail === null) return null
  const key = `${PLUGIN}/${file}`
  let hash: string
  try {
    hash = createHash('sha256').update(readFileSync(key)).digest('hex')
  } catch {
    return detail
  }
  w.now[key] = hash
  return w.seen[key] === hash ? null : detail
}
// ADR-0026 item 50: without --model the ## Members model stands (ADR-0022 U6). One warning per crew whose ## Members model
// differs from its roles row, so the PM changes models the one supported way.
export function memberWarnings(c: StartCtx, entries: Obj[]): string[] {
  const out: string[] = []
  for (const e of entries) {
    const diff: string[] = []
    for (const role of ['tester', 'builder']) {
      const m = isObj(e.members) && isObj(e.members[role]) ? String(e.members[role].model) : undefined
      const r = isObj(c.roles[role]) && typeof c.roles[role].model === 'string' ? c.roles[role].model : undefined
      if (m !== undefined && r !== undefined && m !== r) diff.push(`${role} on ${m} (roles.${role}.model is ${r})`)
    }
    if (diff.length > 0) out.push(`crew ${String(e.slug)}'s ## Members runs the ${diff.join(' and the ')}; the ## Members model stands (ADR-0022 U6). To run another model, pass start --model <role>=<model> (repeatable, also on --resume), which sets both the roles row and the ## Members entry; never edit the args file`)
  }
  return out
}

// The start time of the session, in ms since the epoch, or undefined when it can't be read: TRUSS_SESSION_START (a test
// override), else the start time of the CLAUDE_PID process: on Linux /proc/<pid>/stat field 22 over the tick rate, plus btime;
// on macOS the elapsed time `ps -o etime= -p <pid>` (locale-free, 1 s resolution, so one more second is taken off); on Windows
// PowerShell's Get-Process start time as epoch ms. Only that one process is asked about, never a scan of the process table, and
// every command runs through an argument array, never a shell string. Unreadable is undefined, and the caller warns that it
// can't tell (the safe side: a restart prompt, never a silent pass).
// Never the /proc/<pid> inode mtime, never the transcript (--continue keeps the old one). A session-start hook was not used: it
// fires on clear and compact too, which do not reload agents, and the factory cannot tell which session wrote which stamp.
export type StartProbe = { exec: (file: string, args: string[]) => string | undefined; now: () => number }
const REAL_PROBE: StartProbe = {
  exec: (file, args) => {
    const r = spawnSync(file, args, { encoding: 'utf8', timeout: 8000, windowsHide: true })
    return r.error === undefined && r.status === 0 ? r.stdout : undefined
  },
  now: () => Date.now(),
}
// "[[dd-]hh:]mm:ss" as seconds, or undefined.
function etimeSeconds(text: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})$/.exec(text.trim())
  if (m === null) return undefined
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4])
}
export function sessionStart(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, probe: StartProbe = REAL_PROBE): number | undefined {
  const o = env.TRUSS_SESSION_START
  if (o !== undefined && o !== '') {
    const n = Number(o)
    return Number.isFinite(n) ? n : undefined
  }
  const pid = env.CLAUDE_PID
  if (pid === undefined || !/^\d+$/.test(pid)) return undefined
  if (platform === 'darwin') {
    const secs = etimeSeconds(probe.exec('ps', ['-o', 'etime=', '-p', pid]) ?? '')
    return secs === undefined ? undefined : probe.now() - (secs + 1) * 1000
  }
  if (platform === 'win32') {
    const script = `([DateTimeOffset](Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`
    for (const shell of ['powershell.exe', 'pwsh']) {
      const out = probe.exec(shell, ['-NoProfile', '-NonInteractive', '-Command', script])
      const n = /^\d{10,}$/.test((out ?? '').trim()) ? Number((out as string).trim()) : NaN
      if (Number.isFinite(n)) return n
    }
    return undefined
  }
  if (platform !== 'linux') return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // comm (field 2) may hold spaces and parentheses: count fields from after the last ")". Field 3 is the first after it.
    const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
    const ticks = Number(rest[22 - 3])
    const btime = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1])
    const hz = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim())
    if (!Number.isFinite(ticks) || !Number.isFinite(btime) || !(hz > 0) || rest.length < 20) return undefined
    return (btime + ticks / hz) * 1000
  } catch {
    return undefined
  }
}
// sessionStart, asked once per process for the same inputs: a Windows probe can launch PowerShell twice at 8 s each, and one
// start asks for it in buildPersonas, roleWarnings and stressWarnings. An unreadable start is memoised too.
const SESSION_START_MEMO = new Map<string, number | undefined>()
export function sessionStartOnce(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, probe: StartProbe = REAL_PROBE): number | undefined {
  const key = `${platform}|${env.CLAUDE_PID ?? ''}|${env.TRUSS_SESSION_START ?? ''}`
  if (!SESSION_START_MEMO.has(key)) SESSION_START_MEMO.set(key, sessionStart(env, platform, probe))
  return SESSION_START_MEMO.get(key)
}
// One warning per crew starting now whose goal file says `## Stress test` yes, when the stress role's agent file changed after
// the session loaded its agents. Warnings never hold or refuse a crew.
export function stressWarnings(c: StartCtx, slugs: string[], w: Warned): string[] {
  const out: string[] = []
  let started: number | undefined
  let read = false
  for (const slug of slugs) {
    const goalFile = `${c.dir}/goals/${slug}.md`
    if (!existsSync(goalFile) || !/^(yes|true)\b/i.test(goalSections(readFileSync(goalFile, 'utf8'))['Stress test'] ?? '')) continue
    if (!read) {
      read = true
      started = sessionStartOnce()
    }
    const type = String((isObj(c.roles.stress) ? c.roles.stress.agentType : undefined) ?? 'truss:stress-engineer')
    let changed: number | undefined
    try {
      changed = statSync(`${PLUGIN}/agents/${type.replace(/^[^:]*:/, '')}.md`).mtimeMs
    } catch {
      changed = undefined
    }
    if (changed === undefined || started === undefined) {
      out.push(`crew ${slug} runs ${type}, but I can't tell whether its agent file changed after this session loaded its agents; restart the session if it did`)
      continue
    }
    const detail = newerDetail(`agents/${type.replace(/^[^:]*:/, '')}.md`, changed, started, w)
    if (detail !== null) out.push(`crew ${slug} runs ${type}, but the role's agent file changed after this session loaded its agents (${detail}); restart the session to load it`)
  }
  return out
}
// ADR-0025 item 41: what changed in the plugin's agent file `file` (relative to PLUGIN) since the session start, for the
// newer-than-session warnings. In a git work tree with a commit before the session start: the lines added and removed since
// that commit (working tree included) and the newest commit after it that touched the file, or `uncommitted`. Else the
// file's mtime and the session start as ISO times. Read-only git only.
// ADR-0026 item 49 (a): an empty numstat (the file holds its session-start content again, reverted or restored) is null,
// no change and so no warning.
function changeDetail(file: string, mtime: number, started: number): string | null {
  const fallback = `mtime ${new Date(mtime).toISOString()}, session start ${new Date(started).toISOString()}`
  try {
    if (run(PLUGIN, ['rev-parse', '--is-inside-work-tree']).out !== 'true') return fallback
    // First-parent only: a --no-ff merge after the session start of a crew commit dated before it must not become the base.
    const base = run(PLUGIN, ['rev-list', '-1', '--first-parent', `--before=${new Date(started).toISOString()}`, 'HEAD'])
    if (base.status !== 0 || base.out === '') return fallback
    const ns = run(PLUGIN, ['diff', '--numstat', base.out, '--', file])
    if (ns.status === 0 && ns.out === '') return null
    const m = /^(\d+)\t(\d+)\t/.exec(ns.out)
    if (ns.status !== 0 || m === null) return fallback
    const last = run(PLUGIN, ['log', '-1', '--format=%h %s', `${base.out}..HEAD`, '--', file])
    const commit = last.status === 0 && last.out !== '' ? `last commit ${last.out}` : 'uncommitted'
    return `${m[1]} added, ${m[2]} removed since the session start, ${commit}`
  } catch {
    return fallback
  }
}
// ADR-0024 item 24: one warning per truss:* agent type the stage workflow spawns for a starting workflow crew, besides stress
// (stressWarnings keeps its own texts): planner, qc and writer, tester and builder when their type is truss:*, and ux when the
// entry is ux. Never designer or checker, which the stage workflow does not spawn. A type warns when its agent file is missing,
// is newer than the session start, or the session start can't be read; each warning names both fallbacks.
export function roleWarnings(c: StartCtx, entries: Obj[], w: Warned, personas: Obj = {}): string[] {
  const out: string[] = []
  let started: number | undefined
  let read = false
  for (const e of entries) {
    const slug = String(e.slug)
    const roles = ['planner', 'qc', 'writer', 'tester', 'builder', ...(e.ux === true ? ['ux'] : [])]
    for (const role of roles) {
      const type = isObj(c.roles[role]) && typeof c.roles[role].agentType === 'string' ? String(c.roles[role].agentType) : ''
      if (!type.startsWith('truss:')) continue
      if (!read) {
        read = true
        started = sessionStartOnce()
      }
      const file = `agents/${type.slice('truss:'.length)}.md`
      let changed: number | undefined
      try {
        changed = statSync(`${PLUGIN}/${file}`).mtimeMs
      } catch {
        changed = undefined
      }
      const fallback = `or resume with roles.${role}.agentType set to general-purpose and an answer telling the agent to read ${file} and follow it`
      if (changed === undefined) out.push(`crew ${slug} runs ${type} as its ${role}, but its agent file ${file} is missing; restart the session once it is back, ${fallback}`)
      else if (started === undefined) out.push(`crew ${slug} runs ${type} as its ${role}, but I can't tell whether ${file} changed after this session loaded its agents; restart the session if it did, ${fallback}`)
      else {
        const detail = newerDetail(file, changed, started, w)
        if (detail !== null) out.push(`crew ${slug} runs ${type} as its ${role}, but ${file} changed after this session loaded its agents (${detail}); restart the session to load it, ${fallback}`)
      }
    }
  }
  // The judge host is no role, but plan.js and stage.js spawn truss:judge for every inlined read-only persona: a session that loaded
  // its agents before agents/judge.md existed has no such type, and the spawn would fail mid-run. Only a project with such a persona is warned.
  if (entries.length > 0 && Object.values(personas).some((p) => isObj(p) && p.readOnly === true)) {
    if (!read) started = sessionStartOnce()
    const file = `agents/${READ_ONLY_HOST.slice('truss:'.length)}.md`
    let changed: number | undefined
    try {
      changed = statSync(`${PLUGIN}/${file}`).mtimeMs
    } catch {
      changed = undefined
    }
    const slugs = entries.map((e) => String(e.slug)).join(', ')
    const fallback = 'read-only personas cannot be judged until it is loaded'
    if (changed === undefined) out.push(`crews ${slugs} may judge with ${READ_ONLY_HOST}, but its agent file ${file} is missing; restart the session once it is back, ${fallback}`)
    else if (started === undefined) out.push(`crews ${slugs} may judge with ${READ_ONLY_HOST}, but I can't tell whether ${file} changed after this session loaded its agents; restart the session if it did, ${fallback}`)
    else {
      const detail = newerDetail(file, changed, started, w)
      if (detail !== null) out.push(`crews ${slugs} may judge with ${READ_ONLY_HOST}, but ${file} changed after this session loaded its agents (${detail}); restart the session to load it, ${fallback}`)
    }
  }
  return out
}
