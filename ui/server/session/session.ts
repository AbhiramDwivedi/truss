// One Claude Code session (ADR-0011 Decisions 2, 3). The only file that touches the Agent SDK.
// Stores nothing: all state is in memory (R-13). No timeout anywhere.
import { isObj, permissionCard, questionCard } from './cards.ts'
import { createRegistry } from './registry.ts'
import type { AnswerResult, Registry } from './registry.ts'
import { addUserEntry, endView, errorView, foldMessage, initialView, setRunning } from './fold.ts'
import type { Intent, QueueItem, SessionView } from './fold.ts'
import { replyStep } from './reply.ts'
import type { ReplyState } from './reply.ts'
import { resolvePlugins } from './plugins.ts'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SessionControl {
  // intent: 'goal', 'add', null or absent (ADR-0023 gap a); any other value is { error: 'intent' }.
  send(text: string, intent?: unknown): { ok: true; id: string } | { ok: false; error: 'text' | 'ended' | 'intent' }
  answer(id: string, body: unknown): AnswerResult
}

// ADR-0023 gap a: the fixed line an intent prepends to the session's input, never to the transcript.
export const INTENT_LINES: Record<'goal' | 'add', string> = {
  goal: '[Truss UI: new goal] Plan this as a new goal for the run.',
  add: '[Truss UI: detail] Add this to the current goal.',
}
// ADR-0028 section 1: the first goal of a session, with no plan yet, starts the run itself.
const toSdk = (m: QueueItem, startsRun = false) =>
  m.intent === 'goal' && startsRun ? `/truss:run ${m.text}` : m.intent ? `${INTENT_LINES[m.intent]}\n\n${m.text}` : m.text

// An injected reader that throws counts as its default: a bad reader must not stop the session.
function safe<T>(fn: (() => T) | undefined, fallback: T): T {
  try {
    return fn ? fn() : fallback
  } catch {
    return fallback
  }
}

// Message ids are unique within one server process; clients compare them and never parse them.
let lastId = 0
const nextId = () => `m${++lastId}`
export interface Session extends SessionControl {
  view(): SessionView
  subscribe(fn: (v: SessionView) => void): () => void
  close(): Promise<void>
}

