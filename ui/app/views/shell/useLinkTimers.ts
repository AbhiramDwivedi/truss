// How long the link has been not live: 5 s changes the Session line, 20 s makes the server unreachable. The timers
// start at mount, clear when the link is live and restart from 0 on each drop. Banner and App each read it.
import { useEffect, useState } from 'react'
import type { Connection } from '../../store/types.ts'

/** How long a link that is not live waits before the Session line says it is still connecting. */
export const SLOW_MS = 5_000
/** How long before the page says it can't reach the server and offers Reload. */
export const UNREACHABLE_MS = 20_000

export function useLinkTimers(connection: Connection): { slow: boolean; unreachable: boolean } {
  const [slow, setSlow] = useState(false)
  const [unreachable, setUnreachable] = useState(false)
  const live = connection === 'live'
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
  return { slow, unreachable: unreachable && !live }
}
