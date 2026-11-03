// The session transcript (ADR-0023 section 4 "transcript"): every entry in order inside one log region. The
// view follows new entries only while the reader sits at the bottom; once they scroll up it holds still and
// offers "New messages" instead. Error entries sit on fail-soft with the word Error beside the text.
import { useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, MessageSquare, TriangleAlert } from 'lucide-react'
import { Button } from '../../components/ui/button.tsx'
import { cn } from '../../lib/utils.ts'
import type { RunState, TranscriptEntry } from '../../store/types.ts'
import { hhmm } from '../rail/format.ts'

export interface TranscriptProps {
  state: RunState | null
  now: number
}

const WHO: Record<TranscriptEntry['role'], string> = { user: 'You', assistant: 'Claude', error: 'Error' }

function Entry({ e }: { e: TranscriptEntry }) {
  const time = hhmm(e.ts)
  const error = e.role === 'error'
  return (
    <li
      className={cn(
        'min-w-0 rounded-ctl px-3 py-2 [content-visibility:auto] [contain-intrinsic-size:auto_3rem]',
        error ? 'bg-fail-soft' : e.role === 'user' ? 'bg-secondary' : '',
      )}
    >
      <p className="flex items-center gap-2 text-meta">
        {error && <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-fail" />}
        <span className={cn('font-semibold', error ? 'text-fail-text' : 'text-fg')}>{WHO[e.role]}</span>
        {time && <span className="font-mono text-micro tabular-nums text-muted">{time}</span>}
      </p>
      <p className="mt-0.5 text-ui whitespace-pre-wrap break-words text-fg">{e.text}</p>
    </li>
  )
}

export function Transcript({ state }: TranscriptProps) {
  const entries = state?.transcript ?? []
  const box = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  const [behind, setBehind] = useState(false)
  const last = entries.length ? entries[entries.length - 1]!.n : -1

  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    if (atBottom.current) el.scrollTop = el.scrollHeight
    else setBehind(true)
  }, [last])

  const onScroll = () => {
    const el = box.current
    if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (atBottom.current) setBehind(false)
  }
  const toBottom = () => {
    const el = box.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    atBottom.current = true
    setBehind(false)
  }

  return (
    <section aria-labelledby="transcript-h" className="relative min-w-0">
      <div className="mb-3 flex items-center gap-2.5">
        <MessageSquare aria-hidden="true" className="size-5 shrink-0 text-muted" />
        <h2 id="transcript-h" className="text-title font-semibold text-fg">
          Transcript
        </h2>
        {entries.length > 0 && <span className="text-ui tabular-nums text-muted">{entries.length}</span>}
      </div>
      <div
        ref={box}
        role="log"
        aria-label="Transcript"
        tabIndex={0}
        onScroll={onScroll}
        className="max-h-160 min-w-0 overflow-y-auto rounded-card border border-border bg-surface p-1.5 shadow-e1"
      >
        {entries.length === 0 ? (
          <p className="p-3 text-ui text-muted">Nothing said yet.</p>
        ) : (
          <ol className="space-y-1">
            {entries.map((e) => (
              <Entry key={e.id ?? e.n} e={e} />
            ))}
          </ol>
        )}
      </div>
      {behind && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button size="sm" className="pointer-events-auto shadow-e2" icon={<ArrowDown aria-hidden="true" />} onClick={toBottom}>
            New messages
          </Button>
        </div>
      )}
    </section>
  )
}
