// One stage column of the build network (D2 direction-d2.html:610-640): a group named Stage n with an
// h3 that says where the stage is, a decorative wire that flows while the stage runs, and its crews.
import type { Crew } from '../../store/types.ts'
import { cn } from '../../lib/utils.ts'
import { CrewCard } from './CrewCard.tsx'

export type StagePhase = 'merged' | 'running' | 'next' | 'planned'

export interface StageGroupProps {
  label: string
  phase: StagePhase
  /** For a merged stage: how long it took, such as `7m`. */
  took?: string | null
  crews: Crew[]
  now: number
  /** Draw the wire to the next stage. */
  wire?: boolean
}

const phaseWords = (phase: StagePhase, took?: string | null) =>
  phase === 'merged' ? (took ? `, merged in ${took}` : ', merged') : `, ${phase}`

export function StageGroup({ label, phase, took, crews, now, wire = false }: StageGroupProps) {
  return (
    <div role="group" aria-label={label} className="relative min-w-0">
      <h3 className="mb-2.5 flex items-center gap-2 text-meta font-semibold text-fg">
        <span>{label}</span>
        <span className={cn('font-medium', phase === 'running' ? 'text-brand-strong' : 'text-muted')}>{phaseWords(phase, took)}</span>
      </h3>
      {wire && (<svg aria-hidden="true" viewBox="0 0 24 8" preserveAspectRatio="none" className="absolute top-2 -right-6 h-2 w-6 max-lg:hidden">
        <line
          x1="0"
          y1="4"
          x2="24"
          y2="4"
          strokeWidth={2}
          strokeDasharray="4 7"
          className={cn(phase === 'running' ? 'stroke-brand motion-safe:animate-dash' : phase === 'merged' ? 'stroke-ok' : 'stroke-border-strong')}
        />
      </svg>)}
      <ul className="flex min-w-0 flex-col gap-3">
        {crews.map((c) => (
          <CrewCard key={c.slug} crew={c} now={now} />
        ))}
      </ul>
    </div>
  )
}
