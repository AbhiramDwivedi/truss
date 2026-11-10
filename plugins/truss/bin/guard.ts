// The long-term cost guard (contract-025 section 3, ADR-0034). A0 stub: the final signatures, and the gates return none; a2-ltc-guard replaces it.
// Imports node: builtins and relative paths only, and never factory.ts (its top-level await would make an import cycle).

export type Reversal = 'cheap' | 'costly' | 'irreversible'
export type LtcLine = { what: string; later: string; reversal: Reversal }

/** The LONG-TERM-COST lines of a report text. */
export function ltcLines(text: string): LtcLine[] {
  return []
}

/** The deterministic triggers of the change base..head: a dependency, a migration, a *.sql, a *.schema.json or a schema.* file added. */
export function ltcTriggers(repo: string, base: string, head: string): { what: string; later: string; reversal: 'costly' }[] {
  return []
}

/** Escalates the costly lines of the designer and checker texts of a plan revision `rev`; writes D/ltc-plan.json. */
export function ltcPlan(repo: string, dir: string, texts: string[], rev: string): { ids: string[] } {
  return { ids: [] }
}

/** The ids in D/ltc-plan.json that are open or rejected. */
export function ltcPlanGate(repo: string, dir: string): string[] {
  return []
}

/** Escalates a crew's QC lines and triggers; `refused` is set until each item is resolved approve. */
export function ltcCrewGate(repo: string, dir: string, slug: string, ctx: { qcText: string | null; base: string; head: string }): { refused?: string } {
  return {}
}
