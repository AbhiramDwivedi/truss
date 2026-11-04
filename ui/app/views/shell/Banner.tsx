// The page banner (ADR-0023 section 4): the mark, the Session status, the model and what the session
// has spent, and the notifications and theme toggles. It never shows the goal and never a limit.
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Bell, BellRing, Moon, RotateCw, Sun } from 'lucide-react'
import type { Connection, Request, RunState } from '../../store/types.ts'
import { useTheme } from '../../lib/theme.ts'
import { Button } from '../../components/ui/button.tsx'
import { Notice } from '../../components/ui/notice.tsx'
import { Dot, LivePing } from '../../components/ui/dot.tsx'
import { sessionWords, usePageFlags } from '../move/format.ts'
import { RunStatusBadge } from '../status/RunStatusBadge.tsx'
import { formatRunTime, formatUsd, runTimeMs } from '../metrics/format.ts'
import { runStatusOf } from './runStatus.ts'
import { RunStatus } from './RunStatus.tsx'

/** How long a link that is not live waits before the Session line says it is still connecting. */
export const SLOW_MS = 5_000
/** How long before the header says it can't reach the server and offers Reload. */
export const UNREACHABLE_MS = 20_000

export interface BannerProps {
  state: RunState | null
  now: number
  connection: Connection
}

const btnTarget = 'min-h-6 pointer-coarse:min-h-11 pointer-coarse:min-w-11'

const notifySupported = () => typeof window !== 'undefined' && 'Notification' in window

const notifyTitle = (r: Request) =>
  r.kind === 'question' ? 'Truss: Question from Claude' : r.kind === 'permission' ? `Truss: Approval needed: ${r.toolName}` : null

export function Banner({ state, now, connection }: BannerProps) {
  const { dark, toggle } = useTheme()
  const flags = usePageFlags()
  const [slow, setSlow] = useState(false)
  const [unreachable, setUnreachable] = useState(false)
  const [notifyOn, setNotifyOn] = useState(false)
  const seen = useRef<Set<string> | null>(null)
  const live = connection === 'live'

  // From mount, and again from each drop: 5 s of not being live changes the Session line, 20 s adds Reload.
  useEffect(() => {
    setSlow(false)
    setUnreachable(false)
    if (live) return
    const a = setTimeout(() => setSlow(true), SLOW_MS)
    const b = setTimeout(() => setUnreachable(true), UNREACHABLE_MS)
    return () => {
      clearTimeout(a)
      clearTimeout(b)
    }
  }, [live, connection])

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

  const session = state?.session ?? null
  const status = runStatusOf(state, connection)
  const cost = typeof session?.usage?.costUsd === 'number' ? session.usage.costUsd : 0
  const summary = `${formatUsd(cost)} · ${formatRunTime((state ? runTimeMs(state, now) : null) ?? 0)}`
  const words = slow && !live ? 'Still connecting to the session…' : sessionWords(state, false, flags.expired)
  const working = session !== null && (session.status === 'running' || session.backgroundTasks.length > 0)
  // Same reading as views/status/status.ts: a waiting session with background tasks and no open request.
  const stillRunning =
    session?.status === 'waiting' && session.backgroundTasks.length > 0 && !(state?.requests ?? []).some((q) => q.status === 'open')
  const bad = flags.expired || unreachable || session?.status === 'error'

  // Scroll Run metrics into view and move focus to its heading (the link's own jump leaves focus on the link).
  const toMetrics = (e: MouseEvent<HTMLAnchorElement>) => {
    const section = document.getElementById('run-metrics')
    if (!section) return
    e.preventDefault()
    const h = section.querySelector<HTMLElement>('h2')
    section.scrollIntoView({ block: 'start' })
    h?.focus({ preventScroll: true })
  }

  return (
    <header role="banner" className="flex min-w-0 flex-col gap-2 border-b border-border bg-surface px-4 py-3 lg:px-6">
      <div className="flex h-8 min-w-0 items-center gap-2">
        <img src="/favicon.svg" alt="" width={24} height={24} className="size-6 shrink-0" />
        <h1 className="text-title font-semibold text-fg">Truss</h1>
        <p className="truncate text-meta text-muted">Software factory</p>
      </div>

      <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        <p role="status" aria-label="Run status" className="shrink-0">
          <RunStatusBadge status={status} />
        </p>
        <a
          href="#run-metrics"
          title={summary}
          onClick={toMetrics}
          className={`ml-auto inline-flex min-w-0 items-center truncate whitespace-nowrap rounded-ctl font-mono text-ui tabular-nums text-fg hover:underline ${btnTarget}`}
        >
          {summary}
        </a>
      </div>

      <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          {working ? <LivePing tone="ok" /> : <Dot tone={bad ? 'fail' : session?.status === 'waiting' ? 'signal' : 'neutral'} />}
          <p role="status" aria-label="Session" className={bad ? 'min-w-0 text-ui text-fail-text' : 'min-w-0 text-ui text-fg'}>
            {words}
          </p>
          {stillRunning && <p className="min-w-0 text-ui text-muted">Agents still running; nothing needed from you</p>}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className={btnTarget}
            icon={notifyOn ? <BellRing aria-hidden="true" /> : <Bell aria-hidden="true" />}
            aria-disabled={notifyOn || undefined}
            onClick={turnOnNotifications}
          >
            {notifyOn ? 'Notifications on' : 'Turn on notifications'}
          </Button>
          <Button size="icon" variant="ghost" className={btnTarget} aria-label="Dark theme" aria-pressed={dark} onClick={toggle}>
            {dark ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
          </Button>
        </div>
      </div>

      {unreachable && !live && (
        <div role="alert" className="flex min-w-0 flex-col items-start gap-2">
          <Notice tone="fail" live="off" className="w-full">
            Can&apos;t reach the truss UI server. Check it is still running, then reload.
          </Notice>
          <Button size="sm" variant="secondary" className={btnTarget} icon={<RotateCw aria-hidden="true" />} onClick={() => location.reload()}>
            Reload
          </Button>
        </div>
      )}

      <RunStatus state={state} now={now} connection={connection} />
    </header>
  )
}
