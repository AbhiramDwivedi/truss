// The page banner (ADR-0023 section 4): the mark, the Session status, the model and what the session
// has spent, and the notifications and theme toggles. It never shows the goal and never a limit.
import { useEffect, useRef, useState } from 'react'
import { Bell, BellRing, Moon, RotateCw, Sun } from 'lucide-react'
import type { Connection, Request, RunState } from '../../store/types.ts'
import { pageStore } from '../../store/store.ts'
import { useTheme } from '../../lib/theme.ts'
import { Button } from '../../components/ui/button.tsx'
import { ModelBadge } from '../../components/ui/badge.tsx'
import { Dot, LivePing } from '../../components/ui/dot.tsx'
import { costText, num, sessionWords, usePageFlags } from '../move/format.ts'

/** How long the page waits for a first snapshot before it says it can't reach the session. */
export const STALL_MS = 10_000

export interface BannerProps {
  state: RunState | null
  now: number
  connection: Connection
  /** Reopens the stream; the default restarts the page store. */
  onRetry?: () => void
}

const notifySupported = () => typeof window !== 'undefined' && 'Notification' in window

const notifyTitle = (r: Request) =>
  r.kind === 'question' ? 'Truss: Question from Claude' : r.kind === 'permission' ? `Truss: Approval needed: ${r.toolName}` : null

export function Banner({ state, onRetry }: BannerProps) {
  const { dark, toggle } = useTheme()
  const flags = usePageFlags()
  const [stalled, setStalled] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [notifyOn, setNotifyOn] = useState(false)
  const seen = useRef<Set<string> | null>(null)
  const waiting = state === null

  // No snapshot after STALL_MS: say so, and offer Retry.
  useEffect(() => {
    if (!waiting) {
      setStalled(false)
      return
    }
    const t = setTimeout(() => setStalled(true), STALL_MS)
    return () => clearTimeout(t)
  }, [waiting, attempt])

  useEffect(() => {
    if (notifySupported() && Notification.permission === 'granted') setNotifyOn(true)
  }, [])

  // One notification per newly opened question or permission request; the ones open when notifications
  // came on count as seen.
  const requests = state?.requests
  useEffect(() => {
    if (!notifyOn || !requests) return
    const open = requests.filter((r) => r.status === 'open')
    if (seen.current === null) {
      seen.current = new Set(open.map((r) => r.id))
      return
    }
    for (const r of open) {
      if (seen.current.has(r.id)) continue
      seen.current.add(r.id)
      const title = notifyTitle(r)
      if (title === null || !notifySupported()) continue
      try {
        new Notification(title)
      } catch {
        // a browser that refuses page notifications; the title count still shows it
      }
    }
  }, [notifyOn, requests])

  const turnOnNotifications = async () => {
    if (!notifySupported()) return
    let p: NotificationPermission = Notification.permission
    if (p !== 'granted') {
      try {
        p = await Notification.requestPermission()
      } catch {
        return
      }
    }
    if (p === 'granted') {
      seen.current = new Set((requests ?? []).filter((r) => r.status === 'open').map((r) => r.id))
      setNotifyOn(true)
    }
  }

  const retry = () => {
    setStalled(false)
    setAttempt((n) => n + 1)
    if (onRetry) onRetry()
    else {
      const store = pageStore()
      store.stop()
      store.start()
    }
  }

  const session = state?.session ?? null
  const usage = session?.usage ?? null
  const models = usage ? Object.entries(usage.models) : []
  const words = sessionWords(state, stalled, flags.expired)
  const live = session !== null && (session.status === 'running' || session.backgroundTasks.length > 0)
  const bad = flags.expired || stalled || session?.status === 'error'

  return (
    <header role="banner" className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-4 py-3 lg:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <img src="/favicon.svg" alt="" width={24} height={24} className="size-6 shrink-0" />
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="text-title font-semibold text-fg">Truss</h1>
          <p className="truncate text-meta text-muted max-sm:hidden">Software factory</p>
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        {live ? <LivePing tone="ok" /> : <Dot tone={bad ? 'fail' : session?.status === 'waiting' ? 'signal' : 'neutral'} />}
        <p role="status" aria-label="Session" className={bad ? 'min-w-0 text-ui text-fail-text' : 'min-w-0 text-ui text-fg'}>
          {words}
        </p>
        {stalled && !flags.expired && (
          <Button size="sm" variant="secondary" icon={<RotateCw aria-hidden="true" />} onClick={retry}>
            Retry
          </Button>
        )}
      </div>

      {(session?.model || usage) && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-meta text-muted">
          {session?.model && <ModelBadge model={session.model} />}
          {usage && typeof usage.costUsd === 'number' && (
            <span className="font-mono tabular-nums text-fg" title="Cost so far">
              <span className="sr-only">Cost so far: </span>
              {costText(usage.costUsd)}
              <span className="sr-only">. </span>
            </span>
          )}
          {models.length > 0 && (
            <ul aria-label="Tokens by model" className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
              {models.map(([m, u]) => (
                <li key={m} className="min-w-0 break-words tabular-nums">
                  {m}: {num(u.inputTokens)} in, {num(u.outputTokens)} out, {num(u.cacheReadInputTokens)} cache read,{' '}
                  {num(u.cacheCreationInputTokens)} cache write
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="ghost"
          icon={notifyOn ? <BellRing aria-hidden="true" /> : <Bell aria-hidden="true" />}
          aria-disabled={notifyOn || undefined}
          onClick={turnOnNotifications}
        >
          {notifyOn ? 'Notifications on' : 'Turn on notifications'}
        </Button>
        <Button size="icon" variant="ghost" aria-label="Dark theme" aria-pressed={dark} onClick={toggle}>
          {dark ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
        </Button>
      </div>
    </header>
  )
}
