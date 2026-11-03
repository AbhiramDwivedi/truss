// React's view of the store (ADR-0018 section 9): narrow selectors over useSyncExternalStore.
import { useSyncExternalStore } from 'react'
import { pageStore } from './store.ts'
import type { Connection, RunState } from './types.ts'

/**
 * Reads one slice of the run. The selector must return a value that is stable between calls while the
 * state is unchanged: pick a field or an array the store holds, never build a new object or array in it.
 */
export function useRun<T>(select: (s: RunState | null) => T): T {
  const store = pageStore()
  return useSyncExternalStore(store.subscribe, () => select(store.getState()))
}

/** The link to the run: connecting, live or reconnecting (ADR-0023 section 1). */
export function useConnection(): Connection {
  const store = pageStore()
  return useSyncExternalStore(store.subscribe, store.getConnection)
}
