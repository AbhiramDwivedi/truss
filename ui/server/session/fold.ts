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
export interface Usage { costUsd: number | null; models: Record<string, ModelUsage>; results: number; at: string }
export interface BackgroundTask { taskId: string; description: string; subagentType: string | null }
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
}
export interface TranscriptEntry { n: number; role: 'user' | 'assistant' | 'error'; text: string; ts: string }
export interface SessionView { session: SessionState; requests: Request[]; transcript: TranscriptEntry[] }

const KEEP = 500
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0)

export function initialView(): SessionView {
  return {
    session: {
      status: 'idle', sessionId: null, model: null, claudeCodeVersion: null, permissionMode: null,
      plugin: null, usage: null, backgroundTasks: [], error: null,
    },
    requests: [],
    transcript: [],
  }
}

function withSession(view: SessionView, patch: Partial<SessionState>): SessionView {
  return { ...view, session: { ...view.session, ...patch } }
}

export function addEntries(view: SessionView, role: TranscriptEntry['role'], texts: string[]): SessionView {
  if (texts.length === 0) return view
  const ts = new Date().toISOString()
  let n = view.transcript.length ? view.transcript[view.transcript.length - 1]!.n : 0
  const added = texts.map((text) => ({ n: ++n, role, text, ts }))
  return { ...view, transcript: [...view.transcript, ...added].slice(-KEEP) }
}

export const addUserEntry = (view: SessionView, text: string) => addEntries(view, 'user', [text])
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
  return withSession(view, {
    status: 'waiting',
    usage: {
      costUsd: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
      models,
      results: (view.session.usage?.results ?? 0) + 1,
      at: new Date().toISOString(),
    },
  })
}

export function foldMessage(view: SessionView, msg: unknown): SessionView {
  if (!isObj(msg)) return view
  if (msg.type === 'system') {
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
    return view
  }
  if (msg.type === 'result') return msg.parent_tool_use_id ? view : foldResult(view, msg)
  if (msg.type === 'assistant') {
    if (msg.parent_tool_use_id || msg.agent_id) return view
    const content = isObj(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : []
    const texts = content.flatMap((b) =>
      isObj(b) && b.type === 'text' && typeof b.text === 'string' && b.text ? [b.text] : [],
    )
    return addEntries(view, 'assistant', texts)
  }
  return view
}
