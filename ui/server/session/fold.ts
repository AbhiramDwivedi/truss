// Pure folding of SDK messages into the session view (ADR-0011 Decision 2).
// Every value is parsed into the schema's shapes here; unknown messages are ignored (ai rule 8).
import { isObj } from './cards.ts'
import type { Request } from './cards.ts'

export interface Plugin { name: 'truss'; version: string | null; path: string; source: string | null }
export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}
// ADR-0023 gap e: a running token estimate; at is when the last message that changed it arrived.
export interface LiveUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  subagentTokens: number
  totalTokens: number
  at: string
}
export interface Usage { costUsd: number | null; models: Record<string, ModelUsage>; results: number; at: string; live?: LiveUsage }
export interface BackgroundTask { taskId: string; description: string; subagentType: string | null }
export type Intent = 'goal' | 'add' | null
// ADR-0023 gap b: an accepted message the SDK has not yet taken.
export interface QueueItem { id: string; text: string; intent: Intent; at: string }
// The running sums behind usage.live, kept off the wire: it is counted before the first result, when usage is null.
export interface Tally { seen: readonly string[]; tasks: Record<string, number>; live: LiveUsage | null }
export interface SessionState {
  status: 'idle' | 'running' | 'waiting' | 'ended' | 'error'
  sessionId: string | null
  model: string | null
  claudeCodeVersion: string | null
  permissionMode: string | null
  plugin: Plugin | null
  usage: Usage | null
  backgroundTasks: BackgroundTask[]
  error: string | null
  queue: QueueItem[]
  flow?: FlowEntry[]
}
// ADR-0028 section 7: one hand-off the PM made, folded from its own top-level tool_use blocks.
export interface FlowEntry { at: string; tool: 'Agent' | 'SendMessage' | 'Workflow'; to: string | null; summary: string }
export interface TranscriptEntry {
  n: number
  role: 'user' | 'assistant' | 'error'
  text: string
  ts: string
  id: string | null
  intent: Intent
}
export interface SessionView { session: SessionState; requests: Request[]; transcript: TranscriptEntry[]; tally: Tally
  // ADR-0028 section 6: the latest description per task_id, oldest first, at most KEEP. Beside `session`, so the snapshot is unchanged.
  taskDescriptions?: Map<string, string>
}

const KEEP = 500
const FLOW_KEEP = 200
const SUMMARY_MAX = 200
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0)

export function initialView(): SessionView {
  return {
    session: {
      status: 'idle', sessionId: null, model: null, claudeCodeVersion: null, permissionMode: null,
      plugin: null, usage: null, backgroundTasks: [], error: null, queue: [],
    },
    requests: [],
    transcript: [],
    tally: { seen: [], tasks: {}, live: null },
  }
}

function withSession(view: SessionView, patch: Partial<SessionState>): SessionView {
  return { ...view, session: { ...view.session, ...patch } }
}

export function addEntries(
  view: SessionView,
  role: TranscriptEntry['role'],
  texts: string[],
  meta: { id: string | null; intent: Intent } = { id: null, intent: null },
): SessionView {
  if (texts.length === 0) return view
  const ts = new Date().toISOString()
  let n = view.transcript.length ? view.transcript[view.transcript.length - 1]!.n : 0
  const added = texts.map((text) => ({ n: ++n, role, text, ts, id: meta.id, intent: meta.intent }))
  return { ...view, transcript: [...view.transcript, ...added].slice(-KEEP) }
}

// A user entry carries the id and intent of the message that made it (ADR-0023 gap a).
export const addUserEntry = (view: SessionView, text: string, id: string, intent: Intent) =>
  addEntries(view, 'user', [text], { id, intent })
export const setRunning = (view: SessionView) =>
  view.session.status === 'running' ? view : withSession(view, { status: 'running' })
export const endView = (view: SessionView) =>
  view.session.status === 'ended' || view.session.status === 'error' ? view : withSession(view, { status: 'ended' })
export function errorView(view: SessionView, message: string): SessionView {
  const first = (message.split('\n')[0] ?? '').slice(0, 500)
  return addEntries(withSession(view, { status: 'error', error: first }), 'error', [first])
}

