// Spend, budgets and the cost command (contract-025 section 4, ADR-0038). A0 stub: the final signatures; b-cost replaces it.
// Imports node: builtins and relative paths only, and never factory.ts (its top-level await would make an import cycle).

import { need } from './store.ts'
import type { Flags, Obj } from './store.ts'

export type BudgetVerdict = { held: false } | { held: true; scope: 'run' | 'crew' | 'workType' | 'session'; spentUsd: number | null; limitUsd: number; why: string }

/** Whether a budget holds the crew `slug` (null: the session, for queue-next) of `plan`. */
export function budgetVerdict(dir: string, repo: string, plan: Obj | null, slug: string | null): BudgetVerdict {
  return { held: false }
}

/** The crew's spend in USD, or null with the reason it can't be priced. */
export function crewCost(dir: string, repo: string, slug: string): { usd: number | null; why?: string } {
  return { usd: null, why: 'not recorded' }
}

export const COST_COMMANDS: Record<string, (f: Flags) => Obj> = {
  cost: (f) => (need(f, 'dir'), need(f, 'repo'), { run: { since: null, usd: null, tokens: 0 }, session: { usd: null }, crews: [], unpriced: [], notRecorded: [], claudeCodeEstimateUsd: null, sweep: { rows: 0, files: 0, bad: 0, found: 0 } }),
}
