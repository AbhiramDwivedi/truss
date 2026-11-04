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
  approvalAsk: boolean
}

// ADR-0028 section 2: true only when the last non-empty paragraph has `approve` or `approval` as a word, ends with `?`,
// and has no `no` or `nothing` before that word in the same sentence. Unsure means false.
export function isApprovalAsk(text: string): boolean {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== '')
  const last = paras[paras.length - 1]
  if (last === undefined || !last.endsWith('?')) return false
  for (const sentence of last.split(/(?<=[.!?])\s+/)) {
    const m = /\b(approve|approval)\b/i.exec(sentence)
    if (m && !/\b(no|nothing)\b/i.test(sentence.slice(0, m.index))) return true
  }
  return false
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
    return { state: { turnRunning: false, held: null }, open: { ...reply, backgroundTasks, approvalAsk: isApprovalAsk(reply.text) } }
  }
  if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
    if (backgroundTasks === 0 && !state.turnRunning && state.held) {
      return { state: { ...state, held: null }, open: { ...state.held, backgroundTasks, approvalAsk: isApprovalAsk(state.held.text) } }
    }
  }
  return { state, open: null }
}
