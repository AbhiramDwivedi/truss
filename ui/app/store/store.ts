// The client store: one EventSource on /api/events, reduced through wire.ts (ADR-0018 section 9), plus the
// link's health for the views (ADR-0023 section 1): connecting, live or reconnecting, and lastMessageAt.
import type { Connection, RunState, WireMessage } from './types.ts'
import { NOTHING_HELD, reduce } from './wire.ts'
import type { Held } from './wire.ts'

/** An EventSource as the store uses it: listeners for snapshot, delta, error and open, and close. */
export interface SourceLike {
  addEventListener(type: string, listener: (ev: { data: string }) => void): void
  close(): void
}

export interface StoreDeps {
  open: (url: string) => SourceLike
  reload: () => void
}

export interface Store {
  start(): void
  stop(): void
  /** null until the first snapshot, never null after it. */
  getState(): RunState | null
  getConnection(): Connection
  /** Epoch ms of the last snapshot or delta the store applied, or null before the first. */
  getLastMessageAt(): number | null
  /** Called on every state change and every connection change. */
  subscribe(fn: () => void): () => void
}

const EVENTS_URL = '/api/events'

export function createStore(deps: StoreDeps): Store {
  let held: Held = NOTHING_HELD
  let current: SourceLike | null = null
  let connection: Connection = 'connecting'
  let lastMessageAt: number | null = null
  const subscribers = new Set<() => void>()

  function notify(): void {
    for (const fn of [...subscribers]) fn()
  }

  function connect(): void {
    const src = deps.open(EVENTS_URL)
    current = src
    const onMessage = (ev: { data: string }): void => {
      if (current !== src) return
      let msg: WireMessage
      try {
        msg = JSON.parse(ev.data) as WireMessage
      } catch {
        return
      }
      if (msg === null || typeof msg !== 'object') return
      const r = reduce(held, msg)
      if (r.outcome === 'reload') {
        deps.reload()
      } else if (r.outcome === 'resync') {
        src.close()
        connect()
      } else if (r.outcome === 'applied') {
        held = r.held
        lastMessageAt = Date.now()
        const wasLive = connection === 'live'
        connection = 'live'
        if (r.changed.length > 0 || !wasLive) notify()
      }
    }
    // EventSource retries by itself after an error; the store only reports it until a message arrives.
    const onError = (): void => {
      if (current !== src || connection === 'reconnecting') return
      connection = 'reconnecting'
      notify()
    }
    // An open alone proves nothing about the run: the connection is live only once a message applies.
    const onOpen = (): void => {}
    src.addEventListener('snapshot', onMessage)
    src.addEventListener('delta', onMessage)
    src.addEventListener('error', onError)
    src.addEventListener('open', onOpen)
  }

  return {
    start() {
      if (current !== null) return
      connect()
    },
    stop() {
      const src = current
      current = null
      if (src !== null) src.close()
    },
    getState() {
      return held.state
    },
    getConnection() {
      return connection
    },
    getLastMessageAt() {
      return lastMessageAt
    },
    subscribe(fn) {
      subscribers.add(fn)
      return () => {
        subscribers.delete(fn)
      }
    },
  }
}

let page: Store | null = null

export function pageStore(): Store {
  if (page === null) {
    page = createStore({
      open: (url) => new EventSource(url),
      reload: () => location.reload(),
    })
  }
  return page
}
