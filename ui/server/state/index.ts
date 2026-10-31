// ui-state (ADR-0011 Decisions 4, 5 and 9): watches and reduces the Truss dir, the config, the architecture doc and
// the ADR dir into one in-memory state that matches ui/contract/state.schema.json, with a snapshot and deltas.
// Memory only (R-13). Reads only: nothing here writes to the Truss dir, the repo or the plugin.
// A 500 ms poll is the source of truth; fs.watch only makes a read happen sooner.
// Node built-ins only; erasable TypeScript. `SessionView` is another module's type, erased at run time.
import fs from 'node:fs'
import crypto from 'node:crypto'
import type { SessionView } from '../session/index.ts'
import { createJsonlReader } from './jsonl.ts'
import type { JsonlReader } from './jsonl.ts'
import { createReducer } from './reduce.ts'
import type { Reducer, Run } from './reduce.ts'
import { createFileReaders } from './files.ts'
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

const RING = 1024
const TRANSCRIPT_MAX = 500

interface Image {
  ref: string
  path: string
}

// ---- state-git spot -----------------------------------------------------------------------------------------
// state-git (ADR-0011 Decision 7) fills this. It owns, in a file of its own, the 5 s `git` pass that finds the image
// files the run's crews added, and trussDirFor(repo, sessionId). Until then:
//   - design.images is [] (read from `images` below);
//   - `gitError` is false, so the notice `git-error` is never raised;
//   - readImage resolves null, which is the answer for every pair that is not in design.images;
//   - trussDirFor is absent from this module (Decision 9 marks it as state-git's).
// To wire it: set `images` and `gitError` from the git pass inside refresh(), and have readImage check the pair
// against `images` and read the blob through git.
function imagesNow(): Image[] {
  return []
}
function gitErrorNow(): boolean {
  return false
}
async function readImageFromGit(_repo: string, _ref: string, _path: string, _allowed: Image[]): Promise<Buffer | null> {
  return null
}
// ---- end of the state-git spot ------------------------------------------------------------------------------

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

const KEYS = ['trussDir', 'session', 'requests', 'run', 'decisions', 'adrs', 'design', 'notices'] as const

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function createStore(opts: { repo: string; trussDir?: string; pollMs?: number }): Store {
  const repo = opts.repo
  const pollMs = opts.pollMs ?? 500
  const instance = crypto.randomBytes(8).toString('hex')
  const files = createFileReaders(repo)

  let trussDir: string | null = opts.trussDir ?? null
  let session: unknown = emptySession
  let requests: unknown[] = []
  let transcript: { n: number }[] = []
  let sessionNoPlugin = false

  // what the Truss dir gave on the last read
  let exists = false
  let reducer: Reducer | null = null
  let readers: JsonlReader[] = []
  let run: Run | null = null
  let decisions: Decision[] = []
  let adrs: Adr[] = []
  let design: unknown = { planMd: null, architecture: null, images: [] }
  let notices: { id: string; text: string }[] = []

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
      watch(dir)
    } else {
      run = null
      decisions = []
      watch(null)
    }

    const cfg = files.config()
    adrs = cfg.adr === null ? [] : files.adrs(cfg.adr)
    design = {
      planMd: exists && trussDir !== null ? files.planMd(trussDir) : null,
      architecture: cfg.architecture === null ? null : files.architecture(cfg.architecture),
      images: imagesNow(),
    }
    const n: { id: string; text: string }[] = []
    if (!cfg.complete) {
      n.push({
        id: 'no-config',
        text: '.claude/truss.json is missing, or has no "architecture" or no "adr" key, so the design panel or the ADR list is empty.',
      })
    }
    if (!exists) {
      n.push({
        id: 'no-truss-dir',
        text: trussDir === null ? 'The Truss directory is not known yet; it is set once the session starts.' : `The Truss directory ${trussDir} is not on disk yet; the hooks create it when a run begins.`,
      })
    }
    notices = n
    publish(null)
  }

  // ---- publishing ---------------------------------------------------------------------------------------------

  function compute(): Record<string, unknown> {
    const all = [...notices]
    if (sessionNoPlugin) all.push({ id: 'no-plugin', text: 'The session did not load the Truss plugin.' })
    if (gitErrorNow()) all.push({ id: 'git-error', text: 'git could not be read; the images shown are the last good ones.' })
    return {
      trussDir: { path: trussDir, exists },
      session,
      requests,
      run,
      decisions,
      adrs,
      design,
      notices: all,
    }
  }

  // Commits the current model. Each key that changed travels whole in `set`; `appended` goes in append.transcript.
  // One delta per call, none when nothing changed. The first call (loaded false) only fills the state.
  function publish(appended: unknown[] | null): void {
    const next = compute()
    const set: Record<string, unknown> = {}
    let changed = false
    for (const k of KEYS) {
      const s = JSON.stringify(next[k])
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
    const v = structuredClone(view) as unknown as { session: { plugin?: unknown; sessionId?: unknown }; requests: unknown[]; transcript: { n: number }[] }
    session = v.session
    requests = v.requests
    sessionNoPlugin = v.session.sessionId != null && v.session.plugin == null
    const lastN = transcript.length === 0 ? 0 : transcript[transcript.length - 1].n
    const fresh = v.transcript.filter((e) => e.n > lastN)
    transcript = v.transcript.slice(-TRANSCRIPT_MAX)
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
    readImage: (ref, p) => readImageFromGit(repo, ref, p, imagesNow()),
    setTrussDir,
    setSession,
    close(): void {
      closed = true
      clearInterval(timer)
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
