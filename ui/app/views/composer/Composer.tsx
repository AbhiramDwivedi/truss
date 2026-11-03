// The Message form (ADR-0023 section 4): what this message is, the goal box with its send button, and
// the Follow-ups list. Ctrl+Enter sends, Enter is a newline; on any failure the text stays in the box.
import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ArrowUp } from 'lucide-react'
import type { RunState } from '../../store/types.ts'
import { postAnswer, postMessage } from '../../store/api.ts'
import { cn } from '../../lib/utils.ts'
import { Button } from '../../components/ui/button.tsx'
import { Textarea } from '../../components/ui/textarea.tsx'
import { InputGroup, InputGroupAction } from '../../components/ui/input-group.tsx'
import { Notice } from '../../components/ui/notice.tsx'
import { Hint } from '../../components/ui/hint.tsx'
import { triggerLook } from '../../components/ui/tabs.tsx'
import { GOAL_BOX_ID, noteResult, openQuestion, reasonOf, usePageFlags } from '../move/format.ts'
import { FollowUps } from './FollowUps.tsx'

export interface ComposerProps {
  state: RunState | null
  now: number
}

type Choice = 'goal' | 'add' | 'answer'

const CHOICES: { value: Choice; label: string; send: string; hint: string }[] = [
  {
    value: 'goal',
    label: 'New goal',
    send: 'Add goal',
    hint: 'A separate goal. Truss plans it on its own and asks you to approve the plan before any crew starts.',
  },
  {
    value: 'add',
    label: 'Add to current goal',
    send: 'Send details',
    hint: "Details for the approved goal. Claude checks them against the frozen scope: a crew that hasn't started takes them in its brief, and anything bigger asks you first.",
  },
  {
    value: 'answer',
    label: 'Answer the question',
    send: 'Send answer',
    hint: 'Your text answers the open question in Your move, as your own answer to each of its questions.',
  },
]

const FIRST_HINT = 'Write the goal to start the session, or a message once it runs. Press Ctrl+Enter to send.'
const QUEUE_NOTE = "Claude's turn is open on your question. Anything you send now waits in the queue and goes out once you answer it."

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
  const [choice, setChoice] = useState<Choice>('add')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const sending = useRef(false)
  const refocus = useRef(false)

  const question = openQuestion(state)
  const hasRun = state !== null && state.run !== null
  const offered = CHOICES.filter((c) => c.value !== 'answer' || question !== null)
  const current: Choice = choice === 'answer' && question === null ? 'add' : choice
  const picked = hasRun ? CHOICES.find((c) => c.value === current)! : null
  const sendName = picked ? picked.send : 'Send'
  const hintId = `${base}-hint`
  const alertId = `${base}-alert`
  const expired = flags.expired

  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    box.current?.focus()
  })

  const send = async () => {
    if (sending.current || expired) return
    if (text.trim() === '') {
      box.current?.focus()
      return
    }
    sending.current = true
    setBusy(true)
    setError(null)
    const intent = picked && picked.value !== 'answer' ? picked.value : undefined
    const res =
      picked?.value === 'answer' && question
        ? await postAnswer(question.id, { answers: Object.fromEntries(question.questions.map((q) => [q.question, text])) })
        : await postMessage(text, intent)
    sending.current = false
    setBusy(false)
    const tokenDead = noteResult(res.status, res.error)
    if (res.status === 202 || res.status === 200) {
      // Clear only what was sent: anything typed while the send was on its way stays in the box.
      const sent = text
      setText((now) => (now.startsWith(sent) ? now.slice(sent.length) : now))
      if (box.current && box.current.value === sent) box.current.style.height = ''
      return
    }
    if (tokenDead) return
    setError(`Not sent: ${reasonOf(res.status, res.error)}. Your text is still here.`)
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
    const next = (i + step + offered.length) % offered.length
    setChoice(offered[next]!.value)
    e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
  }

  return (
    <form
      id="composer"
      aria-label="Message"
      noValidate
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        void send()
      }}
    >
      {question !== null && (
        <Notice tone="signal" live="off">
          {QUEUE_NOTE}
        </Notice>
      )}

      {hasRun && (
        <div
          role="radiogroup"
          aria-label="What this message is"
          className="inline-flex max-w-full items-center gap-0.5 self-start overflow-x-auto rounded-ctl bg-secondary p-0.5 no-scrollbar"
        >
          {offered.map((c, i) => {
            const on = c.value === current
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
                  'data-[state=checked]:bg-surface data-[state=checked]:text-fg data-[state=checked]:shadow-e1 data-[state=checked]:ring-1 data-[state=checked]:ring-border',
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
          aria-label="Goal or message"
          aria-describedby={error ? alertId : hintId}
          aria-invalid={error ? true : undefined}
          rows={3}
          placeholder={hasRun ? 'Type a message' : 'Type a goal'}
          className="max-h-[60vh] resize-y"
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
            aria-disabled={expired || undefined}
            icon={<ArrowUp aria-hidden="true" />}
            className="bg-move text-move-fg hover:bg-move/90 [.dark_&]:hover:bg-move/90"
          >
            {sendName}
          </Button>
        </InputGroupAction>
      </InputGroup>

      {error ? (
        <p id={alertId} role="alert" className="text-ui text-fail-text">
          {error}
        </p>
      ) : (
        <Hint id={hintId}>{picked ? picked.hint : FIRST_HINT}</Hint>
      )}

      <FollowUps state={state} now={now} />
    </form>
  )
}
