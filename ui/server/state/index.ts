// ui-state (ADR-0011 Decisions 4, 5 and 9): watches and reduces the Truss dir, the config, the architecture doc and
// the ADR dir into one in-memory state that matches ui/contract/state.schema.json, with a snapshot and deltas.
// Memory only (R-13). Reads only: nothing here writes to the Truss dir, the repo or the plugin.
// A 500 ms poll is the source of truth; fs.watch only makes a read happen sooner.
// Node built-ins only; erasable TypeScript. `SessionView` is another module's type, erased at run time.
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { readTranscriptTask, readTranscriptActivity, projectKeyOf } from './transcript.ts'
import type { ActivityRead } from './transcript.ts'
import { readGoalTask } from './goal-task.ts'
import type { SessionView } from '../session/index.ts'
import { createJsonlReader } from './jsonl.ts'
import type { JsonlReader } from './jsonl.ts'
import { createReducer } from './reduce.ts'
import type { Member, Reducer, Run } from './reduce.ts'
import { createFileReaders } from './files.ts'
import { readRetro } from './retro.ts'
import { readPurposes, purposeOf } from './agents.ts'
import { createImageTracker, trussDirFor } from './git.ts'
import type { Adr, Decision } from './files.ts'

// ---- the Decision 9 interface -------------------------------------------------------------------

export interface Snapshot {
  type: 'snapshot'
  instance: string
  seq: number
  state: Record<string, unknown>
}
export interface Delta {
  type: 'delta'
  seq: number
  set?: Record<string, unknown>
  append?: { transcript: unknown[] }
}
export interface StateSource {
  snapshot(): Snapshot // schema $defs/snapshot
  since(seq: number): Delta[] | null // deltas after seq; null when the ring can't serve it
  subscribe(fn: (d: Delta) => void): () => void // returns unsubscribe
  readImage(ref: string, path: string): Promise<Buffer | null> // null unless the pair is in design.images
}
export interface Store extends StateSource {
  ready: Promise<void> // first full read done
  setTrussDir(path: string | null): void
  setSession(view: SessionView): void // replaces session, requests, transcript
  close(): void
}

export { trussDirFor }

const RING = 1024
const TRANSCRIPT_MAX = 500

const emptySession = {
  status: 'idle',
  sessionId: null,
  model: null,
  claudeCodeVersion: null,
  permissionMode: null,
  plugin: null,
  usage: null,
  backgroundTasks: [],
  error: null,
}

