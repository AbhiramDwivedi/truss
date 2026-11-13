// Retiring worktrees and branches after finish: old member worktrees, the archive refs and the scratch dirs. Moved
// unchanged from bin/factory.ts (0.31.0 item 5). Never imports factory.ts, whose top-level await would make an import cycle.
import path from 'node:path'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { flat, parseLabel } from '../store.ts'
import { crewRunsOf, jsonLines, runOf, runsNextTo } from './runs.ts'
import { appendEvent, run } from './shared.ts'

// The git worktrees of the repo as {path, branch}.
export function worktreesOf(repo: string): { path: string; branch: string | undefined; locked: boolean }[] {
  const out: { path: string; branch: string | undefined; locked: boolean }[] = []
  for (const block of run(repo, ['worktree', 'list', '--porcelain']).out.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const p = lines.find((l) => l.startsWith('worktree '))
    if (p === undefined) continue
    const b = lines.find((l) => l.startsWith('branch '))
    out.push({ path: flat(p.slice('worktree '.length)), branch: b === undefined ? undefined : b.slice('branch refs/heads/'.length), locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')) })
  }
  return out
}

// Member worktrees of earlier runs: branch worktree-wf_<id>-<n>, path ending wf_<id>-<n>.
export const OLD_WF_BRANCH = /^worktree-wf_[\w.-]+-\d+$/
export const OLD_WF_PATH = /(^|\/)wf_[\w.-]+-\d+$/
export const OLD_WF_IDLE_MS = 3600000
function idleMs(p: string): number {
  try {
    return Date.now() - statSync(p).mtimeMs
  } catch {
    return 0
  }
}

// ADR-0030: retiring member worktrees. A branch whose commits the target lacks is kept as a ref under ARCHIVE_PREFIX/<run id>/<branch>
// before it is deleted; archive refs whose commit is older than ARCHIVE_KEEP_MS are pruned at finish.
export const ARCHIVE_PREFIX = 'refs/truss/archive'
export const ARCHIVE_KEEP_MS = 30 * 86400000
type Wt = { path: string; branch: string | undefined; locked: boolean }
export type RetireWhy = 'merged' | 'superseded' | 'dropped' | 'failed'
const within = (p: string, root: string): boolean => p === root || p.startsWith(`${root}/`)
const realOr = (p: string): string => {
  try {
    return flat(realpathSync(p))
  } catch {
    return flat(p)
  }
}

// The one scratch dir a truss agent may write untracked files to in its worktree (.plan-scratch/ is the legacy name). Both are
// listed in <git common dir>/info/exclude, so no project's .gitignore changes, and never count as work: retirement deletes them.
export const SCRATCH_DIRS = ['.truss-scratch', '.plan-scratch']
// Appends each scratch dir to the repo's info/exclude once; a failure is ignored (worktreeChanges still treats them as scratch).
export function excludeScratch(repo: string): void {
  try {
    const r = run(repo, ['rev-parse', '--git-common-dir'])
    if (r.status !== 0 || r.out === '') return
    const file = path.join(path.resolve(repo, r.out), 'info', 'exclude')
    const had = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const lines = had.replace(/\r/g, '').split('\n')
    const add = SCRATCH_DIRS.map((d) => `${d}/`).filter((l) => !lines.includes(l))
    if (add.length === 0) return
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${had}${had === '' || had.endsWith('\n') ? '' : '\n'}${add.join('\n')}\n`)
  } catch {
    // best effort
  }
}

// A worktree's `git status --porcelain` entries split in two: links are untracked symlinks that point into the main checkout but
// outside the worktree (the worktrees plugin links ui/node_modules that way), which are no work; real is everything else. Untracked
// entries under a scratch dir are neither.
export function worktreeChanges(wt: string, mainTop: string): { real: string[]; links: string[] } {
  const r = run(wt, ['status', '--porcelain', '-z', '--untracked-files=all'])
  const out = { real: [] as string[], links: [] as string[] }
  if (r.status !== 0) return { real: [r.err || 'git status failed'], links: [] }
  const top = realOr(mainTop)
  const self = realOr(wt)
  for (const e of r.out.split('\0').filter((x) => x !== '')) {
    const rel = e.slice(3)
    if (e.startsWith('?? ') && SCRATCH_DIRS.some((d) => rel === `${d}/` || rel.startsWith(`${d}/`))) continue
    if (e.startsWith('?? ')) {
      const full = `${wt}/${rel.replace(/\/$/, '')}`
      try {
        if (lstatSync(full).isSymbolicLink()) {
          const target = path.resolve(path.dirname(full), readlinkSync(full))
          // canonical parent, so a symlinked temp dir (macOS /var -> /private/var) compares equal to the realpath'd roots
          const to = `${realOr(path.dirname(target))}/${path.basename(target)}`
          if (within(to, top) && !within(to, self) && !within(to, flat(wt))) {
            out.links.push(full)
            continue
          }
        }
      } catch {
        // unreadable: counted as real
      }
    }
    out.real.push(rel === '' ? e : rel)
  }
  return out
}

export type RetireCtx = { dir: string; repo: string; target: string; mainTop: string }
// Retires one worktree and its branch, or says why it stays: locked or real changes. truss stops no process (ADR-0030 item 7):
// the PM's TaskStop of the finished agent or background shell stops what it left running. The main-checkout links are unlinked
// so git removes it without --force. A branch tip the target lacks is archived first. One retire event per retirement.
export function retireWorktree(x: RetireCtx, w: Wt, o: { crew: string; run: string; why: RetireWhy }): string | undefined {
  if (w.branch === undefined) return 'detached'
  if (w.locked) return 'locked'
  if (existsSync(w.path)) {
    const ch = worktreeChanges(w.path, x.mainTop)
    if (ch.real.length > 0) return 'dirty'
    for (const l of ch.links) {
      try {
        unlinkSync(l)
      } catch {
        // git remove reports it
      }
    }
    // scratch dirs go first: an excluded one git removes anyway, one not yet excluded would make `worktree remove` refuse
    for (const d of SCRATCH_DIRS) {
      if (!existsSync(path.join(w.path, d)) || run(w.path, ['ls-files', '--', `${d}/`]).out !== '') continue
      try {
        rmSync(path.join(w.path, d), { recursive: true, force: true })
      } catch {
        // git remove reports it
      }
    }
    if (run(x.repo, ['worktree', 'remove', w.path]).status !== 0) return 'dirty'
  } else run(x.repo, ['worktree', 'prune'])
  return retireBranch(x, w.branch, { ...o, worktree: w.path })
}
// Archives (when the target lacks its tip) and deletes one branch; undefined on success, else why it stays.
export function retireBranch(x: RetireCtx, branch: string, o: { crew: string; run: string; why: RetireWhy; worktree: string | null }): string | undefined {
  const tip = run(x.repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]).out
  if (tip === '') return 'no branch'
  const inTarget = run(x.repo, ['merge-base', '--is-ancestor', tip, `refs/heads/${x.target}`]).status === 0
  const archive = inTarget ? null : `${ARCHIVE_PREFIX}/${o.run}/${branch}`
  if (archive !== null && run(x.repo, ['update-ref', archive, tip]).status !== 0) return 'archive failed'
  if (run(x.repo, ['branch', '-D', branch]).status !== 0) return 'branch delete failed'
  const why = o.why === 'merged' && !inTarget ? 'superseded' : o.why
  appendEvent(x.dir, { event: 'retire', crew: o.crew, agent: branch, run: o.run, branch, worktree: o.worktree, reason: why, archive })
  return undefined
}
// Drops archive refs whose commit is older than ARCHIVE_KEEP_MS.
function pruneArchive(repo: string, now = Date.now()): void {
  const r = run(repo, ['for-each-ref', '--format=%(refname) %(committerdate:unix)', `${ARCHIVE_PREFIX}/`])
  if (r.status !== 0) return
  for (const l of r.out.split('\n')) {
    const [ref, at] = l.split(' ')
    if (ref !== undefined && ref !== '' && Number(at) * 1000 < now - ARCHIVE_KEEP_MS) run(repo, ['update-ref', '-d', ref])
  }
}

// The run dir of run id under the transcripts root, else under any session of the same project (<proj>/<session>/subagents/workflows/<id>).
function runDirFor(tdir: string, id: string): string | undefined {
  const root = path.dirname(tdir)
  if (existsSync(`${root}/${id}/journal.jsonl`)) return `${root}/${id}`
  const parts = root.split('/')
  if (parts.length < 4 || parts[parts.length - 1] !== 'workflows' || parts[parts.length - 2] !== 'subagents') return undefined
  const proj = parts.slice(0, -3).join('/')
  try {
    for (const s of readdirSync(proj)) if (existsSync(`${proj}/${s}/subagents/workflows/${id}/journal.jsonl`)) return `${proj}/${s}/subagents/workflows/${id}`
  } catch {
    // no project dir
  }
  return undefined
}
// Worktree basename -> crew slug for a run's agents, from the first cwd in each agent transcript (its first 64 KiB).
function ownersOf(runDir: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const a of runOf(runDir).agents) {
    const slug = parseLabel(a.label)?.slug
    if (slug === undefined || !existsSync(a.transcript)) continue
    let head = ''
    try {
      const fd = openSync(a.transcript, 'r')
      const buf = Buffer.alloc(65536)
      head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8')
      closeSync(fd)
    } catch {
      continue
    }
    const m = /"cwd":"([^"]+)"/.exec(head)
    if (m?.[1] !== undefined) out.set(path.basename(flat(m[1]).replace(/\/+$/, '')), slug)
  }
  return out
}

// ADR-0030: the finish sweep. Every wf_<run>-<n> member worktree (and branch with no worktree left) whose crew is terminal is retired:
// merged now (reason merged, or superseded when the target lacks its tip), dropped, or failed (rework allowance spent now). The crew
// is the one the run's agent transcript names for that worktree, else the run's only crew in the spawn events. Other member
// worktrees keep the 0.19.0 rule, run only when a crew merged: this run's own, or an older run's idle an hour, once merged and clean.
// A dropped crew's own worktree and branch truss-<slug> go too. Returns what stayed.
export function sweepMembers(x: RetireCtx, tdir: string, runId: string, terminal: Map<string, RetireWhy>, merged: string[]): { path: string; branch: string; why: string }[] {
  const left: { path: string; branch: string; why: string }[] = []
  const events = existsSync(`${x.dir}/events.jsonl`) ? jsonLines(`${x.dir}/events.jsonl`) : []
  const crewsOfRun = new Map<string, Set<string>>()
  for (const e of events) {
    if (e.event !== 'spawn' || typeof e.by !== 'string' || !e.by.startsWith('workflow:') || typeof e.crew !== 'string') continue
    const id = e.by.slice('workflow:'.length)
    if (!crewsOfRun.has(id)) crewsOfRun.set(id, new Set())
    crewsOfRun.get(id)?.add(e.crew)
  }
  // A run no finish recorded (one stopped and resumed by `start --resume` in a new run) still belongs to a terminal crew whose labels
  // it holds in this session's runs root: the runs `start --resume` rebuilds the crew from.
  const nextTo = terminal.size > 0 ? runsNextTo(tdir) : []
  for (const crew of terminal.keys()) {
    for (const r of crewRunsOf(nextTo, crew)) {
      if (!crewsOfRun.has(r.id)) crewsOfRun.set(r.id, new Set())
      crewsOfRun.get(r.id)?.add(crew)
    }
  }
  const owners = new Map<string, Map<string, string>>()
  const ownerOf = (id: string, base: string): string | undefined => {
    // only runs this truss dir recorded: another goal's run may use the same slug
    if (id !== runId && !crewsOfRun.has(id)) return undefined
    if (!owners.has(id)) {
      const d = runDirFor(tdir, id)
      owners.set(id, d === undefined ? new Map() : ownersOf(d))
    }
    const named = owners.get(id)?.get(base)
    if (named !== undefined) return named
    const only = crewsOfRun.get(id)
    return only !== undefined && only.size === 1 ? [...only][0] : undefined
  }
  const idRe = runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const branchRe = new RegExp(`^worktree-${idRe}-\\d+$`)
  const pathRe = new RegExp(`(^|/)${idRe}-\\d+$`)
  const memberRun = (branch: string): string | undefined => /^worktree-(.+)-\d+$/.exec(branch)?.[1]
  const checkedOut = new Set<string>()
  for (const w of worktreesOf(x.repo)) {
    if (w.branch === undefined) continue
    checkedOut.add(w.branch)
    const ours = branchRe.test(w.branch) && pathRe.test(w.path)
    const old = OLD_WF_BRANCH.test(w.branch) && OLD_WF_PATH.test(w.path)
    if (!ours && !old) continue
    const id = ours ? runId : (memberRun(w.branch) as string)
    if (!ours && path.basename(w.path) !== w.branch.slice('worktree-'.length)) continue
    const crew = ownerOf(id, path.basename(w.path))
    const why = crew === undefined ? undefined : terminal.get(crew)
    if (why !== undefined && crew !== undefined) {
      // an older run's member of a crew that is terminal now: that run is over for this crew, so no idle wait
      const kept = retireWorktree(x, w, { crew, run: id, why })
      if (kept !== undefined) left.push({ path: w.path, branch: w.branch, why: kept })
      continue
    }
    if (merged.length === 0 || (!ours && idleMs(w.path) < OLD_WF_IDLE_MS)) continue
    const isMerged = [...merged.map((s) => `truss-${s}`), x.target].some((b) => run(x.repo, ['merge-base', '--is-ancestor', `refs/heads/${w.branch}`, `refs/heads/${b}`]).status === 0)
    if (w.locked) left.push({ path: w.path, branch: w.branch, why: 'locked' })
    else if (!isMerged) left.push({ path: w.path, branch: w.branch, why: 'unmerged' })
    else {
      const kept = retireWorktree(x, w, { crew: crew ?? merged[0] as string, run: id, why: 'merged' })
      if (kept !== undefined) left.push({ path: w.path, branch: w.branch, why: kept })
    }
  }
  // member branches whose worktree is already gone
  const heads = run(x.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
  for (const b of heads.status === 0 ? heads.out.split('\n') : []) {
    if (b === '' || checkedOut.has(b) || !OLD_WF_BRANCH.test(b)) continue
    const id = memberRun(b) as string
    const crew = ownerOf(id, b.slice('worktree-'.length))
    const why = crew === undefined ? undefined : terminal.get(crew)
    if (why !== undefined && crew !== undefined) retireBranch(x, b, { crew, run: id, why, worktree: null })
  }
  // a dropped crew's own worktree and branch
  for (const [crew, why] of terminal) {
    if (why !== 'dropped') continue
    const b = `truss-${crew}`
    const w = worktreesOf(x.repo).find((v) => v.branch === b)
    const kept = w !== undefined ? retireWorktree(x, w, { crew, run: runId, why }) : checkedOut.has(b) ? undefined : run(x.repo, ['rev-parse', '--verify', '-q', `refs/heads/${b}`]).status === 0 ? retireBranch(x, b, { crew, run: runId, why, worktree: null }) : undefined
    if (kept !== undefined && w !== undefined) left.push({ path: w.path, branch: b, why: kept })
  }
  pruneArchive(x.repo)
  return left
}
