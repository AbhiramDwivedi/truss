// The one polite region that reads crew status changes (R-44). Always in the DOM, so the first message is heard.
// Silent on the first snapshot and on the first one after a reconnect.
import { useEffect, useRef, useState } from 'react'
import type { Connection, RunState } from '../../store/types.ts'
import { crewAnnouncement } from './announce.ts'

export interface AnnouncerProps {
  state: RunState | null
  connection?: Connection
}

export function Announcer({ state, connection }: AnnouncerProps) {
  const [message, setMessage] = useState('')
  const prev = useRef<RunState | null>(null)

  useEffect(() => {
    // A drop forgets the baseline, so the snapshot that follows is a first one.
    if (connection === 'reconnecting') prev.current = null
  }, [connection])

  useEffect(() => {
    if (state === prev.current) return
    const said = crewAnnouncement(prev.current, state)
    prev.current = state
    if (said) setMessage(said)
  }, [state])

  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  )
}
