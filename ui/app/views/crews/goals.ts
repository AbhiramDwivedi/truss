// Goal grouping (ADR-0028 section 7): a truss dir's plan.json can hold several goals. A crew with no goal id
// belongs to the run's first goal (id run); a crew with goal "<id>" belongs to that goal when plan.json lists it. Pure, no React.
import type { Crew, RunInfo } from '../../store/types.ts'
import { crewStart, ms } from './format.ts'

export interface GoalGroup {
  id: string
  /** The goal's text, or null when only the id is known. */
  goal: string | null
  approvedAt: string | null
  crews: Crew[]
}

/** The run's goals that have crews, in plan order; one group (id run) when the snapshot lists no goals. */
export function goalGroups(run: RunInfo | null | undefined): GoalGroup[] {
  if (!run) return []
  const groups = new Map<string, GoalGroup>()
  const listed = run.goals && run.goals.length > 0 ? run.goals : [{ id: 'run', goal: run.goal, approval: run.approval, approvedAt: run.approvedAt }]
  for (const g of listed) groups.set(g.id, { id: g.id, goal: g.goal, approvedAt: g.approvedAt, crews: [] })
  const first = listed[0]!.id
  for (const c of run.crews) {
    // A goal id the snapshot does not list (older runs hold goal text there) stays with the first goal.
    groups.get(c.goal !== null && groups.has(c.goal) ? c.goal : first)!.crews.push(c)
  }
  return [...groups.values()].filter((g) => g.crews.length > 0)
}

/** The latest goal with crews (shown by default), or null with no crews. */
export function latestGoal(run: RunInfo | null | undefined): GoalGroup | null {
  return goalGroups(run).at(-1) ?? null
}

/** True when more than one goal has crews. */
export const hasEarlierGoals = (run: RunInfo | null | undefined): boolean => goalGroups(run).length > 1

/** When a goal's work began: its approval, else its crews' earliest agent. Null when neither parses. */
export function goalStartMs(g: GoalGroup): number | null {
  const a = ms(g.approvedAt)
  if (a !== null) return a
  const starts = g.crews.map(crewStart).filter((x): x is number => x !== null)
  return starts.length ? Math.min(...starts) : null
}

/** Latest agent stamp across the goal's crews, or null. */
export function goalLastMs(g: GoalGroup): number | null {
  let last: number | null = null
  for (const c of g.crews) {
    for (const m of c.projectManager ? [c.projectManager, ...c.members] : c.members) {
      const t = ms(m.ts)
      if (t !== null && (last === null || t > last)) last = t
    }
  }
  return last
}

/** The heading text of an earlier goal's section: its text, else its id. */
export const goalLabel = (g: GoalGroup): string => g.goal?.trim() || g.id
