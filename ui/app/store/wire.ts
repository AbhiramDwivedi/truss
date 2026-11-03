// Applies snapshot and delta messages to the held state (ADR-0011 Decision 5, ADR-0018 section 9).
import type { Delta, RunState, Snapshot, TranscriptEntry, WireMessage } from './types.ts'

export const TRANSCRIPT_LIMIT = 500

export interface Held {
  instance: string | null
  seq: number
  state: RunState | null
}

export const NOTHING_HELD: Held = { instance: null, seq: 0, state: null }

export type Outcome = 'applied' | 'ignored' | 'resync' | 'reload'

export interface Reduced {
  outcome: Outcome
  held: Held
  changed: string[]
}

function same(held: Held, outcome: Outcome): Reduced {
  return { outcome, held, changed: [] }
}

function applySnapshot(held: Held, msg: Snapshot): Reduced {
  if (msg.state.v !== 1) return same(held, 'reload')
  return {
    outcome: 'applied',
    held: { instance: msg.instance, seq: msg.seq, state: msg.state },
    changed: Object.keys(msg.state),
  }
}

function applyDelta(held: Held, msg: Delta): Reduced {
  const state = held.state
  if (state === null) return same(held, 'resync')
  if (msg.seq <= held.seq) return same(held, 'ignored')
  if (msg.seq !== held.seq + 1) return same(held, 'resync')

  const next: Record<string, unknown> = { ...state }
  const changed: string[] = []

  if (msg.set) {
    for (const key of Object.keys(msg.set)) {
      next[key] = (msg.set as Record<string, unknown>)[key]
      changed.push(key)
    }
  }

  const incoming = msg.append?.transcript
  if (incoming && incoming.length > 0) {
    const have = state.transcript
    const last = have.length > 0 ? have[have.length - 1].n : 0
    const fresh: TranscriptEntry[] = incoming.filter((e) => e.n > last)
    if (fresh.length > 0) {
      const all = have.concat(fresh)
      next.transcript = all.length > TRANSCRIPT_LIMIT ? all.slice(all.length - TRANSCRIPT_LIMIT) : all
      changed.push('transcript')
    }
  }

  return {
    outcome: 'applied',
    held: {
      instance: held.instance,
      seq: msg.seq,
      state: changed.length > 0 ? (next as unknown as RunState) : state,
    },
    changed,
  }
}

export function reduce(held: Held, msg: WireMessage): Reduced {
  return msg.type === 'snapshot' ? applySnapshot(held, msg) : applyDelta(held, msg)
}
