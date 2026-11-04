// The Message form (ADR-0028 section 2, R-41): the first send starts a truss run, later sends are messages or a
// new goal. Ctrl+Enter sends, Enter is a newline; on any failure the text stays in the box.
import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ArrowUp, Play, Plus } from 'lucide-react'
import type { RunState } from '../../store/types.ts'
import { postMessage } from '../../store/api.ts'
import { cn } from '../../lib/utils.ts'
import { Button } from '../../components/ui/button.tsx'
import { Textarea } from '../../components/ui/textarea.tsx'
import { InputGroup, InputGroupAction } from '../../components/ui/input-group.tsx'
import { Hint } from '../../components/ui/hint.tsx'
import { triggerLook } from '../../components/ui/tabs.tsx'
import {
  CARD_OPEN_HINT,
  GOAL_BOX_ID,
  NOT_TAKEN,
  STILL_SENDING,
  WORKING_STATUS,
  noteResult,
  notSent,
  openCards,
  reasonOf,
  usePageFlags,
  useSendState,
} from '../move/format.ts'
import { FollowUps } from './FollowUps.tsx'

export interface ComposerProps {
  state: RunState | null
  now: number
}

type Choice = 'message' | 'goal'

const CHOICES: { value: Choice; label: string }[] = [
  { value: 'message', label: 'Message' },
  { value: 'goal', label: 'New goal' },
]

const EXPIRED_HINT = "This page's session has expired. Reload to continue."
const TYPE_FIRST = 'Type a goal first.'
const START_HINT = 'Starts a truss run on this goal.'
const MESSAGE_HINT = 'Sends to the PM as a message.'
const GOAL_HINT = 'Sends to the PM as a new goal for this run.'

function grow(box: HTMLTextAreaElement | null) {
  if (!box) return
  box.style.height = 'auto'
  const edge = box.offsetHeight - box.clientHeight
  box.style.height = `${box.scrollHeight + edge}px`
}

