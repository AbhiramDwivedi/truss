// One Claude Code session (ADR-0011 Decisions 2, 3). The only file that touches the Agent SDK.
// Stores nothing: all state is in memory (R-13). No timeout anywhere.
import { isObj, permissionCard, questionCard } from './cards.ts'
import { createRegistry } from './registry.ts'
import type { AnswerResult, Registry } from './registry.ts'
import { addUserEntry, endView, errorView, foldMessage, initialView, setRunning } from './fold.ts'
import type { SessionView } from './fold.ts'
import { replyStep } from './reply.ts'
import type { ReplyState } from './reply.ts'

export interface SessionControl {
  send(text: string): { ok: true } | { ok: false; error: 'text' | 'ended' }
  answer(id: string, body: unknown): AnswerResult
}
export interface Session extends SessionControl {
  view(): SessionView
  subscribe(fn: (v: SessionView) => void): () => void
  close(): Promise<void>
}

export function createSession(opts: { repo: string; pluginPath: string }): Session {
  let base: SessionView = initialView()
  const subs = new Set<(v: SessionView) => void>()
  const registry: Registry = createRegistry(() => notify())

  const view = (): SessionView => ({ ...base, requests: registry.list() })
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
  let closed = false
  let reply: ReplyState = { turnRunning: false, held: null }
  const outbox: string[] = []
  const queue: string[] = []
  let wake: (() => void) | undefined
  let query: { interrupt(): Promise<unknown> } | undefined
  let loop: Promise<void> = Promise.resolve()

  async function* input() {
    while (true) {
      while (outbox.length === 0) {
        if (closed) return
        await new Promise<void>((r) => (wake = r))
      }
      const text = outbox.shift()!
      yield { type: 'user' as const, message: { role: 'user' as const, content: text }, parent_tool_use_id: null }
    }
  }

  function dispatch(text: string) {
    reply = { ...reply, turnRunning: true }
    outbox.push(text)
    wake?.()
    update(setRunning(base))
  }

  function enqueue(text: string) {
    base = addUserEntry(base, text)
    if (!started) {
      started = true
      loop = run()
    }
    if (reply.turnRunning) {
      queue.push(text)
      notify()
    } else dispatch(text)
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
    base = foldMessage(base, msg)
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
        if (id !== undefined) registry.answer(id, { decision: 'message', message: queued })
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
          plugins: [{ type: 'local', path: opts.pluginPath }],
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
      return () => {
        subs.delete(fn)
      }
    },
    send(text) {
      if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'text' }
      if (finished()) return { ok: false, error: 'ended' }
      for (const r of openReplies()) registry.answer(r.id, { decision: 'message', message: text })
      enqueue(text)
      return { ok: true }
    },
    answer(id, body) {
      const kind = registry.list().find((r) => r.id === id)?.kind
      // A reply answer that cannot be sent into a finished or closing session must not look accepted.
      if (kind === 'reply' && finished()) registry.cancel(id, 'ended')
      const res = registry.answer(id, body)
      if (res.ok && kind === 'reply' && res.request.kind === 'reply' && res.request.message && !finished()) {
        enqueue(res.request.message)
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
