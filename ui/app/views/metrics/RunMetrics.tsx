// Run metrics (ADR-0028 section 8, R-43): what this run has used so far. Cost, run time, agents started
// and crews done as four tiles, then tokens by model. No limit and no budget: only what has been used.
import type { Crew, RunState } from '../../store/types.ts'
import { Skeleton } from '../../components/ui/skeleton.tsx'
import { crewStatus, runStatus } from '../status/status.ts'
import { MetricTile } from './MetricTile.tsx'
import { TokensTable } from './TokensTable.tsx'
import { clockOf, formatRunTime, formatUsd, runTimeMs } from './format.ts'

export interface RunMetricsProps {
  state: RunState | null
  now: number
}

const Dash = () => <span className="text-subtle">—</span>
const agentsOf = (c: Crew) => (c.foreman ? [c.foreman, ...c.members] : c.members)

export function RunMetrics({ state, now }: RunMetricsProps) {
  const usage = state?.session.usage
  const crews = state?.run?.crews ?? null
  const ms = state ? runTimeMs(state, now) : null
  const finished = state != null && runStatus(state) === 'finished'

  const costAt = clockOf(usage?.at)
  const started = clockOf(state?.transcript[0]?.ts)
  const ended = clockOf(state?.transcript.at(-1)?.ts)
  const agents = crews ? crews.flatMap(agentsOf) : null
  const done = crews ? crews.filter((c) => c.status === 'merged' || c.status === 'dropped').length : 0
  const stuck = crews ? crews.filter((c) => crewStatus(c) === 'stuck').length : 0
  const running = crews ? crews.filter((c) => c.status === 'running' && !c.stuck).length : 0
  const noCrews = !crews || crews.length === 0

  return (
    <section id="run-metrics" aria-labelledby="run-metrics-h" className="scroll-mt-6">
      <h2 id="run-metrics-h" tabIndex={-1} className="text-title font-semibold text-fg">
        Run metrics
      </h2>
      {state === null ? (
        <div className="mt-4 grid grid-cols-1 gap-4 min-[30rem]:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-30 rounded-card" />
          ))}
        </div>
      ) : (
        <dl className="mt-4 grid grid-cols-1 gap-4 min-[30rem]:grid-cols-2 xl:grid-cols-4">
          <MetricTile
            label="Cost"
            value={usage && usage.costUsd != null ? formatUsd(usage.costUsd) : <Dash />}
            sub={usage && usage.costUsd != null ? (costAt ? `As of ${costAt}` : 'Updated') : 'No usage yet'}
          />
          <MetricTile
            label="Run time"
            value={ms != null ? formatRunTime(ms) : <Dash />}
            sub={ms == null ? 'No run yet' : finished ? `Finished ${ended ?? ''}`.trim() : `Since ${started ?? ''}`.trim()}
          />
          <MetricTile
            label="Agents started"
            value={noCrews ? <Dash /> : agents!.length}
            sub={noCrews ? 'No crews yet' : `${agents!.filter((a) => a.state === 'reported').length} reported`}
          />
          <MetricTile
            label="Crews done"
            value={noCrews ? <Dash /> : `${done} of ${crews!.length}`}
            sub={noCrews ? 'No crews yet' : `${running} running, ${stuck} stuck`}
          />
        </dl>
      )}
      <h3 className="mt-6 text-body font-semibold text-fg">Tokens by model</h3>
      <div className="mt-3">
        {state === null ? <Skeleton className="h-10 w-full rounded-card" /> : <TokensTable models={usage?.models} />}
      </div>
    </section>
  )
}
