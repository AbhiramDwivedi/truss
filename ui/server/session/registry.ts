// The pending-request registry (ADR-0011 Decision 3, R-8): every request answered at most once.
import { isObj, questionAnswer, rawInputOf } from './cards.ts'
import type { NewRequest, Request, QuestionRequest } from './cards.ts'

export type AnswerResult =
  | { ok: true; request: Request }
  | { ok: false; error: 'unknown' | 'answered' | 'cancelled' | 'answer'; request?: Request }

export interface Registry {
  open(card: NewRequest): { id: string; settled: Promise<unknown> }
  answer(id: string, body: unknown): AnswerResult
  cancel(id: string, reason: 'aborted' | 'superseded' | 'ended'): void
  list(): Request[]
}

const KEEP = 200
const DEFAULT_DENY = 'Denied by the client in the Truss UI.'

interface Entry {
  req: Request
  raw: Record<string, unknown> | undefined
  resolve: (v: unknown) => void
}

const withText = (head: string, t: string | null) => (t ? `${head}\n\n${t}` : head)

export function createRegistry(onChange?: () => void): Registry {
  const entries: Entry[] = []
  const byId = new Map<string, Entry>()
  const changed = () => onChange?.()

  function trim() {
    while (entries.length > KEEP) {
      const i = entries.findIndex((e) => e.req.status !== 'open')
      if (i < 0) return
      byId.delete(entries[i]!.req.id)
      entries.splice(i, 1)
    }
  }

  function open(card: NewRequest) {
    const id = crypto.randomUUID()
    const copy = structuredClone(card) as NewRequest
    const req = { ...copy, id, status: 'open', createdAt: new Date().toISOString(), answeredAt: null, cancelReason: null } as Request
    let resolve!: (v: unknown) => void
    const settled = new Promise<unknown>((r) => (resolve = r))
    const e: Entry = { req, raw: rawInputOf(card), resolve }
    entries.push(e)
    byId.set(id, e)
    trim()
    changed()
    return { id, settled }
  }

  // Validates the body against the kind. Mutates e.req and returns the settle value, or null when the body is bad.
  function apply(e: Entry, body: unknown): { value: unknown } | null {
    const r = e.req
    if (!isObj(body)) return null
    if (r.kind === 'question') {
      const a = body.answers
      if (!isObj(a)) return null
      const answers: Record<string, string> = {}
      for (const [k, v] of Object.entries(a)) {
        if (typeof v !== 'string') return null
        answers[k] = v
      }
      const asked = (r as QuestionRequest).questions.map((q) => q.question)
      if (Object.keys(answers).some((k) => !asked.includes(k)) || asked.some((q) => !(q in answers))) return null
      r.answers = answers
      const input = e.raw ?? { questions: (r as QuestionRequest).questions }
      return { value: questionAnswer(input, answers) }
    }
    if (body.message !== undefined && typeof body.message !== 'string') return null
    const t = typeof body.message === 'string' && body.message.trim() !== '' ? body.message : null
    if (r.kind === 'permission') {
      if (body.decision === 'allow') {
        r.decision = 'allow'
        return { value: { behavior: 'allow', updatedInput: r.input } }
      }
      if (body.decision === 'deny') {
        r.decision = 'deny'
        r.message = t ?? DEFAULT_DENY
        return { value: { behavior: 'deny', message: r.message } }
      }
      return null
    }
    if (body.decision === 'allow' || body.decision === 'deny') {
      r.decision = body.decision
      r.message = withText(body.decision === 'allow' ? 'Approved.' : 'Not approved.', t)
      return { value: r.message }
    }
    if (body.decision === 'message' && t) {
      r.decision = 'message'
      r.message = t
      return { value: r.message }
    }
    return null
  }

  function answer(id: string, body: unknown): AnswerResult {
    const e = byId.get(id)
    if (!e) return { ok: false, error: 'unknown' }
    if (e.req.status === 'answered') return { ok: false, error: 'answered', request: structuredClone(e.req) }
    if (e.req.status === 'cancelled') return { ok: false, error: 'cancelled', request: structuredClone(e.req) }
    const saved = structuredClone(e.req)
    const res = apply(e, body)
    if (!res) {
      e.req = saved // a bad body leaves the open request as it was
      return { ok: false, error: 'answer' }
    }
    e.req.status = 'answered'
    e.req.answeredAt = new Date().toISOString()
    e.resolve(res.value)
    changed()
    return { ok: true, request: structuredClone(e.req) }
  }

  function cancel(id: string, reason: 'aborted' | 'superseded' | 'ended') {
    const e = byId.get(id)
    if (!e || e.req.status !== 'open') return
    e.req.status = 'cancelled'
    e.req.cancelReason = reason
    e.resolve(e.req.kind === 'reply' ? null : { behavior: 'deny', message: reason })
    changed()
  }

  return { open, answer, cancel, list: () => entries.map((e) => structuredClone(e.req)) }
}
