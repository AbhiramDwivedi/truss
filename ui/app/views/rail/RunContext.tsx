// The rail's "Run" section (ADR-0023 section 4, D2 :466-488): where Truss runs, what the idea is and when it
// was approved.
import { FolderGit2, Lock } from 'lucide-react'
import { ModelBadge } from '../../components/ui/badge.tsx'
import type { RunState } from '../../store/types.ts'
import { costState } from '../metrics/format.ts'
import { approvalLine, family, firstGoal, money } from './format.ts'

export interface RunContextProps {
  state: RunState | null
  now: number
}

export function RunContext({ state }: RunContextProps) {
  const goal = firstGoal(state)
  const approved = approvalLine(state)
  const model = state?.session.model ?? null
  const cost = money(state?.session.usage?.costUsd)
  return (
    <section
      aria-label="Run"
      className="space-y-5 border-b border-border px-6 py-3 max-lg:mx-4 max-lg:rounded-card max-lg:border max-lg:bg-surface max-lg:px-4 max-lg:py-5 lg:space-y-2"
    >
      <div>
        <h2 className="mb-0.5 text-meta font-medium text-muted">Target repository</h2>
        <div
          className="flex h-9 min-w-0 items-center gap-2.5 rounded-ctl border border-border bg-bg px-3"
          title="Truss runs in the repo it was started in"
        >
          <FolderGit2 aria-hidden="true" className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate font-mono text-ui text-fg" title={state?.repo}>
            {state?.repo ?? ''}
          </span>
          <Lock aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
        </div>
      </div>

      <div className="space-y-1.5">
        <h2 className="text-meta font-medium text-muted">The idea</h2>
        {goal ? (
          <div className="w-full rounded-ctl border border-brand-line bg-brand-soft p-3.5 lg:px-3 lg:py-2">
            <p title={goal.goal ?? undefined} className="text-body font-medium break-words text-fg lg:text-ui lg:leading-snug lg:line-clamp-2">
              {goal.goal ?? 'A run with no goal text.'}
            </p>
            <p className="mt-2 text-meta text-muted lg:mt-0.5">{approved ?? 'Waiting for your approval.'}</p>
          </div>
        ) : (
          <p className="w-full rounded-ctl border border-dashed border-border-strong p-3.5 text-ui text-muted">
            No goal yet. Type one in the box to start.
          </p>
        )}
      </div>

      {(model || cost) && (
        <div className="flex flex-wrap items-center gap-2 lg:hidden">
          {model && <ModelBadge model={family(model)} size="md">{model}</ModelBadge>}
          <span className="font-mono text-meta tabular-nums text-muted">{cost ?? (state && costState(state) === 'not-recorded' ? 'Cost not recorded' : 'No cost yet')}</span>
        </div>
      )}
    </section>
  )
}
