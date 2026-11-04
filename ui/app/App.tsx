// The page (ADR-0028 section 10). App is the only reader of the store: it passes { state, now } to every
// area root. At 1024 px and up there are two columns: a sticky 400 px rail (header, run context, the
// conversation, the timeline) beside <main> (Your move, the network, deliverables, run metrics). Below
// 1024 px it is one column and the DOM order is the visual order: no CSS order and no display: contents.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useConnection, useRun } from './store/react.ts'
import { Composer } from './views/composer/Composer.tsx'
import { BuildNetwork } from './views/crews/BuildNetwork.tsx'
import { RetroRail } from './views/crews/RetroRail.tsx'
import { Deliverables } from './views/deliverables/Deliverables.tsx'
import { RunMetrics } from './views/metrics/RunMetrics.tsx'
import { YourMove } from './views/move/YourMove.tsx'
import { RunContext } from './views/rail/RunContext.tsx'
import { Timeline } from './views/rail/Timeline.tsx'
import { Banner } from './views/shell/Banner.tsx'
import { SkipLink } from './views/shell/SkipLink.tsx'
import { useInstantThemeSwitch } from './views/shell/instantTheme.ts'
import { Transcript } from './views/transcript/Transcript.tsx'

const TICK_MS = 1000
const WIDE = '(min-width: 1024px)'

/** Wall-clock milliseconds, updated once a second, so every clock on the page agrees. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(id)
  }, [])
  return now
}

function subscribeWide(onChange: () => void): () => void {
  const mq = window.matchMedia(WIDE)
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

/** True at 1024 px and up. Read synchronously, so the first paint is already in the right layout. */
function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE).matches,
    () => true,
  )
}

// Below 1024 px every area sits in a column with 16 px side margins; the rail and main drop these.
const area = 'min-w-0 max-lg:mx-4'

export default function App() {
  const state = useRun((s) => s)
  const connection = useConnection()
  const now = useNow()
  const wide = useWide()
  useInstantThemeSwitch()

  const props = { state, now }
  // Your move is not rendered while loading, so the network cannot jump down under it.
  const open = state?.requests.some((q) => q.status === 'open') ?? false

  const composer = <Composer key="composer" {...props} />
  const transcript = <Transcript key="transcript" {...props} />

  const move = (
    <div key="move" className={`${area} empty:hidden`}>
      {state ? <YourMove {...props} /> : null}
    </div>
  )

  const areas: Record<string, ReactNode> = {
    banner: <Banner key="banner" {...props} connection={connection} />,
    context: <RunContext key="context" {...props} />,
    // Same parent and key at both widths, so the composer's text and the thread's scroll survive a resize.
    // Wide: the composer is first in the DOM (tab order) and flex-col-reverse draws the thread above it.
    conversation: (
      <div key="conversation" id="conversation" className={`${area} flex scroll-mt-6 gap-3 ${wide ? 'flex-col-reverse' : 'flex-col'}`}>
        {wide ? composer : transcript}
        {wide ? transcript : composer}
      </div>
    ),
    main: (
      <main key="main" id="main" tabIndex={-1} className="flex min-w-0 flex-col gap-6 outline-none max-lg:mx-4 lg:gap-12 lg:px-8 lg:py-6">
        <div className="flex max-w-[1200px] min-w-0 flex-col gap-6 lg:gap-12">
          {wide ? move : null}
          <div className="flex min-w-0 flex-col gap-6">
            <BuildNetwork {...props} />
            {state?.retro ? <RetroRail {...props} /> : null}
          </div>
          <Deliverables {...props} />
          <RunMetrics {...props} />
        </div>
      </main>
    ),
    timeline: <Timeline key="timeline" {...props} />,
  }

  const skip = wide ? '#main' : open ? '#your-move' : '#conversation'

  // One root and one rail element at both widths, so the conversation keeps its parent and key.
  return (
    <>
      <SkipLink href={skip} />
      <div className="flex min-h-screen min-w-0 flex-col gap-6 pb-6 lg:grid lg:grid-cols-[400px_minmax(0,1fr)] lg:gap-0 lg:pb-0">
        <div key="rail" className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto lg:border-r lg:border-border lg:bg-surface">
          {areas.banner}
          {areas.context}
          {wide ? null : move}
          {areas.conversation}
          {wide ? areas.timeline : null}
        </div>
        {areas.main}
        {wide ? null : areas.timeline}
      </div>
    </>
  )
}
