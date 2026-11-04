// A tiny external store that carries "open this ADR in the deliverable preview" from the rail's timeline to
// Deliverables without going through App.tsx (ADR-0028 section 3). rework-page may lift it into the store later.
import { useSyncExternalStore } from 'react'

export interface PreviewTarget {
  /** The ADR file to preview, or null when nothing was asked for. */
  adr: string | null
  /** The timeline button that opened it; focus returns here. */
  opener: HTMLElement | null
  /** Bumps on every openAdr, so opening the same ADR twice still notifies. */
  seq: number
}

let target: PreviewTarget = { adr: null, opener: null, seq: 0 }
const listeners = new Set<() => void>()

export function openAdr(file: string, opener: HTMLElement): void {
  target = { adr: file, opener, seq: target.seq + 1 }
  for (const l of listeners) l()
}

/** Clears the request, for when the preview closes or moves to another item. */
export function clearPreviewTarget(): void {
  if (target.adr === null) return
  target = { adr: null, opener: target.opener, seq: target.seq }
  for (const l of listeners) l()
}

/** The snapshot; also the server snapshot. */
export function previewTarget(): PreviewTarget {
  return target
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function usePreviewTarget(): PreviewTarget {
  return useSyncExternalStore(subscribe, previewTarget, previewTarget)
}
