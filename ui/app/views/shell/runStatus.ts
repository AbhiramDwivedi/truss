// The run-level status for the rail header (ADR-0028 section 9). Pure; the words and icons live in views/status.
import type { Connection, RunState } from '../../store/types.ts'
import { runStatus, type RunStatus } from '../status/status.ts'

/** Not started while there is no snapshot, whatever the connection; otherwise the shared rule. */
export function runStatusOf(state: RunState | null, _connection: Connection): RunStatus {
  return state === null ? 'not-started' : runStatus(state)
}