const KEYS = ['trussDir', 'session', 'requests', 'run', 'decisions', 'adrs', 'design', 'notices', 'retro'] as const

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function createStore(opts: { repo: string; trussDir?: string; pluginPath?: string; pollMs?: number; claudeDir?: string }): Store {
  const repo = opts.repo
  const purposes = readPurposes(opts.pluginPath) // once at start; nothing is written (R-9)
  let taskOf: Map<string, string> = new Map() // the session view's task map; never published
  const pollMs = opts.pollMs ?? 500
  const instance = crypto.randomBytes(8).toString('hex')
  const files = createFileReaders(repo)
  const gitImages = createImageTracker(repo, () => refresh())

  let trussDir: string | null = opts.trussDir ?? null
  let session: unknown = emptySession
  let requests: unknown[] = []
  let transcript: { n: number }[] = []
  let sessionNoPlugin = false
  const cloned = new WeakMap<object, any>()
  // JSON text of a published object, kept by identity so an unchanged value is serialised once.
  const jsonOf = new WeakMap<object, string>()
  const lastClone = new Map<string, { json: string; value: unknown }>()
  function cloneByContent(key: string, o: object): unknown {
    const json = JSON.stringify(o)
    const last = lastClone.get(key)
    if (last !== undefined && last.json === json) return last.value
    const value = structuredClone(o)
    lastClone.set(key, { json, value })
    jsonOf.set(value as object, json)
    return value
  }
  function cloneOnce<T extends object>(o: T): T {
    let c = cloned.get(o)
    if (c === undefined) {
      c = structuredClone(o)
      cloned.set(o, c)
    }
    return c
  }

  // what the Truss dir gave on the last read
  let exists = false
  let reducer: Reducer | null = null
  let readers: JsonlReader[] = []
  let run: Run | null = null
  let decisions: Decision[] = []
  let adrs: Adr[] = []
  let design: unknown = { planMd: null, architecture: null, images: [] }
  let notices: { id: string; text: string }[] = []
  let retro: unknown = null

  const values: Record<string, unknown> = {}
  const json: Record<string, string> = {}
  let seq = 0
  const ring: Delta[] = []
  const subscribers = new Set<(d: Delta) => void>()
  let closed = false
  let loaded = false

  // ---- reading --------------------------------------------------------------------------------------------

  let watched: string | null = null
  let watcher: fs.FSWatcher | null = null
  let soon: ReturnType<typeof setTimeout> | null = null

  function watch(dir: string | null): void {
    if (watched === dir) return
    if (watcher !== null) {
      try {
        watcher.close()
      } catch {
        // nothing left to do
      }
      watcher = null
    }
    watched = dir
    if (dir === null) return
    try {
      const w = fs.watch(dir, { recursive: true }, () => {
        if (soon !== null || closed) return
        soon = setTimeout(() => {
          soon = null
          refresh()
        }, 10)
        soon.unref()
      })
      w.on('error', () => {
        // the poll carries on
      })
      watcher = w
    } catch {
      // no fs.watch here: the poll is the source of truth anyway
    }
  }

  function dropTruss(): void {
    reducer = null
    readers = []
  }

  function refresh(): void {
    if (closed) return
    const nowExists = trussDir !== null && isDir(trussDir)
    if (nowExists !== exists || (nowExists && reducer === null)) {
      exists = nowExists
      dropTruss()
    }
    if (exists && trussDir !== null) {
      if (reducer === null) {
        const r = createReducer()
        reducer = r
        readers = [
          createJsonlReader(trussDir, 'events', (o) => r.event(o), (f, l, why) => r.skip(f, l, why)),
          createJsonlReader(trussDir, 'messages', (o) => r.message(o), (f, l, why) => r.skip(f, l, why)),
        ]
      }
      for (const rd of readers) rd.poll()
      const dir = trussDir
      run = reducer.build(files.plan(dir), (slug) => files.qc(dir, slug))
      decisions = files.decisions(dir)
      retro = readRetro(dir)
      watch(dir)
    } else {
      run = null
      decisions = []
      retro = null
      watch(null)
    }

    const cfg = files.config()
    adrs = cfg.adr === null ? [] : files.adrs(cfg.adr)
    design = {
      planMd: exists && trussDir !== null ? files.planMd(trussDir) : null,
      architecture: cfg.architecture === null ? null : files.architecture(cfg.architecture),
      images: gitImages.images(),
    }
    const n: { id: string; text: string }[] = []
    if (!cfg.complete) {
      n.push({
        id: 'no-config',
        text: 'No design panel or ADR list yet: add .claude/truss.json with "architecture" and "adr" keys to show them (/truss:init sets this up).',
      })
    }
    if (!exists) {
      n.push({
        id: 'no-truss-dir',
        text: trussDir === null ? 'Waiting for a session: the Truss directory is set when one starts.' : `Waiting for a run: the Truss directory ${trussDir} appears when the hooks create it at the start of a run.`,
      })
    }
    notices = n
    publish(null)
    gitImages.tick(run === null ? null : run.approvedAt)
  }

  // ---- publishing ---------------------------------------------------------------------------------------------

  // The run with each member's purpose (agent files) and task (the session's task map, by agentId).
  // Memoised on the run and the tasks of its members, so a session message that changes neither reuses the object.
  // The session's task wins; without one, the agent's Claude Code transcript (ADR-0029), only when claudeDir was given.
  // Cached per agentId for the current session dir; a miss is retried after MISS_MS (the file may not exist yet).
  const MISS_MS = 2000
  let cacheDir: string | null = null
  const cache = new Map<string, { task: string | null; at: number }>()
  function transcriptTask(agentId: string): string | null {
    if (opts.claudeDir === undefined || trussDir === null || reducer === null) return null
    const sessionDir = path.join(opts.claudeDir, 'projects', projectKeyOf(repo), path.basename(trussDir))
    if (cacheDir !== sessionDir) {
      cacheDir = sessionDir
      cache.clear()
    }
    const hit = cache.get(agentId)
    const now = Date.now()
    if (hit !== undefined && (hit.task !== null || now - hit.at < MISS_MS)) return hit.task
    const task = readTranscriptTask(sessionDir, agentId, reducer.spawnedBy(agentId), reducer.titleOf)
    cache.set(agentId, { task, at: now })
    return task
  }
  // The latest tool call, re-read whenever the transcript's size or mtime changes (it is live).
  const activityCache = new Map<string, ActivityRead | null>()
  function activityFor(m: Member): string | null {
    if (m.agentId === null || opts.claudeDir === undefined || trussDir === null || reducer === null) return null
    const sessionDir = path.join(opts.claudeDir, 'projects', projectKeyOf(repo), path.basename(trussDir))
    const key = `${sessionDir}|${m.agentId}`
    const prev = activityCache.get(key) ?? undefined
    const next = readTranscriptActivity(sessionDir, m.agentId, reducer.spawnedBy(m.agentId), prev)
    activityCache.set(key, next)
    return next === null ? null : next.value
  }
  // `foremanOf` is the crew slug for a foreman, else null: a foreman with no other task falls back to its goal file.
  function taskFor(m: Member, foremanOf: string | null): string | null {
    const t = m.agentId === null ? null : (taskOf.get(m.agentId) ?? transcriptTask(m.agentId))
    if (t !== null || foremanOf === null || trussDir === null) return t
    return readGoalTask(trussDir, foremanOf)
  }

  let decoratedMemo: { run: Run; key: string; value: Run } | null = null
  function decorated(r: Run | null): Run | null {
    if (r === null) return null
    const ids: (string | null)[] = []
    for (const c of r.crews) {
      if (c.foreman) ids.push(taskFor(c.foreman, c.slug), activityFor(c.foreman))
      for (const m of c.members) ids.push(taskFor(m, null), activityFor(m))
    }
    const key = JSON.stringify(ids)
    if (decoratedMemo !== null && decoratedMemo.run === r && decoratedMemo.key === key) return decoratedMemo.value
    const value = decorate(r)
    decoratedMemo = { run: r, key, value }
    return value
  }
  function decorate(r: Run): Run {
    const fill = (m: Member, foremanOf: string | null): Member => ({
      ...m,
      purpose: purposeOf(purposes, m.type, foremanOf !== null),
      task: taskFor(m, foremanOf),
      activity: activityFor(m),
    })
    return { ...r, crews: r.crews.map((c) => ({ ...c, foreman: c.foreman === null ? null : fill(c.foreman, c.slug), members: c.members.map((m) => fill(m, null)) })) }
  }

  function compute(): Record<string, unknown> {
    const all = [...notices]
    if (sessionNoPlugin) all.push({ id: 'no-plugin', text: 'The session did not load the Truss plugin.' })
    if (gitImages.failed()) all.push({ id: 'git-error', text: 'git could not be read; the images shown are the last good ones.' })
    return {
      trussDir: { path: trussDir, exists },
      session,
      requests,
      run: decorated(run),
      decisions,
      adrs,
      design,
      notices: all,
      retro,
    }
  }

  // Commits the current model. Each key that changed travels whole in `set`; `appended` goes in append.transcript.
  // One delta per call, none when nothing changed. The first call (loaded false) only fills the state.
  function publish(appended: unknown[] | null): void {
    const next = compute()
    const set: Record<string, unknown> = {}
    let changed = false
    for (const k of KEYS) {
      const o = next[k]
      let s = typeof o === 'object' && o !== null ? jsonOf.get(o) : undefined
      if (s === undefined) {
        s = JSON.stringify(o)
        if (k === 'run' && typeof o === 'object' && o !== null) jsonOf.set(o, s) // decorated runs are never mutated
      }
      if (s !== json[k]) {
        json[k] = s
        values[k] = next[k]
        set[k] = next[k]
        changed = true
      }
    }
    if (!loaded) return
    const hasAppend = appended !== null && appended.length > 0
    if (!changed && !hasAppend) return
    const d: Delta = { type: 'delta', seq: ++seq }
    if (changed) d.set = set
    if (hasAppend) d.append = { transcript: appended }
    ring.push(d)
    if (ring.length > RING) ring.shift()
    for (const fn of [...subscribers]) {
      try {
        fn(d)
      } catch {
        // a failing subscriber does not stop the others
      }
    }
  }

  // ---- the interface --------------------------------------------------------------------------------------

  function setTrussDir(p: string | null): void {
    if (closed || p === trussDir) return
    trussDir = p
    exists = false
    dropTruss()
    refresh()
  }

  function setSession(view: SessionView): void {
    if (closed) return
    // Clone only what is published: the task map (up to 500 entries) and the tally are read or ignored, never copied,
    // and a transcript entry is cloned once (the session keeps the same object while it is unchanged).
    // The session builds new session and requests objects for every view, so these are compared by content.
    const v = {
      session: cloneByContent('session', view.session) as { plugin?: unknown; sessionId?: unknown },
      requests: cloneByContent('requests', view.requests) as unknown[],
    }
    const kept = (view.transcript as unknown as { n: number }[]).slice(-TRANSCRIPT_MAX).map((e) => cloneOnce(e))
    session = v.session
    taskOf = (view as { taskDescriptions?: Map<string, string> }).taskDescriptions ?? new Map()
    requests = v.requests
    sessionNoPlugin = v.session.sessionId != null && v.session.plugin == null
    const lastN = transcript.length === 0 ? 0 : transcript[transcript.length - 1].n
    const fresh = kept.filter((e) => e.n > lastN)
    transcript = kept
    publish(fresh)
  }

  const store: Store = {
    ready: Promise.resolve(),
    snapshot(): Snapshot {
      return {
        type: 'snapshot',
        instance,
        seq,
        state: { v: 1, repo, ...values, transcript },
      }
    },
    since(from: number): Delta[] | null {
      if (!Number.isInteger(from) || from < 0 || from > seq) return null
      if (from === seq) return []
      const first = seq - ring.length + 1
      if (from < first - 1) return null
      return ring.slice(from - (first - 1))
    },
    subscribe(fn): () => void {
      subscribers.add(fn)
      return () => {
        subscribers.delete(fn)
      }
    },
    readImage: (ref, p) => gitImages.read(ref, p),
    setTrussDir,
    setSession,
    close(): void {
      closed = true
      clearInterval(timer)
      gitImages.close()
      if (soon !== null) clearTimeout(soon)
      soon = null
      watch(null)
      subscribers.clear()
    },
  }

  const timer = setInterval(refresh, pollMs)
  timer.unref()
  refresh() // the first full read, before anyone can subscribe: it makes no delta
  loaded = true
  return store
}
