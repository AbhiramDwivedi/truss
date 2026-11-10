// Work types (contract-025 section 5, ADR-0041). A0 stub: the final signatures; profilesOf gives the built-ins and workTypeErrors none. b-cost replaces it.
// Imports node: builtins and relative paths only, and never factory.ts (its top-level await would make an import cycle).

import { configOf, need } from './store.ts'
import type { Flags, Obj } from './store.ts'

export type Process = 'solo' | 'lean' | 'full'
export type Profile = { minProcess: Process; stressTest?: boolean; red?: boolean }

const BUILT_INS: Record<string, Profile> = {
  feature: { minProcess: 'solo' },
  docs: { minProcess: 'solo' },
  refactor: { minProcess: 'solo' },
  bugfix: { minProcess: 'lean', red: true },
  dependency: { minProcess: 'lean' },
  migration: { minProcess: 'full', stressTest: true },
}

/** The profiles the config tightens over the built-ins, and the config errors found. */
export function profilesOf(cfg: Obj): { profiles: Record<string, Profile>; errors: string[] } {
  return { profiles: structuredClone(BUILT_INS), errors: [] }
}

/** The errors of `crew`'s workType against its profile. */
export function workTypeErrors(plan: Obj, crew: Obj, profiles: Record<string, Profile>, opts: { unattended: boolean }): string[] {
  return []
}

export const WORKTYPE_COMMANDS: Record<string, (f: Flags) => Obj> = {
  worktypes: (f) => profilesOf(configOf(need(f, 'repo'))),
}
