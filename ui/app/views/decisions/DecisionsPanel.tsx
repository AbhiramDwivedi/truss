// The Decisions and ADRs tab's body (ADR-0018 section 10, ADR-0023 section 4 "decisions"): a Decisions region
// with an h3 per `## Run` heading and one item per decision line in file order, and an ADRs region with each
// card and its status in words (AdrSection). No "Plan revision" text (gap c).
import type { Decision, RunState } from '../../store/types.ts'
import { AdrSection } from './AdrSection.tsx'

export interface DecisionsPanelProps {
  state: RunState | null
  now: number
}

type Group = { run: string | null; items: Decision[] }

function groups(decisions: Decision[]): Group[] {
  const out: Group[] = []
  for (const d of decisions) {
    const last = out[out.length - 1]
    if (last && last.run === d.run) last.items.push(d)
    else out.push({ run: d.run, items: [d] })
  }
  return out
}

/** `2026-11-02T11:00:00Z | Add quotas.` reads as its goal, with the stamp beside it. */
function runTitle(run: string | null): { title: string; when: string } {
  if (run == null) return { title: 'Before the first run', when: '' }
  const [when, ...rest] = run.split(' | ')
  return rest.length ? { title: `Run: ${rest.join(' | ')}`, when: when ?? '' } : { title: `Run ${run}`, when: '' }
}

function DecisionLine({ d }: { d: Decision }) {
  const [first = '', ...more] = d.text.split('\n')
  const parts = first.split(' | ')
  const time = /^\d\d:\d\d$/.test(parts[0] ?? '') ? parts.shift()! : ''
  const head = parts.shift() ?? ''
  return (
    <li className="flex min-w-0 gap-3 border-t border-border py-2 first:border-t-0">
      <span className="w-11 shrink-0 font-mono text-micro tabular-nums text-muted">{time}</span>
      <span className="min-w-0 flex-1 break-words">
        <span className="text-ui font-semibold text-fg">{head}</span>
        {parts.length > 0 && <span className="text-meta text-muted"> | {parts.join(' | ')}</span>}
        {more.map((m, i) => (
          <span key={i} className="block text-meta text-muted">
            {m.trim()}
          </span>
        ))}
      </span>
    </li>
  )
}

export function DecisionsPanel({ state }: DecisionsPanelProps) {
  const decisions = state?.decisions ?? []
  const adrs = state?.adrs ?? []
  return (
    <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <section aria-labelledby="decisions-h" className="min-w-0 rounded-card border border-border bg-surface p-4 shadow-e1">
        <h2 id="decisions-h" className="mb-3 text-body font-semibold text-fg">
          Decisions
        </h2>
        {decisions.length === 0 ? (
          <p className="text-ui text-muted">No decisions recorded yet.</p>
        ) : (
          <div className="space-y-4">
            {groups(decisions).map((g, i) => {
              const t = runTitle(g.run)
              return (
                <div key={`${g.run ?? ''}-${i}`} className="min-w-0">
                  <h3 className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-ui font-semibold text-fg">
                    <span className="min-w-0 break-words">{t.title}</span>
                    {t.when && <span className="font-mono text-micro font-normal text-muted">{t.when}</span>}
                  </h3>
                  <ul aria-label={`Decisions of ${t.title}`} className="mt-1">
                    {g.items.map((d) => (
                      <DecisionLine key={d.n} d={d} />
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section aria-labelledby="adrs-h" className="min-w-0 rounded-card border border-border bg-surface p-4 shadow-e1">
        <h2 id="adrs-h" className="mb-3 text-body font-semibold text-fg">
          ADRs
        </h2>
        {adrs.length === 0 ? (
          <p className="text-ui text-muted">No ADR files found.</p>
        ) : (
          <AdrSection adrs={adrs} />
        )}
      </section>
    </div>
  )
}
