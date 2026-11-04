// An agent's three steps (ADR-0028 section 6): Spawned, Working, Reported. All three labels always show; the
// passed steps fill ok, the current one fills brand and carries aria-current, later ones are an outline.
// Never a percentage.
import { cn } from '../../lib/utils.ts'

export interface StepProgressProps {
  step: 1 | 2 | 3
}

const STEPS = ['Spawned', 'Working', 'Reported'] as const

export function StepProgress({ step }: StepProgressProps) {
  return (
    <ol aria-label="Progress" className="grid grid-cols-3 gap-1">
      {STEPS.map((label, i) => {
        const n = i + 1
        const current = n === step
        const passed = n < step
        return (
          <li key={label} aria-current={current ? 'step' : undefined} className="flex min-w-0 flex-col gap-1">
            <span
              aria-hidden="true"
              className={cn('block h-1 rounded-chip border', passed ? 'border-ok bg-ok' : current ? 'border-brand bg-brand' : 'border-border-strong bg-transparent')}
            />
            <span className={cn('truncate text-micro', current ? 'font-semibold text-fg' : 'text-muted')}>{label}</span>
          </li>
        )
      })}
    </ol>
  )
}
