// The merge ledger (contract-025 section 4, ADR-0038): append-only, one whole JSON line per merge.
// Imports node: builtins and relative paths only, and never factory.ts (its top-level await would make an import cycle).

import { mkdirSync } from 'node:fs'
import { appendJsonl, sharedDir } from './store.ts'
import type { Obj } from './store.ts'

/** Appends one merge row to S/ledger.jsonl. */
export function ledgerAppend(repo: string, row: Obj): void {
  const dir = sharedDir(repo)
  mkdirSync(dir, { recursive: true })
  appendJsonl(dir, 'ledger', 'ledger.jsonl', row)
}
