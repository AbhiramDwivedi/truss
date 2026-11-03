// An open question from Claude (ADR-0023 section 4, ADR-0011 R-3). Each question is a radiogroup of
// option cards (checkboxes for multiSelect) with its own `Your own answer` box; the card is one form, so
// Enter in a box submits. Labels are posted exactly as sent, "(Recommended)" and all.
import { useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Send } from 'lucide-react'
import type { Question, QuestionOption, QuestionRequest } from '../../store/types.ts'
import { cn } from '../../lib/utils.ts'
import { Card } from '../../components/ui/card.tsx'
import { Button } from '../../components/ui/button.tsx'
import { Input } from '../../components/ui/input.tsx'
import { Dot } from '../../components/ui/dot.tsx'
import { ago, cardName } from './format.ts'

export interface QuestionCardProps {
  request: QuestionRequest
  /** The oldest open card: the move surface. */
  hero: boolean
  now: number
  busy: boolean
  /** Why the last answer did not go through, in words. */
  error: string | null
  onAnswer: (body: { answers: Record<string, string> }) => void
}

const SUFFIX = /\s*\(Recommended\)\s*$/
const isRecommended = (o: QuestionOption) => o.recommended || SUFFIX.test(o.label)
const shown = (o: QuestionOption) => o.label.replace(SUFFIX, '')

/** Recommended options first, the rest in the order they were sent. */
function ordered(q: Question): QuestionOption[] {
  return [...q.options.filter(isRecommended), ...q.options.filter((o) => !isRecommended(o))]
}

const MISSING = 'Answer every question before submitting: choose an option or type your own.'

