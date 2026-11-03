// The rail's "Run" section (ADR-0023 section 4, D2 :466-488): where Truss runs, what the idea is and when it
// was approved, and the Pause build button that has no server endpoint yet (gap h).
import { FolderGit2, Lock, Pause } from 'lucide-react'
import { Button } from '../../components/ui/button.tsx'
import { ModelBadge } from '../../components/ui/badge.tsx'
import { Hint } from '../../components/ui/hint.tsx'
import type { RunState } from '../../store/types.ts'
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
      className="space-y-5 border-b border-border px-6 py-5 max-lg:mx-4 max-lg:rounded-card max-lg:border max-lg:bg-surface max-lg:px-4"
    >
      <div>
        <h2 className="mb-1.5 text-meta font-medium text-muted">Target repository</h2>
        <div
          className="flex h-10 min-w-0 items-center gap-2.5 rounded-ctl border border-border bg-bg px-3"
          title="Truss runs in the repo it was started in"
        >
          <FolderGit2 aria-hidden="true" className="size-4 shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate font-mono text-ui text-fg" title={state?.repo}>
            {state?.repo ?? ''}
          </span>
          <Lock aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
        </div>
      </div>

      <div>
        <h2 className="mb-1.5 text-meta font-medium text-muted">The idea</h2>
        {goal ? (
          <div className="rounded-ctl border border-brand-line bg-brand-soft p-3.5">
            <p className="text-body font-medium break-words text-fg">{goal.goal ?? 'A run with no goal text.'}</p>
            <p className="mt-2 text-meta text-muted">{approved ?? 'Waiting for your approval.'}</p>
          </div>
        ) : (
          <p className="rounded-ctl border border-dashed border-border-strong p-3.5 text-ui text-muted">
            No goal yet. Type one in the box to start.
          </p>
        )}
      </div>

      {(model || cost) && (
        <div className="flex flex-wrap items-center gap-2 lg:hidden">
          {model && <ModelBadge model={family(model)} size="md">{model}</ModelBadge>}
          <span className="font-mono text-meta tabular-nums text-muted">{cost ?? 'No cost yet'}</span>
        </div>
      )}

      {goal && (
        <div>
          <Button
            variant="secondary"
            size="lg"
            aria-disabled="true"
            aria-describedby="pause-tip"
            className="w-full"
            icon={<Pause aria-hidden="true" />}
          >
            Pause build
          </Button>
          <Hint id="pause-tip" className="mt-1.5">
            Pausing needs a server endpoint that doesn't exist yet.
          </Hint>
        </div>
      )}
    </section>
  )
}
