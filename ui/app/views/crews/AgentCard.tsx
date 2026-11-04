// One agent in a crew card (ADR-0028 section 6, R-42): role, name, model, status, purpose, the task it is
// on, and three-step progress. A <li>, never an article: the network counts articles as crews.
import * as React from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { ModelBadge } from '../../components/ui/badge.tsx'
import { cn } from '../../lib/utils.ts'
import { StatusBadge } from '../status/StatusBadge.tsx'
import type { Status } from '../status/status.ts'
import type { Member } from '../../store/types.ts'
import { modelKey } from './format.ts'
import { StepProgress } from './StepProgress.tsx'

export interface AgentCardProps {
  member: Member
  role: string
  task: string | null
  status: Status
  step: 1 | 2 | 3
}

function AgentCardImpl({ member, role, task, status, step }: AgentCardProps) {
  const id = React.useId()
  const taskId = `${id}-task`
  const taskRef = React.useRef<HTMLParagraphElement>(null)
  const [open, setOpen] = React.useState(false)
  const [cut, setCut] = React.useState(false)

  // Measure only while clamped: once open, scrollWidth equals clientWidth, so keep the toggle until it closes.
  React.useEffect(() => {
    const p = taskRef.current
    if (!p || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!open) setCut(p.scrollWidth > p.clientWidth)
    })
    ro.observe(p)
    return () => ro.disconnect()
  }, [task, open])

  const model = modelKey(member.model)
  return (
    <li className="flex min-w-0 flex-col gap-2 rounded-ctl border border-border bg-surface p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-ui font-semibold text-fg">{role}</span>{' '}
        <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
          <ModelBadge model={model} title={member.model ?? undefined}>
            {model}
          </ModelBadge>{' '}
          <StatusBadge status={status} size="sm" />
        </span>
      </div>{' '}
      <span title={member.name} className="min-w-0 truncate text-meta text-muted">
        {member.name}
      </span>{' '}
      {member.purpose && (
        <p title={member.purpose} className="line-clamp-2 min-w-0 break-words text-meta text-muted">
          {member.purpose}
        </p>
      )}
      <div className="flex min-w-0 items-start gap-1">
        {task ? (
          <>
            <p
              ref={taskRef}
              id={taskId}
              className={cn('min-w-0 flex-1 text-meta text-fg', open ? 'whitespace-normal break-words' : 'truncate')}
            >
              {task}
            </p>
            {(cut || open) && (
              <button
                type="button"
                aria-label={open ? 'Hide full task' : 'Show full task'}
                aria-expanded={open}
                aria-controls={taskId}
                onClick={() => setOpen((v) => !v)}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-chip text-muted hover:bg-sunken hover:text-fg pointer-coarse:size-11"
              >
                {open ? <ChevronUp aria-hidden="true" className="size-4" /> : <ChevronDown aria-hidden="true" className="size-4" />}
              </button>
            )}
          </>
        ) : (
          <p className="min-w-0 text-meta text-subtle">No activity yet</p>
        )}
      </div>
      <StepProgress step={step} />
    </li>
  )
}

export const AgentCard = React.memo(AgentCardImpl)