export function Composer({ state, now }: ComposerProps) {
  const base = useId()
  const flags = usePageFlags()
  const [text, setText] = useState('')
  const [choice, setChoice] = useState<Choice>('message')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const sending = useRef(false)
  const refocus = useRef(false)

  // The radiogroup and "Message to the PM" wording appear once a plan exists or a goal was sent (ADR-0028:30).
  const planned =
    state !== null &&
    ((state.run !== null && state.run.version !== null) || state.transcript.some((e) => e.role === 'user' && e.intent === 'goal'))
  const sentAny = state !== null && (state.transcript.some((e) => e.role === 'user') || (state.session.queue ?? []).length > 0)
  const cardOpen = openCards(state).length > 0
  const stage = useSendState(busy, error !== null)
  const expired = flags.expired
  const empty = text.trim() === ''
  const asGoal = !planned || choice === 'goal'
  const lastEntry = state?.transcript[state.transcript.length - 1]
  const working = state?.session.status === 'running' && lastEntry?.role === 'user'

  const sendName = !planned ? 'Start run' : choice === 'goal' ? 'Add as new goal' : 'Send to PM'
  const SendIcon = !planned ? Play : choice === 'goal' ? Plus : ArrowUp
  const hintId = `${base}-hint`
  const alertId = `${base}-alert`
  const stuck = stage === 'stuck' && error === null
  const alertText = error ?? (stuck ? NOT_TAKEN : null)

  let hint: string
  if (expired) hint = EXPIRED_HINT
  else if (cardOpen) hint = CARD_OPEN_HINT
  else if (!planned) hint = empty ? TYPE_FIRST : `${START_HINT} Ctrl+Enter sends.`
  else hint = choice === 'goal' ? GOAL_HINT : MESSAGE_HINT

  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    box.current?.focus()
  })

  const send = async (retry = false) => {
    if ((sending.current && !retry) || expired) return
    if (empty) {
      box.current?.focus()
      return
    }
    sending.current = true
    setBusy(true)
    setError(null)
    const sent = text
    const res = await postMessage(sent, asGoal ? 'goal' : undefined)
    sending.current = false
    setBusy(false)
    const tokenDead = noteResult(res.status, res.error)
    if (res.status === 202 || res.status === 200) {
      // Clear only what was sent: anything typed while the send was on its way stays in the box.
      setText((cur) => (cur.startsWith(sent) ? cur.slice(sent.length) : cur))
      if (box.current && box.current.value === sent) box.current.style.height = ''
      if (planned && choice === 'goal') setChoice('message')
      return
    }
    if (tokenDead) return
    setError(notSent(reasonOf(res.status, res.error)))
    refocus.current = true
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void send()
    }
  }

  const moveChoice = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    const next = (i + step + CHOICES.length) % CHOICES.length
    setChoice(CHOICES[next]!.value)
    e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
  }

  return (
    <form
      id="composer"
      aria-label="Message"
      noValidate
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      <label htmlFor={GOAL_BOX_ID} className="text-meta font-medium text-fg">
        {planned ? 'Message to the PM' : 'Your goal'}
      </label>

      {planned && (
        <div
          role="radiogroup"
          aria-label="Send as"
          className="inline-flex max-w-full items-center gap-0.5 self-start overflow-x-auto rounded-ctl bg-secondary p-0.5 no-scrollbar"
        >
          {CHOICES.map((c, i) => {
            const on = c.value === choice
            return (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={on}
                data-state={on ? 'checked' : 'unchecked'}
                tabIndex={on ? 0 : -1}
                onClick={() => setChoice(c.value)}
                onKeyDown={(e) => moveChoice(e, i)}
                className={cn(
                  triggerLook,
                  'h-8 pointer-coarse:h-11 data-[state=checked]:bg-surface data-[state=checked]:text-fg data-[state=checked]:shadow-e1 data-[state=checked]:ring-1 data-[state=checked]:ring-border',
                )}
              >
                <span className="min-w-0 truncate">{c.label}</span>
              </button>
            )
          })}
        </div>
      )}

      <InputGroup>
        <Textarea
          id={GOAL_BOX_ID}
          ref={box}
          variant="bare"
          aria-describedby={alertText ? alertId : hintId}
          aria-invalid={error ? true : undefined}
          rows={3}
          placeholder={planned ? 'Ask the PM, or add a detail' : 'Describe the goal, for example: add CSV export'}
          className="max-h-[40vh] resize-y"
          value={text}
          disabled={expired}
          onChange={(e) => {
            setText(e.target.value)
            if (error) setError(null)
          }}
          onInput={(e) => grow(e.currentTarget)}
          onKeyDown={onKey}
        />
        <InputGroupAction>
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={expired || empty || busy}
            icon={<SendIcon aria-hidden="true" />}
            className="bg-move text-move-fg hover:bg-move/90 [.dark_&]:hover:bg-move/90 pointer-coarse:h-11"
          >
            {busy ? 'Sending…' : sendName}
          </Button>
        </InputGroupAction>
      </InputGroup>

      <Hint id={hintId}>{hint}</Hint>

      <p role="status" className={cn('text-meta text-muted', stage !== 'slow' && !working && 'sr-only')}>
        {stage === 'slow' ? STILL_SENDING : working ? WORKING_STATUS : ''}
      </p>

      {alertText && (
        <div
          id={alertId}
          role="alert"
          className={cn(
            'flex flex-wrap items-center gap-2 rounded-ctl px-3 py-2 text-ui',
            error ? 'text-fail-text' : 'bg-signal-soft text-signal-text',
          )}
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">{alertText}</span>
          <Button type="button" variant="secondary" size="sm" disabled={busy && !stuck} onClick={() => void send(true)}>
            Try again
          </Button>
        </div>
      )}

      {sentAny && <FollowUps state={state} now={now} />}
    </form>
  )
}