function foldInit(view: SessionView, msg: Record<string, unknown>): SessionView {
  let plugin: Plugin | null = null
  for (const p of Array.isArray(msg.plugins) ? msg.plugins : []) {
    if (isObj(p) && p.name === 'truss' && typeof p.path === 'string') {
      plugin = { name: 'truss', version: str(p.version), path: p.path, source: str(p.source) }
      break
    }
  }
  return withSession(view, {
    status: 'running',
    sessionId: str(msg.session_id),
    model: str(msg.model),
    claudeCodeVersion: str(msg.claude_code_version),
    permissionMode: str(msg.permissionMode),
    plugin,
  })
}

function foldResult(view: SessionView, msg: Record<string, unknown>): SessionView {
  const models: Record<string, ModelUsage> = {}
  if (isObj(msg.modelUsage)) {
    for (const [k, v] of Object.entries(msg.modelUsage)) {
      if (!isObj(v)) continue
      models[k] = {
        inputTokens: count(v.inputTokens),
        outputTokens: count(v.outputTokens),
        cacheReadInputTokens: count(v.cacheReadInputTokens),
        cacheCreationInputTokens: count(v.cacheCreationInputTokens),
      }
    }
  }
  const cost = msg.total_cost_usd
  const at = new Date().toISOString()
  // No counted message yet: live is zero as of this result, not a guess.
  const live = view.tally.live ?? { ...ZERO, at }
  return withSession({ ...view, tally: { ...view.tally, live } }, {
    status: 'waiting',
    usage: {
      costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
      models,
      results: (view.session.usage?.results ?? 0) + 1,
      at,
      live,
    },
  })
}

const ZERO = {
  inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, subagentTokens: 0, totalTokens: 0,
}

// Sets the tally; live (and usage.live once usage exists) moves only when a counter changed.
function withTally(view: SessionView, seen: readonly string[], tasks: Record<string, number>, add: ModelUsage): SessionView {
  const prev = view.tally.live ?? { ...ZERO, at: '' }
  const subagentTokens = Object.values(tasks).reduce((a, b) => a + b, 0)
  const next = {
    inputTokens: prev.inputTokens + add.inputTokens,
    outputTokens: prev.outputTokens + add.outputTokens,
    cacheReadInputTokens: prev.cacheReadInputTokens + add.cacheReadInputTokens,
    cacheCreationInputTokens: prev.cacheCreationInputTokens + add.cacheCreationInputTokens,
    subagentTokens,
  }
  const totalTokens =
    next.inputTokens + next.outputTokens + next.cacheReadInputTokens + next.cacheCreationInputTokens + next.subagentTokens
  const changed = totalTokens !== prev.totalTokens || subagentTokens !== prev.subagentTokens
  if (!changed) return { ...view, tally: { ...view.tally, seen, tasks } }
  const live: LiveUsage = { ...next, totalTokens, at: new Date().toISOString() }
  const usage = view.session.usage
  const out = { ...view, tally: { seen, tasks, live } }
  return usage ? withSession(out, { usage: { ...usage, live } }) : out
}

// seen keeps only the most recent message ids: a message's content blocks arrive back to back with one id,
// so a recent window still counts each id once while the cost per message stays fixed.
const SEEN_KEEP = 256

function foldAssistantUsage(view: SessionView, msg: Record<string, unknown>): SessionView {
  if (msg.parent_tool_use_id || !isObj(msg.message)) return view
  const id = msg.message.id
  const u = msg.message.usage
  // Counted once per message id: the stream repeats one message's usage on each content block.
  if (typeof id !== 'string' || !isObj(u) || view.tally.seen.includes(id)) return view
  // A new seen with id added last, in arrival order, so the first ids are the oldest. An array, not a Record:
  // a Record lists integer-like keys in numeric order, not insertion order.
  const old = view.tally.seen
  const seen = [...old.slice(Math.max(0, old.length - SEEN_KEEP + 1)), id]
  return withTally(view, seen, view.tally.tasks, {
    inputTokens: count(u.input_tokens),
    outputTokens: count(u.output_tokens),
    cacheReadInputTokens: count(u.cache_read_input_tokens),
    cacheCreationInputTokens: count(u.cache_creation_input_tokens),
  })
}

