// The page (ADR-0028 section 10). App is the only reader of the store: it passes { state, now } to every area
// root. At 1024 px and up there are two columns: a sticky 400 px rail (header, run context, conversation, timeline)
// beside main (Your move, the network, deliverables, run metrics). Below 1024 px there is one column in DOM order.
// Both arrangements come from one map of keyed areas, so the conversation keeps its parent and key across a resize.
import { useEffect, useState, type ReactNode } from 'react'
import { useConnection, useRun } from './store/react.ts'
import { Composer } from './views/composer/Composer.tsx'
import { BuildNetwork } from './views/crews/BuildNetwork.tsx'
import { RetroRail } from './views/crews/RetroRail.tsx'
import { Deliverables } from './views/deliverables/Deliverables.tsx'
import { RunMetrics } from './views/metrics/RunMetrics.tsx'
import { YourMove } from './views/move/YourMove.tsx'
import { RunContext } from './views/rail/RunContext.tsx'
import { Timeline } from './views/rail/Timeline.tsx'
import { Announcer } from './views/shell/Announcer.tsx'
import { Banner } from './views/shell/Banner.tsx'
import { SkipLink } from './views/shell/SkipLink.tsx'
import { useInstantThemeSwitch } from './views/shell/instantTheme.ts'
import { useWide } from './views/shell/useWide.ts'
import { Transcript } from './views/transcript/Transcript.tsx'

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

export default function App() {
  const state = useRun((s) => s)
  const connection = useConnection()
  const now = useNow()
  const wide = useWide()
  useInstantThemeSwitch()

  const props = { state, now }
  // Below 1024 px every area sits in a 16 px gutter; in the rail and in main the column sets the margins.
  const gutter = wide ? 'min-w-0 empty:hidden' : 'mx-4 min-w-0 empty:hidden'

  const hasOpenRequest = state?.requests.some((r) => r.status === 'open') ?? false
  const skipTarget = wide ? '#main' : hasOpenRequest ? '#your-move' : '#conversation'

  // The thread is drawn above the composer. At 1024 px and up the composer is first in the DOM (tab order: header,
  // composer, thread), so the block is reversed; below 1024 px the thread is first.
  const thread = <Transcript key="thread" {...props} />
  const composer = <Composer key="composer" {...props} />
  const areas: Record<string, ReactNode> = {
    banner: (
      <div key="banner" className="min-w-0">
        <Banner {...props} connection={connection} />
      </div>
    ),
    announcer: <Announcer key="announcer" state={state} connection={connection} />,
    context: (
      <div key="context" className={gutter}>
        <RunContext {...props} />
      </div>
    ),
    move: (
      <div key="move" className={gutter}>
        {state ? <YourMove {...props} /> : null}
      </div>
    ),
    conversation: (
      <div
        key="conversation"
        id="conversation"
        tabIndex={-1}
        className={`${wide ? 'mx-4 flex flex-col-reverse' : 'mx-4 flex flex-col'} min-w-0 gap-3 outline-none`}
      >
        {wide ? [composer, thread] : [thread, composer]}
      </div>
    ),
    timeline: (
      <div key="timeline" className={wide ? 'min-w-0' : gutter}>
        <Timeline {...props} />
      </div>
    ),
  }

  const network = (
    <div key="network" className={gutter}>
      <BuildNetwork {...props} />
      {state?.retro ? <RetroRail {...props} /> : null}
    </div>
  )
  const deliverables = (
    <div key="deliverables" className={gutter}>
      <Deliverables {...props} />
    </div>
  )
  const metrics = (
    <div key="metrics" className={gutter}>
      <RunMetrics {...props} />
    </div>
  )

  return (
    <>
      <SkipLink href={skipTarget} />
      <div className="min-h-screen min-w-0 lg:grid lg:grid-cols-[400px_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-0 lg:h-screen lg:gap-4 lg:overflow-y-auto lg:border-r lg:border-border lg:bg-surface lg:pb-6">
          {areas.banner}
          {areas.announcer}
          {areas.context}
          {wide ? null : areas.move}
          {areas.conversation}
          {wide ? areas.timeline : null}
        </div>
        <main id="main" tabIndex={-1} className="flex min-w-0 flex-col gap-6 pt-6 outline-none lg:px-8 lg:py-6">
          <div className="flex min-w-0 max-w-[1200px] flex-col gap-6 lg:gap-12">
            {wide ? areas.move : null}
            {network}
            {deliverables}
            {metrics}
          </div>
        </main>
        {wide ? null : <div className="min-w-0 pt-6 pb-6">{areas.timeline}</div>}
      </div>
    </>
  )
}
