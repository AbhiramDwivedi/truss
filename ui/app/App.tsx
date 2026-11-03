// The page (ADR-0023 sections 4 and 5, D2's grid). App is the only reader of the store: it passes
// { state, now } to every area root and owns the Run tab. At 1024 px and up a sticky 400 px rail holds the
// banner, the run context and the timeline beside the main column. Below 1024 px the rail and main dissolve
// (display: contents) and D2's max-lg order stacks every area in one column.
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Skeleton } from './components/ui/skeleton.tsx'
import { useConnection, useRun } from './store/react.ts'
import { Composer } from './views/composer/Composer.tsx'
import { BuildNetwork } from './views/crews/BuildNetwork.tsx'
import { RetroRail } from './views/crews/RetroRail.tsx'
import { Deliverables } from './views/deliverables/Deliverables.tsx'
import { LiveMetrics } from './views/metrics/LiveMetrics.tsx'
import { YourMove } from './views/move/YourMove.tsx'
import { RunContext } from './views/rail/RunContext.tsx'
import { Timeline } from './views/rail/Timeline.tsx'
import { RunTabs, type RunTab } from './views/run/RunTabs.tsx'
import { Banner } from './views/shell/Banner.tsx'
import { RunStatus } from './views/shell/RunStatus.tsx'
import { SkipLink } from './views/shell/SkipLink.tsx'
import { useInstantThemeSwitch } from './views/shell/instantTheme.ts'
import { Transcript } from './views/transcript/Transcript.tsx'

// ADR-0018 section 10: the Design and the Decisions and ADRs panels load as lazy chunks.
const DesignPanel = lazy(() => import('./views/design/DesignPanel.tsx').then((m) => ({ default: m.DesignPanel })))
const DecisionsPanel = lazy(() => import('./views/decisions/DecisionsPanel.tsx').then((m) => ({ default: m.DecisionsPanel })))

const TICK_MS = 1000

/** Wall-clock milliseconds, updated once a second, so every clock on the page agrees. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(id)
  }, [])
  return now
}

const panelLoading = <Skeleton className="h-40 w-full rounded-panel" />

// Below 1024 px every area is a flex item of the page column; these give D2's max-lg order.
const area = 'min-w-0 max-lg:mx-4'

export default function App() {
  const state = useRun((s) => s)
  const connection = useConnection()
  const now = useNow()
  const [tab, setTab] = useState<RunTab>('crews')
  const tabs = useRef<HTMLDivElement>(null)
  const [jump, setJump] = useState(0)
  useInstantThemeSwitch()

  // A link elsewhere (Open log, Open in Design tab) selects a tab: bring the tablist into view and focus it.
  const openTab = useCallback((t: RunTab) => {
    setTab(t)
    setJump((n) => n + 1)
  }, [])
  useEffect(() => {
    if (jump === 0) return
    const box = tabs.current
    if (box === null) return
    box.scrollIntoView({ block: 'start' })
    box.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true })
  }, [jump])

  const props = { state, now }

  return (
    <>
      <SkipLink />
      <div className="flex min-h-screen min-w-0 flex-col gap-6 pb-6 lg:grid lg:grid-cols-[400px_minmax(0,1fr)] lg:gap-0 lg:pb-0">
        {/* The outer box paints the rail column the page's full height; the inner one is the sticky rail. */}
        <div className="contents lg:block lg:min-w-0 lg:border-r lg:border-border lg:bg-surface">
        <div className="contents lg:sticky lg:top-0 lg:flex lg:h-screen lg:min-w-0 lg:flex-col lg:overflow-y-auto">
          <div className="min-w-0 max-lg:order-1">
            <Banner {...props} connection={connection} />
          </div>
          <div className="min-w-0 max-lg:order-5">
            <RunContext {...props} />
          </div>
          <div className="min-w-0 max-lg:order-10">
            <Timeline {...props} onOpenLog={() => openTab('decisions')} />
          </div>
        </div>
        </div>
        <main className="contents lg:flex lg:min-w-0 lg:flex-col lg:gap-6 lg:px-8 lg:py-6">
          <div className={`${area} empty:hidden max-lg:order-4 lg:sticky lg:top-0 lg:z-20 lg:-mx-8 lg:-mt-6 lg:bg-bg/85 lg:px-8 lg:pt-6 lg:pb-3 lg:backdrop-blur`}>
            <LiveMetrics {...props} />
          </div>
          <div className={`${area} max-lg:order-2`}>
            <YourMove {...props} />
          </div>
          <div className={`${area} max-lg:order-3`}>
            <Composer {...props} />
          </div>
          <div ref={tabs} id="run-tabs" className={`${area} scroll-mt-6 max-lg:order-6`}>
            <RunTabs
              tab={tab}
              onTab={setTab}
              crews={
                <>
                  <BuildNetwork {...props} />
                  {state?.retro ? <RetroRail {...props} /> : null}
                </>
              }
              decisions={
                <Suspense fallback={panelLoading}>
                  <DecisionsPanel {...props} />
                </Suspense>
              }
              design={
                <Suspense fallback={panelLoading}>
                  <DesignPanel {...props} />
                </Suspense>
              }
            />
          </div>
          <div className={`${area} max-lg:order-7`}>
            <Deliverables {...props} onOpenDesign={() => openTab('design')} />
          </div>
          <div className={`${area} max-lg:order-8`}>
            <Transcript {...props} />
          </div>
          <div className={`${area} empty:hidden max-lg:order-9`}>
            <RunStatus {...props} connection={connection} />
          </div>
        </main>
      </div>
    </>
  )
}
