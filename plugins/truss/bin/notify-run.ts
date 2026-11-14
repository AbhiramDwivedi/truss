// Runs the client-owned `notify` command of .claude/truss.json for one new inbox item (contract-025 section 3, notify steps 2-5).
// stdin: {repo, row} (the open op plus code). Exit 0 when the command exits 0 within 10 s; else exit 1 with one {error} JSON line.
// The command is the one place a shell is used. Imports node: builtins and relative paths only, and never factory.ts.

import { spawn, spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { configOf } from './core.ts'

type Ops = {
  spawnSync: (cmd: string, args: string[], opts: Record<string, unknown>) => unknown
  kill: (pid: number, signal: string) => unknown
  /** The direct children of `pid` from /proc (linux); undefined when /proc has no answer. Optional: the real one is used when absent. */
  procChildren?: (pid: number) => number[] | undefined
}

/** The direct children of `pid` from /proc/<pid>/task/<tid>/children; undefined when the file is not readable (no /proc, or a kernel without it). */
function procChildren(pid: number): number[] | undefined {
  try {
    const out: number[] = []
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      for (const w of readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').split(/\s+/)) if (w !== '') out.push(Number(w))
    }
    return out
  } catch {
    return undefined
  }
}

/** The descendants of `pid`, level by level (a setsid child leaves the group, so the group kill misses it): from /proc on linux, else `pgrep -P`. A missing walk tool gives what was found so far. */
function descendants(pid: number, ops: Ops, platform: string = process.platform): number[] {
  const found: number[] = []
  const queue = [pid]
  const viaProc = platform === 'linux' ? (ops.procChildren ?? procChildren) : undefined
  while (queue.length > 0 && found.length < 1000) {
    const parent = queue.shift() as number
    let out = ''
    try {
      const kids = viaProc === undefined ? undefined : viaProc(parent)
      if (kids !== undefined) out = kids.join('\n')
      else {
      const r = ops.spawnSync('pgrep', ['-P', String(parent)], { windowsHide: true, encoding: 'utf8' }) as { error?: unknown; stdout?: unknown } | null
      if (r === null || r === undefined || r.error !== undefined) return found
      out = String(r.stdout ?? '')
      }
    } catch {
      return found
    }
    for (const line of out.split('\n')) {
      const n = Number(line.trim())
      if (Number.isInteger(n) && n > 0 && n !== pid && !found.includes(n)) (found.push(n), queue.push(n))
    }
  }
  return found
}

/** Kills the process `pid` and its whole tree: taskkill /T /F on win32, else the descendants (walked from /proc on linux, with pgrep -P elsewhere) and the process group (the child is detached, so it leads one). */
export function killTree(pid: number, platform: string = process.platform, ops: Ops): void {
  if (platform === 'win32') return void ops.spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true })
  // walk first: killing the parent first would reparent its children out of reach
  const kids = descendants(pid, ops, platform)
  for (const k of kids) {
    try { ops.kill(k, 'SIGKILL') } catch { /* already gone */ }
  }
  ops.kill(-pid, 'SIGKILL')
}

/** The environment of the notify command. The title is left out on win32: cmd.exe expands %VAR% before it parses the command. */
export function notifyEnv(row: Record<string, any>, repo: string, platform: string = process.platform, base: Record<string, string | undefined>): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, TRUSS_INBOX_ID: String(row.id), TRUSS_INBOX_KIND: String(row.kind), TRUSS_INBOX_REPO: repo }
  if (platform !== 'win32') env.TRUSS_INBOX_TITLE = String(row.title ?? '')
  return env
}

const fail = (error: string): never => {
  process.stdout.write(JSON.stringify({ error: error.slice(0, 200) }) + '\n')
  process.exit(1)
}

async function readStdin(): Promise<string> {
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk
  return text
}

async function main(): Promise<void> {
  let repo: string
  let row: Record<string, any>
  try {
    const j = JSON.parse(await readStdin())
    repo = String(j.repo)
    row = j.row
    if (typeof row !== 'object' || row === null) throw new Error('no row')
  } catch {
    return fail('notify-run needs {repo, row} on stdin')
  }
  let cmd: unknown
  try {
    cmd = configOf(repo).notify
  } catch (e) {
    return fail(`cannot read truss.json: ${(e as Error).message}`)
  }
  if (typeof cmd !== 'string' || cmd === '') return fail('no notify command')
  // TRUSS_TEST_NOTIFY_STDERR=inherit is a test seam (inbox.check.ts, the pipe-close proof of the tree kill): the notify command's stderr is
  // then notify-run's own, so a pipe the test holds closes only when every process of the tree has exited. Unset, stderr is ignored.
  const errStdio = process.env.TRUSS_TEST_NOTIFY_STDERR === 'inherit' ? 'inherit' : 'ignore'
  const child = spawn(cmd, { shell: true, detached: true, stdio: ['pipe', 'ignore', errStdio], windowsHide: true, env: notifyEnv(row, repo, process.platform, process.env) as NodeJS.ProcessEnv })
  const pid = child.pid
  const done = new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      // ESRCH: the process may have exited already; there is nothing left to kill.
      try { if (pid !== undefined) killTree(pid, process.platform, { spawnSync, kill: (p, s) => process.kill(p, s as NodeJS.Signals) }) } catch {}
      resolve('notify timed out after 10 s')
    }, 10000)
    child.on('error', (e) => (clearTimeout(timer), resolve(`notify did not start: ${e.message}`)))
    child.on('exit', (code, signal) => (clearTimeout(timer), resolve(code === 0 ? null : `notify exited ${code ?? signal}`)))
  })
  child.stdin?.on('error', () => {})
  child.stdin?.end(JSON.stringify(row))
  const error = await done
  if (error !== null) return fail(error)
  process.exit(0)
}

// import.meta.main needs Node 24.2+; the realpath argv[1] check is the one factory.ts uses and works on 24.0 and 24.1.
const isMain = (): boolean => {
  try {
    return process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href
  } catch {
    return false
  }
}
if (isMain()) await main()
