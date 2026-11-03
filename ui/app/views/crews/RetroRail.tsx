// The retro stage (ADR-0012 Decision 8; R-23; ADR-0018): a region named Retro stage with five steps in
// order, a row on wide screens and a column below. Nothing at all while there is no retro state.
import type { RetroInfo, RunState } from '../../store/types.ts'
import { RetroStep } from './RetroStep.tsx'

export interface RetroRailProps {
  state: RunState | null
  now: number
}

const STEPS: { key: keyof RetroInfo['steps']; label: string }[] = [
  { key: 'extract', label: 'Extract' },
  { key: 'judges', label: 'Judges' },
  { key: 'triage', label: 'Triage' },
  { key: 'fixGoal', label: 'Fix goal' },
  { key: 'applied', label: 'Fixes applied' },
]

export function RetroRail({ state }: RetroRailProps) {
  const retro = state?.retro
  if (!retro) return null
  return (
    <section aria-label="Retro stage" className="min-w-0 rounded-panel border border-border bg-surface p-4 shadow-e1 sm:p-5">
      <h2 className="text-lead font-semibold text-fg">Retro stage</h2>
      <ol className="mt-3 flex min-w-0 flex-col gap-3 lg:flex-row">
        {STEPS.map((s, i) => (
          <RetroStep key={s.key} label={s.label} step={retro.steps[s.key]} last={i === STEPS.length - 1} />
        ))}
      </ol>
    </section>
  )
}
