// The build network (ADR-0028 sections 7 and 10; R-36, R-40): the PM node, then one row per stage, each a
// list of crew cards wired to the PM and holding their agents. Busy with no state; a dashed placeholder
// while there are no crews. A polite live region announces a crew whose status changed between snapshots.
import * as React from 'react'
import type { Crew, FlowEntry, RunState } from '../../store/types.ts'
import { Skeleton } from '../../components/ui/skeleton.tsx'
import { crewStatus, pmStatus, STATUS_WORD, type Status } from '../status/status.ts'
import { PmNode, type PmNodeProps } from './PmNode.tsx'
import { StageGroup, type StagePhase } from './StageGroup.tsx'
import { GoalsContext, isRecent } from './CrewCard.tsx'
import { crewEnd, crewStart, short } from './format.ts'
import { goalGroups, goalLabel, type GoalGroup } from './goals.ts'
import { ChevronDown, ChevronRight } from 'lucide-react'

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
      const span = starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : 0
      // Under a minute means the stamps cannot tell the span (a merged crew's latest stamp is often its
      // start too), so the stage says only "merged" rather than a false "merged in 0s".
      if (span >= 60_000) took = short(span)
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

/** The latest hand-off to each crew, by slug. */
function handoffsOf(flow: readonly FlowEntry[]): Map<string, FlowEntry> {
  const out = new Map<string, FlowEntry>()
  for (const f of flow) {
    if (f.to === null) continue
    const prev = out.get(f.to)
    if (!prev || Date.parse(f.at) >= Date.parse(prev.at)) out.set(f.to, f)
  }
  return out
}

// The wire widths (UX direction section 4). Named here, used by the wires as CSS variables.
const WIRE_VARS = { '--wire-w': '2px', '--wire-w-live': '3px' } as React.CSSProperties

const SECTION = 'min-w-0 rounded-panel border border-border bg-surface p-4 sm:p-5'

function pmState(crewCount: number, status: Status): PmNodeProps['state'] {
  if (crewCount > 0) return status === 'done' ? 'finished' : 'running'
  return status === 'planned' ? 'waiting-goal' : 'planning'
}

function renderStages(stages: Stage[], now: number, handoffs: ReadonlyMap<string, FlowEntry>, trunkAnimated: boolean, trunkLit: boolean) {
  return stages.map((s, i) => (
    <StageGroup
      key={s.key}
      label={s.label}
      phase={s.phase}
      took={s.took}
      crews={s.crews}
      now={now}
      handoffs={handoffs}
      first={i === 0}
      last={i === stages.length - 1}
      trunkAnimated={trunkAnimated}
      trunkLit={trunkLit}
    />
  ))
}

/** An earlier goal of the run: collapsed to one button, its own stages once opened. */
function EarlierGoal({ group, now, handoffs, trunkAnimated, trunkLit }: { group: GoalGroup; now: number; handoffs: ReadonlyMap<string, FlowEntry>; trunkAnimated: boolean; trunkLit: boolean }) {
  const [open, setOpen] = React.useState(false)
  const id = React.useId()
  const label = `Earlier goal: ${goalLabel(group)}`
  return (
    <section aria-label={label} className="mt-6 min-w-0 border-t border-border pt-4">
      <h3 className="min-w-0 text-body font-semibold text-fg">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="flex min-h-6 w-full min-w-0 items-start gap-2 rounded-ctl px-1 text-left hover:bg-sunken pointer-coarse:min-h-11"
        >
          {open ? <ChevronDown aria-hidden="true" className="mt-0.5 size-4 shrink-0" /> : <ChevronRight aria-hidden="true" className="mt-0.5 size-4 shrink-0" />}
          <span className={open ? 'min-w-0 break-words' : 'min-w-0 truncate'}>{label}</span>
        </button>
      </h3>
      <div id={id} hidden={!open} className="mt-4">
        {open && renderStages(stagesOf(group.crews), now, handoffs, trunkAnimated, trunkLit)}
      </div>
    </section>
  )
}

export function BuildNetwork({ state, now }: BuildNetworkProps) {
  const loaded = state !== null
  const allCrews = state?.run?.crews ?? []
  const groups = goalGroups(state?.run)
  const shown = groups.at(-1) ?? null
  const earlier = groups.slice(0, -1).reverse()
  const crews = shown?.crews ?? []
  const statusKey = allCrews.map((c) => `${c.slug}:${crewStatus(c)}`).join('|')
  const prev = React.useRef<Map<string, Status> | null>(null)
  const [announce, setAnnounce] = React.useState('')

  // One polite message for the latest crew whose status changed since the last snapshot; none on the first.
  React.useEffect(() => {
    const cur = new Map<string, Status>(allCrews.map((c) => [c.slug, crewStatus(c)]))
    const before = prev.current
    prev.current = cur
    if (!loaded || before === null) return
    let latest = ''
    for (const [slug, s] of cur) {
      const was = before.get(slug)
      if (was !== undefined && was !== s) latest = `Crew ${slug} is now ${STATUS_WORD[s].toLowerCase()}`
    }
    if (latest) setAnnounce(latest)
  }, [statusKey, loaded])

  if (state === null) {
    return (
      <section aria-label="Build network" aria-busy="true" className={SECTION}>
        <h2 className="text-title font-semibold text-fg">Build network</h2>
        <Skeleton className="mt-4 h-28 w-full rounded-card md:w-64" />
        <div className="mt-6 grid grid-cols-[24px_minmax(0,1fr)]">
          <div className="@container col-start-2 min-w-0">
            <Skeleton className="h-5 w-24" />
            <div className="grid grid-cols-1 gap-x-6 @xl:grid-cols-2 @4xl:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="pt-6">
                  <Skeleton className="h-56 rounded-card" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    )
  }

  // The PM node speaks for the shown goal alone.
  const status = pmStatus(earlier.length > 0 && state.run ? { ...state, run: { ...state.run, crews } } : state)
  const stages = stagesOf(crews)
  const flow = state.session.flow ?? []
  const handoffs = handoffsOf(flow)
  const trunkLit = crews.some((c) => isRecent(handoffs.get(c.slug), now))
  const trunkAnimated = crews.some((c) => crewStatus(c) === 'active')
  const lastFlow = flow.length > 0 ? flow[flow.length - 1] : undefined

  return (
    <section aria-label="Build network" aria-busy="false" style={WIRE_VARS} className={SECTION + (crews.length > 0 ? ' shadow-e1' : '')}>
      <h2 className="text-title font-semibold text-fg">Build network</h2>
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
      <div className="mt-4">
        <PmNode
          state={pmState(crews.length, status)}
          status={status}
          crewCount={crews.length}
          stageCount={stages.length}
          lastFlow={crews.length === 0 ? lastFlow : undefined}
          model={state.session.model}
        />
      </div>
      {crews.length === 0 ? (
        <p className="mt-6 min-w-0 rounded-card border border-dashed border-border-strong bg-sunken p-4 text-body text-muted">
          Crews appear here once the PM has a plan.
        </p>
      ) : (
        <GoalsContext.Provider value={state.run?.goals ?? []}>
        <div className="mt-6">
          {renderStages(stages, now, handoffs, trunkAnimated, trunkLit)}
          {earlier.map((g) => (
            <EarlierGoal key={g.id} group={g} now={now} handoffs={handoffs} trunkAnimated={trunkAnimated} trunkLit={trunkLit} />
          ))}
        </div>
        </GoalsContext.Provider>
      )}
    </section>
  )
}
