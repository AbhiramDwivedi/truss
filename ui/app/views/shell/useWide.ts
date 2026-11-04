// True at 1024 px and up (the lg breakpoint). It reads the media query synchronously on the first render, so the
// first paint is already in the right arrangement (ADR-0028 section 10).
import { useSyncExternalStore } from 'react'

const QUERY = '(min-width: 1024px)'

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia(QUERY)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

const snapshot = () => window.matchMedia(QUERY).matches
const serverSnapshot = () => true

export function useWide(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}
