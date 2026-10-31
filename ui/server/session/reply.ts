// When a reply card opens (ADR-0014 Decision 3). Pure: no SDK, no registry, no mutation of its input.
import { isObj } from './cards.ts'

export interface HeldReply {
  text: string
  isError: boolean
}
export interface ReplyState {
  turnRunning: boolean
  held: HeldReply | null
}
export interface ReplyOpen {
  text: string
  isError: boolean
  backgroundTasks: number
}

// `backgroundTasks` is the count after the message was folded.
export function replyStep(
  state: ReplyState,
  msg: unknown,
  backgroundTasks: number,
): { state: ReplyState; open: ReplyOpen | null } {
  if (!isObj(msg)) return { state, open: null }
  if (msg.type === 'system' && msg.subtype === 'init') {
    return { state: { turnRunning: true, held: null }, open: null }
  }
  if (msg.type === 'result' && !msg.parent_tool_use_id) {
    const reply = { text: typeof msg.result === 'string' ? msg.result : '', isError: msg.is_error === true }
    if (backgroundTasks > 0) return { state: { turnRunning: false, held: reply }, open: null }
    return { state: { turnRunning: false, held: null }, open: { ...reply, backgroundTasks } }
  }
  if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
    if (backgroundTasks === 0 && !state.turnRunning && state.held) {
      return { state: { ...state, held: null }, open: { ...state.held, backgroundTasks } }
    }
  }
  return { state, open: null }
}
