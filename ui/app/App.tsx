// A placeholder until floor-views replaces it: proves the build, the tokens and the store work together.
import { LivePing } from './components/ui/dot.tsx'
import { useConnection } from './store/react.ts'
import type { Connection } from './store/types.ts'

const words: Record<Connection, string> = {
  connecting: 'Connecting to the run…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
}

export default function App() {
  const connection = useConnection()
  return (
    <header role="banner" className="flex min-w-0 items-center gap-3 px-4 py-3">
      <h1 className="text-h1 font-semibold text-fg">Truss</h1>
      <p role="status" className="flex min-w-0 items-center gap-2 text-meta text-muted">
        {connection === 'live' && <LivePing tone="ok" />}
        <span className="min-w-0 truncate">{words[connection]}</span>
      </p>
    </header>
  )
}
