// The find-run command (ADR-0052, R-141): a new PM session lists the runs an earlier PM session left unfinished. It scans one
// level of `<git common dir>/truss/*/plan.json`; there is no pointer file. A run is listed when its plan is approved and at
// least one crew is neither merged nor dropped. Leaf module: imports only leaves, never factory.ts or a barrel.
import { existsSync, readdirSync } from 'node:fs'
import { commonDir, flat, isObj, need } from '../core.ts'
import type { Flags, Obj } from '../core.ts'
import { transcriptsOf } from '../transcripts.ts'
import { loadPlan } from './plan-file.ts'

const SAFE = /^[A-Za-z0-9._-]+$/

// The sorted, slashed paths of the files directly under D/reports/<slug> and D/crews/<slug>: what an earlier session saved.
function resultsOf(dir: string, slug: string): string[] {
  if (!SAFE.test(slug) || slug === '.' || slug === '..') return []
  const out: string[] = []
  for (const sub of ['reports', 'crews']) {
    const d = `${dir}/${sub}/${slug}`
    if (!existsSync(d)) continue
    try {
      for (const e of readdirSync(d, { withFileTypes: true })) if (e.isFile()) out.push(`${d}/${e.name}`)
    } catch {
      // an unreadable result dir lists nothing
    }
  }
  return out.sort()
}

export function cmdFindRun(f: Flags): Obj {
  const root = `${commonDir(flat(need(f, 'repo')))}/truss`
  let names: string[] = []
  try {
    names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    // no truss dir: no runs
  }
  const runs: { dir: string; session: string; approvedAt: string; transcript: string | null; crews: Obj[] }[] = []
  for (const name of names) {
    const dir = `${root}/${name}`
    let plan: Obj
    try {
      plan = loadPlan(dir)
    } catch {
      continue // no plan.json, or one that is broken or not a plan: skipped, never an error
    }
    if (plan.approvedAt === null || plan.approvedAt === undefined || plan.approvedAt === '') continue
    const crews = plan.crews
      .filter((c: unknown): c is Obj => isObj(c) && typeof c.slug === 'string' && c.status !== 'merged' && c.status !== 'dropped')
      .map((c: Obj) => ({ slug: String(c.slug), status: c.status, stage: c.stage, results: resultsOf(dir, String(c.slug)) }))
    if (crews.length === 0) continue
    runs.push({ dir, session: name, approvedAt: String(plan.approvedAt), transcript: transcriptsOf(name).main, crews })
  }
  const at = (r: { approvedAt: string }): number => {
    const t = Date.parse(r.approvedAt)
    return Number.isNaN(t) ? 0 : t
  }
  runs.sort((a, b) => at(b) - at(a) || (a.approvedAt < b.approvedAt ? 1 : a.approvedAt > b.approvedAt ? -1 : 0))
  return { runs }
}