export function QuestionCard({ request, hero, now, busy, error, onAnswer }: QuestionCardProps) {
  const base = useId()
  const [picks, setPicks] = useState<string[][]>(() => request.questions.map(() => []))
  const [own, setOwn] = useState<string[]>(() => request.questions.map(() => ''))
  const [missing, setMissing] = useState(false)
  const firstRefs = useRef<(HTMLElement | null)[]>([])
  const first = request.questions[0]
  const alertId = `${base}-alert`
  const shownError = missing ? MISSING : error

  const submit = () => {
    const answers: Record<string, string> = {}
    for (const [qi, q] of request.questions.entries()) {
      const typed = (own[qi] ?? '').trim()
      const chosen = picks[qi] ?? []
      let value: string
      if (q.multiSelect) value = [...chosen, ...(typed ? [typed] : [])].join(', ')
      else value = typed || chosen[0] || ''
      if (value === '') {
        setMissing(true)
        firstRefs.current[qi]?.focus()
        return
      }
      answers[q.question] = value
    }
    setMissing(false)
    onAnswer({ answers })
  }

  const pick = (qi: number, label: string, multi: boolean) => {
    setMissing(false)
    setPicks((all) =>
      all.map((p, i) => {
        if (i !== qi) return p
        if (!multi) return [label]
        return p.includes(label) ? p.filter((x) => x !== label) : [...p, label]
      }),
    )
  }

  return (
    <Card variant={hero ? 'hero' : 'default'} asChild className={hero ? undefined : 'border-brand-line'}>
      <article aria-label={cardName(request)} data-request={request.id} data-open="true">
        <form
          noValidate
          aria-describedby={shownError ? alertId : undefined}
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!busy) submit()
          }}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta">
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-signal-soft px-2.5 font-semibold text-signal-text">
              Your move
            </span>
            <span className={cn('inline-flex items-center gap-1.5 font-medium', hero ? 'text-move-fg' : 'text-fg')}>
              <Dot tone="signal" />
              Question from Claude
            </span>
            {first && <span className={hero ? 'text-move-muted' : 'text-muted'}>{first.header}</span>}
            <span className={cn('ml-auto tabular-nums', hero ? 'text-move-muted' : 'text-muted')}>Asked {ago(request.createdAt, now)}</span>
          </div>

          {request.questions.map((q, qi) => {
            const textId = `${base}-q${qi}`
            const opts = ordered(q)
            const chosen = picks[qi] ?? []
            const checkedAt = opts.findIndex((o) => chosen.includes(o.label))
            const move = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
              if (q.multiSelect) return
              const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0
              if (step === 0) return
              e.preventDefault()
              const next = (i + step + opts.length) % opts.length
              const group = e.currentTarget.closest('[role="radiogroup"]')
              const target = group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]
              target?.focus()
              pick(qi, opts[next]!.label, false)
            }
            return (
              <div key={q.question} className="flex min-w-0 flex-col gap-3">
                <div className="flex min-w-0 flex-col gap-1">
                  {request.questions.length > 1 && (
                    <span className={cn('text-meta font-semibold', hero ? 'text-move-muted' : 'text-muted')}>{q.header}</span>
                  )}
                  <p id={textId} className="max-w-[52ch] text-ask break-words">
                    {q.question}
                  </p>
                  {q.multiSelect && <p className={cn('text-meta', hero ? 'text-move-muted' : 'text-muted')}>Choose any number.</p>}
                </div>
                <div
                  role={q.multiSelect ? 'group' : 'radiogroup'}
                  aria-labelledby={textId}
                  className="grid min-w-0 gap-2 lg:grid-cols-3"
                >
                  {opts.map((o, i) => {
                    const on = chosen.includes(o.label)
                    const rec = isRecommended(o)
                    const label = shown(o)
                    const focusable = q.multiSelect || (checkedAt === -1 ? i === 0 : i === checkedAt)
                    const descId = `${base}-q${qi}-o${i}`
                    // The option card is the click target; the radio inside it holds only the label, so its name
                    // matches its visible text (WCAG 2.5.3). The Recommended chip and the description sit beside
                    // it, the description tied on by aria-describedby. A keyboard click on the radio bubbles here.
                    return (
                      <div
                        key={o.label}
                        data-state={on ? 'checked' : 'unchecked'}
                        data-busy={busy || undefined}
                        onClick={() => {
                          if (!busy) pick(qi, o.label, q.multiSelect)
                        }}
                        className={cn(
                          'group flex min-h-11 min-w-0 cursor-pointer flex-col items-start gap-1 rounded-card border p-3 text-left transition-[border-color] duration-(--duration-quick) ease-out data-busy:cursor-not-allowed data-busy:opacity-60',
                          hero
                            ? 'border-move-line text-move-fg hover:border-move-fg data-[state=checked]:border-move-fg data-[state=checked]:bg-move-fg data-[state=checked]:text-move'
                            : 'border-border bg-surface text-fg hover:border-brand data-[state=checked]:border-brand data-[state=checked]:bg-brand-soft',
                        )}
                      >
                        <span className="flex w-full min-w-0 items-start gap-2">
                          <button
                            ref={(el) => {
                              if (i === 0) firstRefs.current[qi] = el
                            }}
                            type="button"
                            role={q.multiSelect ? 'checkbox' : 'radio'}
                            aria-checked={on}
                            aria-label={rec ? `${label} (Recommended)` : label}
                            aria-describedby={o.description ? descId : undefined}
                            tabIndex={focusable ? 0 : -1}
                            disabled={busy}
                            onKeyDown={(e) => move(e, i)}
                            className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-ctl text-left disabled:cursor-not-allowed"
                          >
                          <span
                            aria-hidden="true"
                            className={cn(
                              'mt-0.5 flex size-4 shrink-0 items-center justify-center border-2',
                              q.multiSelect ? 'rounded-chip' : 'rounded-full',
                              hero ? 'border-move-muted group-data-[state=checked]:border-move' : 'border-subtle group-data-[state=checked]:border-brand',
                            )}
                          >
                            {on && <span className={cn('size-2', q.multiSelect ? 'rounded-xs' : 'rounded-full', hero ? 'bg-move' : 'bg-brand')} />}
                          </span>
                          <span className="min-w-0 flex-1 text-ui font-semibold break-words">{label}</span>
                          </button>
                          {rec && (
                            <span className="inline-flex h-5 shrink-0 items-center rounded-chip bg-move px-1.5 text-micro font-medium text-move-fg ring-1 ring-move-line">
                              Recommended
                            </span>
                          )}
                        </span>
                        {o.description && (
                          <span
                            id={descId}
                            className={cn(
                              'min-w-0 pl-6 text-meta break-words',
                              hero ? 'text-move-muted group-data-[state=checked]:text-move' : 'text-muted',
                            )}
                          >
                            {o.description}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
                <Input
                  aria-label="Your own answer"
                  surface={hero ? 'move' : 'default'}
                  placeholder={q.multiSelect ? 'Or add your own answer' : 'Or type your own answer'}
                  autoComplete="off"
                  value={own[qi] ?? ''}
                  disabled={busy}
                  onChange={(e) => {
                    const v = e.target.value
                    setMissing(false)
                    setOwn((all) => all.map((x, i) => (i === qi ? v : x)))
                  }}
                />
              </div>
            )
          })}

          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <Button type="submit" variant={hero ? 'on-move' : 'primary'} size="lg" busy={busy} icon={<Send aria-hidden="true" />}>
              Submit answers
            </Button>
            {shownError && (
              <p id={alertId} role="alert" className={cn('min-w-0 text-ui', hero ? 'text-move-fg' : 'text-fail-text')}>
                {shownError}
              </p>
            )}
          </div>
        </form>
      </article>
    </Card>
  )
}