function foldTaskProgress(view: SessionView, msg: Record<string, unknown>): SessionView {
  if (typeof msg.task_id !== 'string' || !isObj(msg.usage) || typeof msg.usage.total_tokens !== 'number') return view
  const total = count(msg.usage.total_tokens)
  // The latest total for a task replaces the earlier one.
  if (view.tally.tasks[msg.task_id] === total) return view
  return withTally(view, view.tally.seen, { ...view.tally.tasks, [msg.task_id]: total }, {
    inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
  })
}

function foldTaskDescription(view: SessionView, msg: Record<string, unknown>): SessionView {
  const description = str(msg.description)
  if (typeof msg.task_id !== 'string' || description === null) return view
  // O(1) per message: the Map is updated in place (delete then set moves the id to the newest end), the oldest key past KEEP is dropped.
  const map = view.taskDescriptions ?? new Map<string, string>()
  map.delete(msg.task_id)
  map.set(msg.task_id, description)
  if (map.size > KEEP) map.delete(map.keys().next().value as string)
  return { ...view, taskDescriptions: map }
}

const FLOW_TOOLS = ['Agent', 'SendMessage', 'Workflow'] as const
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The longest slug that stands as a whole word (not inside a longer slug-like word) in the first field that holds one.
function slugIn(fields: unknown[], slugs: readonly string[]): string | null {
  const sorted = [...slugs].filter((s) => s !== '').sort((a, b) => b.length - a.length)
  for (const f of fields) {
    if (typeof f !== 'string') continue
    for (const s of sorted) if (new RegExp(`(?<![\\w-])${escapeRe(s)}(?![\\w-])`).test(f)) return s
  }
  return null
}

function foldFlow(view: SessionView, content: unknown[], slugs: readonly string[]): SessionView {
  const added: FlowEntry[] = []
  for (const b of content) {
    if (!isObj(b) || b.type !== 'tool_use' || !FLOW_TOOLS.includes(b.name as never) || !isObj(b.input)) continue
    const tool = b.name as FlowEntry['tool']
    const inp = b.input
    const raw = tool === 'SendMessage' ? str(inp.message) : str(inp.description)
    const summary = (raw ?? '').split('\n')[0]!.slice(0, SUMMARY_MAX)
    added.push({ at: new Date().toISOString(), tool, to: slugIn([inp.to, inp.description, inp.prompt], slugs), summary })
  }
  if (added.length === 0) return view
  return withSession(view, { flow: [...(view.session.flow ?? []), ...added].slice(-FLOW_KEEP) })
}

export function foldMessage(view: SessionView, msg: unknown, crewSlugs: readonly string[] = []): SessionView {
  if (!isObj(msg)) return view
  if (msg.type === 'system') {
    if (msg.subtype === 'task_started') return foldTaskDescription(view, msg)
    if (msg.subtype === 'init') return foldInit(view, msg)
    if (msg.subtype === 'background_tasks_changed') {
      const tasks: BackgroundTask[] = []
      for (const t of Array.isArray(msg.tasks) ? msg.tasks : []) {
        if (isObj(t) && typeof t.task_id === 'string') {
          tasks.push({ taskId: t.task_id, description: str(t.description) ?? '', subagentType: str(t.subagent_type) })
        }
      }
      return withSession(view, { backgroundTasks: tasks })
    }
    if (msg.subtype === 'task_progress') return foldTaskProgress(foldTaskDescription(view, msg), msg)
    return view
  }
  if (msg.type === 'result') return msg.parent_tool_use_id ? view : foldResult(view, msg)
  if (msg.type === 'assistant') {
    view = foldAssistantUsage(view, msg)
    if (msg.parent_tool_use_id || msg.agent_id) return view
    const content = isObj(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : []
    const texts = content.flatMap((b) =>
      isObj(b) && b.type === 'text' && typeof b.text === 'string' && b.text ? [b.text] : [],
    )
    return addEntries(foldFlow(view, content, crewSlugs), 'assistant', texts)
  }
  return view
}
