// One step of the retro rail (ADR-0012 Decision 8; R-23): a list item named `<Step>: <status>`, with a
// mark for its status and the step's detail when it has one.
import { CircleAlert, CircleCheck, CircleDashed, Circle } from 'lucide-react'
import type { RetroStep as Step } from '../../store/types.ts'
import { cn } from '../../lib/utils.ts'
import { LivePing } from '../../components/ui/dot.tsx'
import { hhmm } from './format.ts'

export interface RetroStepProps {
  label: string
  step: Step
}

function Mark({ status }: { status: Step['status'] }) {
  if (status === 'running') return <span aria-hidden="true" className="grid size-4 place-items-center"><LivePing tone="brand" /></span>
  if (status === 'done') return <CircleCheck aria-hidden="true" className="size-4 text-fg" />
  if (status === 'failed') return <CircleAlert aria-hidden="true" className="size-4 text-fail-text" />
  if (status === 'skipped') return <CircleDashed aria-hidden="true" className="size-4 text-muted" />
  return <Circle aria-hidden="true" className="size-4 text-muted" />
}

export function RetroStep({ label, step }: RetroStepProps) {
  const at = step.at ? hhmm(step.at) : ''
  return (
    <li
      aria-label={`${label}: ${step.status}`}
      className={cn(
        'flex min-w-0 flex-1 gap-2.5 rounded-card border p-3',
        step.status === 'running' ? 'border-brand-line bg-brand-soft' : step.status === 'failed' ? 'border-fail/40 bg-fail-soft' : 'border-border bg-surface',
      )}
    >
      <span className="mt-0.5 shrink-0">
        <Mark status={step.status} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-meta font-semibold text-fg">{label}</span>
        <span className={cn('text-micro', step.status === 'failed' ? 'text-fail-text' : 'text-muted')}>
          {step.status}
          {at && `, ${at}`}
        </span>
        {step.detail && <span className="mt-1 min-w-0 break-words text-micro text-fg">{step.detail}</span>}
      </span>
    </li>
  )
}
