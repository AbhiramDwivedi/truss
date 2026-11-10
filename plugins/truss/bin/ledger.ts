// The merge ledger (contract-025 section 4, ADR-0038). A0 stub: the final signature, and it appends nothing; b-cost replaces it.
// Imports node: builtins and relative paths only, and never factory.ts (its top-level await would make an import cycle).

import type { Obj } from './store.ts'

/** Appends one merge row to S/ledger.jsonl. */
export function ledgerAppend(repo: string, row: Obj): void {}
