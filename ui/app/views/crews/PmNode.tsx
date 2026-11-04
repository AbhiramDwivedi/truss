// The PM node at the head of the build network (ADR-0028 section 7, R-36): the single source the work
// flows from. The only node with a 2 px fg border; the "PM" chip is filled fg so the badge colours never sit
// on an fg fill. Left-aligned, so the trunk can run down the network's gutter.
import type { FlowEntry } from '../../store/types.ts'
import { ModelBadge } from '../../components/ui/badge.tsx'
import { StatusBadge } from '../status/StatusBadge.tsx'
import type { Status } from '../status/status.ts'
import { hhmm, modelKey, plural } from './format.ts'

export interface PmNodeProps {
  state: 'waiting-goal' | 'planning' | 'running' | 'finished'
  status: Status
  crewCount: number
  stageCount: number
  /** The PM's latest hand-off; shown while it is still planning. */
  lastFlow?: FlowEntry
  model?: string | null
}

function stateLine(p: Pick<PmNodeProps, 'state' | 'crewCount' | 'stageCount'>): string {
  if (p.state === 'waiting-goal') return 'Waiting for your goal'
  if (p.state === 'planning') return 'Planning the run'
  const verb = p.state === 'finished' ? 'Finished' : 'Running'
  return `${verb} ${plural(p.crewCount, 'crew')} in ${plural(p.stageCount, 'stage')}`
}

export function PmNode({ state, status, crewCount, stageCount, lastFlow, model }: PmNodeProps) {
  return (
    <div className="relative z-10 flex w-full min-w-0 flex-col gap-2 rounded-card border-2 border-fg bg-surface p-4 shadow-e2 md:w-64">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 rounded-chip bg-fg px-2 text-micro font-semibold text-bg">PM</span>
        <h3 className="min-w-0 truncate text-lead font-semibold text-fg">Project manager</h3>
      </div>
      <p className="min-w-0 break-words text-meta text-muted">{stateLine({ state, crewCount, stageCount })}</p>
      {lastFlow && (
        <p title={`Last hand-off ${hhmm(lastFlow.at)}: ${lastFlow.summary}`} className="line-clamp-2 min-w-0 break-words text-meta text-muted">
          {`Last hand-off ${hhmm(lastFlow.at)}: ${lastFlow.summary}`}
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {model && (
          <ModelBadge model={modelKey(model)} title={model}>
            {modelKey(model)}
          </ModelBadge>
        )}
        <StatusBadge status={status} size="sm" />
      </div>
    </div>
  )
}
