// Work types (contract-025 section 5, ADR-0041). The built-in profiles, the `workTypes` config merge that can only tighten one (`profilesOf`), the per-crew minimum-process and unattended checks (`workTypeErrors`) and the `worktypes` command.
// Imports node: builtins and relative paths only, and never factory.ts (its top-level await would make an import cycle).

import { configOf, need } from './core.ts'
import type { Flags, Obj } from './core.ts'

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
  const profiles: Record<string, Profile> = structuredClone(BUILT_INS)
  const errors: string[] = []
  const wts = cfg?.workTypes
  if (wts === undefined) return { profiles, errors }
  if (typeof wts !== 'object' || wts === null || Array.isArray(wts)) return { profiles, errors: ['config: workTypes must be an object'] }
  for (const [wt, over] of Object.entries(wts as Obj)) {
    const p = Object.hasOwn(profiles, wt) ? profiles[wt] : undefined
    if (p === undefined) {
      errors.push(`config: workTypes.${wt} is not a known work type`)
      continue
    }
    if (typeof over !== 'object' || over === null || Array.isArray(over)) {
      errors.push(`config: workTypes.${wt} must be an object`)
      continue
    }
    for (const [key, val] of Object.entries(over as Obj)) {
      if (key === 'minProcess') {
        if (typeof val !== 'string' || !Object.hasOwn(RANK, val)) errors.push(`config: workTypes.${wt}.minProcess must be solo, lean or full`)
        else if (RANK[val] < RANK[p.minProcess]) errors.push(`config: workTypes.${wt}.minProcess ${val} loosens the built-in ${p.minProcess}`)
        else p.minProcess = val as Process
      } else if (key === 'stressTest' || key === 'red') {
        if (typeof val !== 'boolean') errors.push(`config: workTypes.${wt}.${key} must be true or false`)
        else if (!val && p[key] === true) errors.push(`config: workTypes.${wt}.${key} false loosens the built-in true`)
        else if (val) p[key] = true
      } else errors.push(`config: workTypes.${wt}.${key} is not a known key`)
    }
  }
  return { profiles, errors }
}

const RANK: Record<string, number> = { solo: 0, lean: 1, full: 2 }

/** The errors of `crew`'s workType against its profile. */
export function workTypeErrors(plan: Obj, crew: Obj, profiles: Record<string, Profile>, opts: { unattended: boolean }): string[] {
  const s = String(crew.slug)
  const wt = crew.workType
  if (!Object.hasOwn(crew, 'workType')) return opts.unattended ? [`${s}: workType is required in an unattended run`] : []
  if (typeof wt !== 'string' || !Object.hasOwn(profiles, wt)) return [`${s}: workType must be one of feature, bugfix, migration, dependency, docs or refactor`]
  const p = profiles[wt]
  const errors: string[] = []
  const proc = typeof crew.process === 'string' && Object.hasOwn(RANK, crew.process) ? crew.process : 'full'
  if (RANK[proc] < RANK[p.minProcess]) errors.push(`${s}: process ${proc} is below the ${wt} minimum ${p.minProcess}`)
  if (p.red === true && crew.red !== true && proc !== 'full') errors.push(`${s}: ${wt} requires red`)
  return errors
}

export const WORKTYPE_COMMANDS: Record<string, (f: Flags) => Obj> = {
  worktypes: (f) => profilesOf(configOf(need(f, 'repo'))),
}
