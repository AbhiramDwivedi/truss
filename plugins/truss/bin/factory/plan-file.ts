// The plan file D/plan.json: load, save and the locked read-modify-write. Split from bin/factory/shared.ts (0.32.0 item 8).
// Never imports factory.ts, whose top-level await would make an import cycle.
import { isObj, readJson, usage } from '../core.ts'
import type { Obj } from '../core.ts'
import { withLock, writeJsonAtomic } from '../lock.ts'

// The plan object from D/plan.json (usage error when missing or unreadable).
export function loadPlan(dir: string): Obj {
  const plan = readJson(`${dir}/plan.json`)
  if (!isObj(plan) || !Array.isArray(plan.crews)) throw usage(`${dir}/plan.json is not a plan`)
  return plan
}
// Writes the plan object back to D/plan.json, 2-space JSON with a trailing newline.
export function savePlan(dir: string, plan: Obj): void {
  writeJsonAtomic(`${dir}/plan.json`, plan)
}
// Re-reads plan.json under the plan lock, lets `change` edit that fresh copy, and saves it, so a write never drops another
// command's edit (owns-extend, start, approve, mark-merged and the merge gate all write the plan).
export function patchPlan(dir: string, change: (plan: Obj) => void): Obj {
  return withLock(dir, 'plan', (): Obj => {
    const plan = loadPlan(dir)
    change(plan)
    savePlan(dir, plan)
    return plan
  })
}
