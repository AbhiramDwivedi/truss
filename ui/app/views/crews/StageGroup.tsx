// One stage row of the build network (ADR-0028 section 7): a header (the stage and where it is), then one
// list of crew cards laid out by a container query on the content column. The row draws its own trunk
// segment in the 24 px gutter; the last row's trunk stops at its first bus.
import type { Crew, FlowEntry } from '../../store/types.ts'
import { cn } from '../../lib/utils.ts'
import { CrewCard } from './CrewCard.tsx'
import { Trunk } from './Wire.tsx'

export type StagePhase = 'merged' | 'running' | 'next' | 'planned'

export interface StageGroupProps {
  label: string
  phase: StagePhase
  /** For a merged stage: how long it took, such as `7m`. */
  took?: string | null
  crews: Crew[]
  now: number
  /** The latest hand-off to each crew, by slug. */
  handoffs: ReadonlyMap<string, FlowEntry>
  first: boolean
  last: boolean
  /** Any crew in the network is active. */
  trunkAnimated: boolean
  /** Any hand-off in the network is recent. */
  trunkLit: boolean
}

const PHASE_WORD: Record<StagePhase, string> = { merged: 'Merged', running: 'Running', next: 'Next', planned: 'Planned' }

export function StageGroup({ label, phase, took, crews, now, handoffs, first, last, trunkAnimated, trunkLit }: StageGroupProps) {
  return (
    <div className={cn('relative grid grid-cols-[24px_minmax(0,1fr)]', !last && 'pb-6')}>
      {!last && <Trunk animated={trunkAnimated} lit={trunkLit} className={cn('left-0 h-full', first ? '-top-6 h-[calc(100%+24px)]' : 'top-0')} />}
      <div className="@container col-start-2 min-w-0">
        <p className="relative flex min-w-0 items-baseline gap-2 text-micro">
          {last && (
            <Trunk
              animated={trunkAnimated}
              lit={trunkLit}
              className={first ? '-top-6 -left-6 h-[calc(100%+24px+2px)]' : 'top-0 -left-6 h-[calc(100%+2px)]'}
            />
          )}
          <span className="font-semibold text-fg">{label}</span>{' '}
          <span className={cn('font-medium', phase === 'running' ? 'text-brand-strong' : 'text-muted')}>
            {PHASE_WORD[phase]}
            {phase === 'merged' && took ? ` in ${took}` : ''}
          </span>
        </p>
        <ul aria-label={label} className="grid min-w-0 grid-cols-1 gap-x-6 @xl:grid-cols-2 @4xl:grid-cols-3">
          {crews.map((c) => (
            <CrewCard key={c.slug} crew={c} now={now} handoff={handoffs.get(c.slug) ?? null} trunkAnimated={trunkAnimated} trunkLit={trunkLit} />
          ))}
        </ul>
      </div>
    </div>
  )
}
