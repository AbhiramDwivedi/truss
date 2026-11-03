// The build network (D2 direction-d2.html:600-760; ADR-0018 section 10; ADR-0023 section 4): the region
// named Crews, a Claude node, then one group per stage in order, side by side on wide screens and
// stacked below. Busy with no state; No plan yet. with no crews.
import { Workflow } from 'lucide-react'
import type { Crew, RunState } from '../../store/types.ts'
import { ModelBadge } from '../../components/ui/badge.tsx'
import { Skeleton } from '../../components/ui/skeleton.tsx'
import { StageGroup, type StagePhase } from './StageGroup.tsx'
import { crewEnd, crewStart, plural, short } from './format.ts'

export interface BuildNetworkProps {
  state: RunState | null
  now: number
}

interface Stage {
  key: string
  label: string
  crews: Crew[]
  phase: StagePhase
  took: string | null
}

function stagesOf(crews: Crew[]): Stage[] {
  const by = new Map<number | null, Crew[]>()
  for (const c of crews) {
    const list = by.get(c.stage) ?? []
    list.push(c)
    by.set(c.stage, list)
  }
  const keys = [...by.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b))
  const out: Stage[] = []
  let sawRunning = false
  let nextGiven = false
  for (const k of keys) {
    const list = by.get(k)!
    const live = list.filter((c) => c.status !== 'dropped')
    let phase: StagePhase
    let took: string | null = null
    if (live.length > 0 && live.every((c) => c.status === 'merged')) {
      phase = 'merged'
      const starts = live.map(crewStart).filter((x): x is number => x !== null)
      const ends = live.map(crewEnd).filter((x): x is number => x !== null)
      if (starts.length && ends.length) took = short(Math.max(...ends) - Math.min(...starts))
    } else if (list.some((c) => c.status === 'running')) {
      phase = 'running'
      sawRunning = true
    } else if (sawRunning && !nextGiven) {
      phase = 'next'
      nextGiven = true
    } else {
      phase = 'planned'
    }
    out.push({ key: String(k), label: k === null ? 'No stage' : `Stage ${k}`, crews: list, phase, took })
  }
  return out
}

const modelKey = (m: string | null): string => (m && /opus/i.test(m) ? 'opus' : m && /sonnet/i.test(m) ? 'sonnet' : (m ?? 'model unknown'))

export function BuildNetwork({ state, now }: BuildNetworkProps) {
  if (state === null) {
    return (
      <section aria-label="Crews" aria-busy="true" className="min-w-0 rounded-panel border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-lead font-semibold text-fg">Build network</h2>
        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      </section>
    )
  }

  const crews = state.run?.crews ?? []
  if (crews.length === 0) {
    return (
      <section aria-label="Crews" className="min-w-0 rounded-panel border border-border bg-surface p-4 sm:p-5">
        <h2 className="text-lead font-semibold text-fg">Build network</h2>
        <p className="mt-2 text-body text-muted">No plan yet.</p>
      </section>
    )
  }

  const stages = stagesOf(crews)
  const model = state.session.model
  return (
    <section aria-label="Crews" className="min-w-0 rounded-panel border border-border bg-surface p-4 shadow-e1 sm:p-5">
      <h2 className="text-lead font-semibold text-fg">Build network</h2>
      <div className="mt-3 flex min-w-0 items-center gap-3 rounded-card bg-sunken p-3">
        <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-ctl bg-brand-soft text-brand-strong">
          <Workflow className="size-4.5" />
        </span>
        <div className="flex min-w-0 flex-col">
          <h3 className="flex min-w-0 items-center gap-2 text-ui font-semibold text-fg">
            Claude
            {model && <ModelBadge model={modelKey(model)}>{model}</ModelBadge>}
          </h3>
          <p className="text-micro text-muted">
            Running {plural(crews.length, 'crew')} in {plural(stages.length, 'stage')}
          </p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-6 lg:auto-cols-[minmax(0,1fr)] lg:grid-flow-col">
        {stages.map((s, i) => (
          <StageGroup key={s.key} label={s.label} phase={s.phase} took={s.took} crews={s.crews} now={now} wire={i < stages.length - 1} />
        ))}
      </div>
    </section>
  )
}
