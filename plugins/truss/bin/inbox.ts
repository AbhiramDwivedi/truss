// The inbox (contract-025 section 3). A0 stub: the final signatures, with the behaviour of the stubs section; a1-inbox replaces it.
// Imports node: builtins and relative paths only, and never factory.ts (its top-level await would make an import cycle).

import { need, refuse } from './store.ts'
import type { Flags, Obj } from './store.ts'

export type EscalateInput = { kind: string; title: string; detail?: string; crews?: string[]; ref?: string | null; blocking?: boolean }
export type EscalateOut = { id: string; kind: string; deduped: boolean; code: string; notified: boolean | null; notifyError?: string }

/** Raises an item to the inbox of the session `dir` names; the stub is not built. */
export function escalate(repo: string, dir: string, input: EscalateInput): EscalateOut {
  throw new Error('not built')
}

/** The ids of the open blocking items that hold the crew `slug` of `session`. */
export function blockingFor(repo: string, session: string, slug: string): string[] {
  return []
}

/** The raises of the approved budget resolves of `session`: [{ref, raiseUsd}]. */
export function budgetRaises(repo: string, session: string): { ref: string; raiseUsd: number }[] {
  return []
}

const notBuilt = (command: string): never => {
  throw refuse({ error: `not built: ${command}` })
}

export const INBOX_COMMANDS: Record<string, (f: Flags) => Obj> = {
  escalate: (f) => (need(f, 'kind'), f['title-file'] === undefined ? need(f, 'title') : need(f, 'title-file'), notBuilt('escalate')),
  inbox: () => ({ items: [], open: 0 }),
  resolve: (f) => (need(f, 'id'), need(f, 'decision'), need(f, 'by'), need(f, 'code'), notBuilt('resolve')),
  'mark-applied': (f) => (need(f, 'id'), notBuilt('mark-applied')),
}
