// Tokens by model: one row per model and a Total row. The wrapper scrolls inside itself and takes focus,
// so a narrow screen never scrolls the page and axe finds a focusable scroll region.
import type { ModelUsage } from '../../store/types.ts'
import { Dot, type DotTone } from '../../components/ui/dot.tsx'
import { formatCount } from './format.ts'

type Field = keyof ModelUsage
const COLS: { field: Field; label: string }[] = [
  { field: 'inputTokens', label: 'In' },
  { field: 'outputTokens', label: 'Out' },
  { field: 'cacheReadInputTokens', label: 'Cache read' },
  { field: 'cacheCreationInputTokens', label: 'Cache write' },
]

const toneOf = (name: string): DotTone => (/opus/i.test(name) ? 'opus' : /sonnet/i.test(name) ? 'sonnet' : 'neutral')

const TH = 'px-2 py-2 text-right text-meta font-medium text-muted xl:px-3'
const TD = 'whitespace-nowrap px-2 py-2 xl:px-3 text-right font-mono tabular-nums text-fg'

export interface TokensTableProps {
  models: Record<string, Partial<Record<Field, number | null>>> | null | undefined
  /** Cost reads Not recorded: the empty text says so too. */
  notRecorded?: boolean
}

export function TokensTable({ models, notRecorded = false }: TokensTableProps) {
  const rows = Object.entries(models ?? {})
  if (rows.length === 0) return <p className="px-3 py-2 text-ui text-muted">{notRecorded ? 'Not recorded for this run.' : 'No tokens used yet.'}</p>
  const total = (f: Field) => rows.reduce((sum, [, m]) => sum + (m[f] ?? 0), 0)
  return (
    <div role="region" aria-label="Tokens by model" tabIndex={0} className="overflow-x-auto rounded-card border border-border bg-surface">
      <table className="w-full min-w-max min-[30rem]:min-w-0 border-collapse text-ui">
        <caption className="sr-only">Tokens by model</caption>
        <thead className="bg-sunken">
          <tr>
            <th scope="col" className={TH.replace('text-right', 'text-left')}>
              Model
            </th>
            {COLS.map((c) => (
              <th key={c.field} scope="col" className={TH}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, m]) => (
            <tr key={name} className="border-t border-border">
              <th scope="row" className="px-2 py-2 text-left text-ui font-normal xl:px-3 text-fg [overflow-wrap:anywhere]">
                <span className="inline-flex items-baseline gap-2">
                  <Dot tone={toneOf(name)} className="self-center" />
                  <span>{name}</span>
                </span>
              </th>
              {COLS.map((c) => (
                <td key={c.field} className={TD}>
                  {formatCount(m[c.field])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border-strong bg-sunken">
            <th scope="row" className="px-2 py-2 text-left text-ui font-semibold xl:px-3 text-fg">
              Total
            </th>
            {COLS.map((c) => (
              <td key={c.field} className={TD + ' font-semibold'}>
                {formatCount(total(c.field))}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