export function createSession(opts: {
  repo: string
  pluginPath: string
  claudeDir?: string // where installed_plugins.json lives; defaults to CLAUDE_CONFIG_DIR or ~/.claude
  hasPlan?: () => boolean // read when each message is sent (ADR-0028 section 1)
  crewSlugs?: () => string[] // the crew slugs a flow entry's `to` is matched against (ADR-0028 section 7)
}): Session {
  let base: SessionView = initialView()
  const subs = new Set<(v: SessionView) => void>()
  const registry: Registry = createRegistry(() => notify())

  const outbox: QueueItem[] = []
  const queue: QueueItem[] = []
  // session.queue: every accepted message the SDK has not yet taken, oldest first (ADR-0023 gap b).
  const view = (): SessionView => ({
    ...base,
    session: { ...base.session, queue: [...outbox, ...queue] },
    requests: registry.list(),
  })
  function notify() {
    if (subs.size === 0) return
    const v = view()
    for (const fn of [...subs]) {
      try {
        fn(v)
      } catch {
        // a bad subscriber must not break the session
      }
    }
  }
  const update = (next: SessionView) => {
    base = next
    notify()
  }

  let started = false
  let goalSent = false
  let closed = false
  let reply: ReplyState = { turnRunning: false, held: null }
  let wake: (() => void) | undefined
  let query: { interrupt(): Promise<unknown> } | undefined
  let loop: Promise<void> = Promise.resolve()

  async function* input() {
    while (true) {
      while (outbox.length === 0) {
        if (closed) return
        await new Promise<void>((r) => (wake = r))
      }
      const m = outbox.shift()!
      notify() // the message leaves session.queue as the SDK takes it
      let startsRun = false
      if (m.intent === 'goal') {
        startsRun = !goalSent && !safe(opts.hasPlan, false)
        goalSent = true
      }
      yield { type: 'user' as const, message: { role: 'user' as const, content: toSdk(m, startsRun) }, parent_tool_use_id: null }
    }
  }

  function dispatch(m: QueueItem) {
    reply = { ...reply, turnRunning: true }
    outbox.push(m)
    wake?.()
    update(setRunning(base))
  }

  function enqueue(text: string, intent: Intent): string {
    const m: QueueItem = { id: nextId(), text, intent, at: new Date().toISOString() }
    base = addUserEntry(base, text, m.id, intent)
    if (!started) {
      started = true
      loop = run()
    }
    if (reply.turnRunning) {
      queue.push(m)
      notify()
    } else dispatch(m)
    return m.id
  }

  const openReplies = () => registry.list().filter((r) => r.kind === 'reply' && r.status === 'open')
  const finished = () => closed || base.session.status === 'ended' || base.session.status === 'error'

  function canUseTool(toolName: string, toolInput: Record<string, unknown>, options: unknown): Promise<unknown> {
    const card = toolName === 'AskUserQuestion' ? questionCard(toolInput) : permissionCard(toolName, toolInput, options)
    const { id, settled } = registry.open(card)
    const signal = isObj(options) ? (options.signal as AbortSignal | undefined) : undefined
    if (signal) {
      if (signal.aborted) registry.cancel(id, 'aborted')
      else signal.addEventListener('abort', () => registry.cancel(id, 'aborted'), { once: true })
    }
    return settled
  }

  function onMessage(msg: unknown) {
    base = foldMessage(base, msg, safe(opts.crewSlugs, []))
    const step = replyStep(reply, msg, base.session.backgroundTasks.length)
    reply = step.state
    if (isObj(msg) && msg.type === 'system' && msg.subtype === 'init') {
      // A turn the session started by itself: no client send answered the open reply card.
      for (const r of openReplies()) registry.cancel(r.id, 'superseded')
    }
    let id: string | undefined
    if (step.open) id = registry.open({ kind: 'reply', ...step.open, decision: null, message: null }).id
    // A top-level result ends the turn: a queued message goes out, answering the card when one opened.
    if (isObj(msg) && msg.type === 'result' && !msg.parent_tool_use_id) {
      const queued = queue.shift()
      if (queued !== undefined) {
        if (id !== undefined) registry.answer(id, { decision: 'message', message: queued.text })
        dispatch(queued)
        return
      }
    }
    notify()
  }

  function finish(next: (v: SessionView) => SessionView) {
    for (const r of registry.list()) if (r.status === 'open') registry.cancel(r.id, 'ended')
    update(next(base))
  }

  async function run() {
    try {
      const { query: sdkQuery } = await import('@anthropic-ai/claude-agent-sdk')
      if (closed) return
      const q = sdkQuery({
        prompt: input(),
        options: {
          cwd: opts.repo,
          plugins: resolvePlugins(opts.pluginPath, opts.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')).plugins,
          canUseTool: (toolName: string, toolInput: Record<string, unknown>, o: unknown) =>
            canUseTool(toolName, toolInput, o),
          hooks: { PreToolUse: [{ hooks: [async () => ({})] }] },
        },
      } as any)
      query = q as any
      for await (const msg of q) onMessage(msg)
      finish(endView)
    } catch (e) {
      if (closed) {
        finish(endView)
        return
      }
      finish((v) => errorView(v, e instanceof Error ? e.message : String(e)))
    }
  }

  return {
    view,
    subscribe(fn) {
      subs.add(fn)
      // The subscriber starts from the current view, so an idle session's fields (queue: []) reach it too.
      try {
        fn(view())
      } catch {
        // a bad subscriber must not break the session
      }
      return () => {
        subs.delete(fn)
      }
    },
    send(text, intent) {
      if (intent !== undefined && intent !== null && intent !== 'goal' && intent !== 'add') return { ok: false, error: 'intent' }
      if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'text' }
      if (finished()) return { ok: false, error: 'ended' }
      for (const r of openReplies()) registry.answer(r.id, { decision: 'message', message: text })
      return { ok: true, id: enqueue(text, (intent ?? null) as Intent) }
    },
    answer(id, body) {
      const kind = registry.list().find((r) => r.id === id)?.kind
      // A reply answer that cannot be sent into a finished or closing session must not look accepted.
      if (kind === 'reply' && finished()) registry.cancel(id, 'ended')
      const res = registry.answer(id, body)
      if (res.ok && kind === 'reply' && res.request.kind === 'reply' && res.request.message && !finished()) {
        enqueue(res.request.message, null) // a reply card answered with a message: intent null (ADR-0023 gap a)
      }
      return res
    },
    async close() {
      if (closed) {
        await loop
        return
      }
      closed = true
      wake?.()
      if (!started) {
        finish(endView)
        return
      }
      try {
        await query?.interrupt()
      } catch {
        // already finished
      }
      await loop
      finish(endView)
    },
  }
}
