// Registry tests written from ADR-0011 Decisions 3 and 9 and ui/contract/state.schema.json
// before any implementation exists. They add to ui/contract/session.check.ts, not repeat it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.resolve(here, '../..')
const { createRegistry, permissionCard, questionCard, questionAnswer } = (await import(
  pathToFileURL(path.join(uiDir, 'server/session/index.ts')).href
)) as any

const bashInput = { command: 'ls -la', description: 'List files' }
const openPerm = (reg: any, input: any = bashInput) => reg.open(permissionCard('Bash', input, {}))
const find = (reg: any, id: string) => reg.list().find((r: any) => r.id === id)
// A reply card as the schema's reply request shapes it (state.schema.json "reply" branch).
const replyCard = () => ({
  kind: 'reply',
  text: 'Plan ready. Approve?',
  isError: false,
  backgroundTasks: 0,
  decision: null,
  message: null,
})
const askInput = {
  questions: [
    {
      question: 'Which language?',
      header: 'Lang',
      multiSelect: false,
      options: [
        { label: 'Node (Recommended)', description: 'js' },
        { label: 'Python', description: 'py' },
      ],
    },
  ],
}
const pending = Symbol('pending')
const peek = (p: Promise<unknown>) => Promise.race([p, new Promise((r) => setImmediate(() => r(pending)))])

test('permission allow settles to {behavior:"allow", updatedInput: input} and records decision', async () => {
  // ADR Decision 3: "Approve sends {behavior: "allow", updatedInput: input}"
  const reg = createRegistry()
  const { id, settled } = openPerm(reg)
  const r = reg.answer(id, { decision: 'allow' })
  assert.equal(r.ok, true)
  assert.deepEqual(await settled, { behavior: 'allow', updatedInput: bashInput })
  const req = find(reg, id)
  assert.equal(req.status, 'answered')
  // schema request.permission: decision allow|deny|null; message "The deny message sent, else null"
  assert.equal(req.decision, 'allow')
  assert.equal(req.message, null)
  assert.ok(req.answeredAt)
})

test('permission deny without a message uses the default message', async () => {
  // ADR Decision 3: "Denied by the client in the Truss UI." when they gave none
  const reg = createRegistry()
  const { id, settled } = openPerm(reg)
  assert.equal(reg.answer(id, { decision: 'deny' }).ok, true)
  assert.deepEqual(await settled, { behavior: 'deny', message: 'Denied by the client in the Truss UI.' })
  const req = find(reg, id)
  assert.equal(req.decision, 'deny')
  assert.equal(req.message, 'Denied by the client in the Truss UI.')
})

test('permission deny with a message sends that message', async () => {
  // ADR Decision 3: "message is the client's text"
  const reg = createRegistry()
  const { id, settled } = openPerm(reg)
  assert.equal(reg.answer(id, { decision: 'deny', message: 'not that directory' }).ok, true)
  assert.deepEqual(await settled, { behavior: 'deny', message: 'not that directory' })
  const req = find(reg, id)
  assert.equal(req.decision, 'deny')
  assert.equal(req.message, 'not that directory')
})

test('question card settles to questionAnswer(input, answers)', async () => {
  // ADR Decision 3 registry: "For a canUseTool request, that promise is what canUseTool returns"
  // The card does not carry the raw input, so only behavior, answers and question texts are pinned.
  const reg = createRegistry()
  const { id, settled } = reg.open(questionCard(askInput))
  const answers = { 'Which language?': 'Python' }
  assert.equal(reg.answer(id, { answers }).ok, true)
  const out: any = await settled
  const expected = questionAnswer(askInput, answers)
  assert.equal(out.behavior, 'allow')
  assert.equal(out.behavior, expected.behavior)
  assert.deepEqual(out.updatedInput.answers, answers)
  assert.deepEqual(
    out.updatedInput.questions.map((q: any) => q.question),
    askInput.questions.map((q) => q.question),
  )
})

test('reply card approve and deny record the message sent into the session', () => {
  // ADR Decision 3: Approve sends "Approved." / Deny "Not approved.", client text after a blank line.
  const reg = createRegistry()
  const cases: [any, string, string][] = [
    [{ decision: 'allow' }, 'allow', 'Approved.'],
    [{ decision: 'deny' }, 'deny', 'Not approved.'],
    [{ decision: 'allow', message: 'go ahead' }, 'allow', 'Approved.\n\ngo ahead'],
    [{ decision: 'deny', message: 'too risky' }, 'deny', 'Not approved.\n\ntoo risky'],
  ]
  for (const [body, decision, message] of cases) {
    const { id } = reg.open(replyCard())
    const r = reg.answer(id, body)
    assert.equal(r.ok, true, JSON.stringify(body))
    assert.equal(r.request.status, 'answered')
    assert.equal(r.request.decision, decision)
    assert.equal(r.request.message, message)
    assert.equal(find(reg, id).message, message)
  }
})

test('bad bodies per kind give "answer" and leave the request open', () => {
  // ADR Decision 3: "a body that doesn't fit the kind" gives answer
  const reg = createRegistry()
  const perm = openPerm(reg)
  const reply = reg.open(replyCard())
  const q = reg.open(questionCard(askInput))
  const bad: Record<string, unknown[]> = {
    perm: [null, 'allow', 42, {}, { decision: 'maybe' }, { decision: 'allow', message: 5 }],
    reply: [null, 'allow', 42, {}, { decision: 'maybe' }, { decision: 'deny', message: {} }],
    q: [null, 'x', 42, {}, { decision: 'allow' }, { answers: [] }],
  }
  const ids: Record<string, string> = { perm: perm.id, reply: reply.id, q: q.id }
  for (const [k, bodies] of Object.entries(bad)) {
    for (const body of bodies) {
      const r = reg.answer(ids[k], body)
      assert.equal(r.ok, false, `${k} ${JSON.stringify(body)}`)
      assert.equal(r.error, 'answer', `${k} ${JSON.stringify(body)}`)
    }
    assert.equal(find(reg, ids[k]).status, 'open', `${k} still open`)
  }
})

test('a double answer gives "answered" and the promise settles once with the first answer', async () => {
  // R-8 / ADR Decision 3: second answer returns {ok:false, error:"answered", request}
  const reg = createRegistry()
  const { id, settled } = openPerm(reg)
  assert.equal(reg.answer(id, { decision: 'allow' }).ok, true)
  const second = reg.answer(id, { decision: 'deny', message: 'late' })
  assert.equal(second.ok, false)
  assert.equal(second.error, 'answered')
  assert.equal(second.request.id, id)
  assert.deepEqual(await settled, { behavior: 'allow', updatedInput: bashInput })
  assert.equal(find(reg, id).decision, 'allow')
  assert.equal(find(reg, id).message, null)
})

test('cancel aborted resolves the promise to a deny "aborted"; a later answer gives "cancelled"', async () => {
  // ADR Decision 3: "aborted: ... the promise resolves to a deny with message aborted"
  const reg = createRegistry()
  const { id, settled } = openPerm(reg)
  reg.cancel(id, 'aborted')
  assert.deepEqual(await settled, { behavior: 'deny', message: 'aborted' })
  const req = find(reg, id)
  assert.equal(req.status, 'cancelled')
  assert.equal(req.cancelReason, 'aborted')
  const late = reg.answer(id, { decision: 'allow' })
  assert.equal(late.ok, false)
  assert.equal(late.error, 'cancelled')
  assert.equal(find(reg, id).status, 'cancelled')

  const q = reg.open(questionCard(askInput))
  reg.cancel(q.id, 'aborted')
  assert.deepEqual(await q.settled, { behavior: 'deny', message: 'aborted' })
})

test('an answer arriving after the abort leaves the aborted result standing', async () => {
  // Stress case: "an answer after the abort signal" (goal file)
  const reg = createRegistry()
  const { id, settled } = openPerm(reg)
  reg.cancel(id, 'aborted')
  reg.answer(id, { decision: 'allow' })
  reg.answer(id, { decision: 'allow' })
  assert.deepEqual(await settled, { behavior: 'deny', message: 'aborted' })
  assert.equal(find(reg, id).decision, null)
})

test('cancelling an answered request changes nothing', async () => {
  const reg = createRegistry()
  const { id, settled } = openPerm(reg)
  reg.answer(id, { decision: 'allow' })
  reg.cancel(id, 'aborted')
  assert.equal(find(reg, id).status, 'answered')
  assert.deepEqual(await settled, { behavior: 'allow', updatedInput: bashInput })
})

test('answers out of order each settle only their own id', async () => {
  // ADR Decision 3: "Answers that arrive out of order are fine: each settles only its own id."
  const reg = createRegistry()
  const a = openPerm(reg, { command: 'a' })
  const b = openPerm(reg, { command: 'b' })
  const c = openPerm(reg, { command: 'c' })
  reg.answer(c.id, { decision: 'deny', message: 'no c' })
  assert.equal(await peek(a.settled), pending)
  assert.equal(await peek(b.settled), pending)
  reg.answer(a.id, { decision: 'allow' })
  assert.equal(await peek(b.settled), pending)
  reg.answer(b.id, { decision: 'deny' })
  assert.deepEqual(await a.settled, { behavior: 'allow', updatedInput: { command: 'a' } })
  assert.deepEqual(await b.settled, { behavior: 'deny', message: 'Denied by the client in the Truss UI.' })
  assert.deepEqual(await c.settled, { behavior: 'deny', message: 'no c' })
  assert.equal(find(reg, a.id).decision, 'allow')
  assert.equal(find(reg, b.id).decision, 'deny')
  assert.equal(find(reg, c.id).message, 'no c')
})

test('list keeps at most the last 200, drops settled ones oldest first, never an open one', () => {
  // ADR Decision 3: "keeps the last 200 requests ... drops older settled ones. An open request is never dropped."
  const reg = createRegistry()
  const first = openPerm(reg, { command: 'keep-open' }) // oldest, stays open
  const settledIds: string[] = []
  for (let i = 0; i < 249; i++) {
    const r = openPerm(reg, { command: `c${i}` })
    reg.answer(r.id, { decision: 'allow' })
    settledIds.push(r.id)
  }
  const list = reg.list()
  assert.ok(list.length <= 200, `length ${list.length}`)
  assert.ok(list.some((r: any) => r.id === first.id), 'the open request survives')
  assert.equal(find(reg, first.id).status, 'open')
  // The oldest settled ones went first; the newest settled one is still there.
  assert.equal(find(reg, settledIds[0]), undefined)
  assert.ok(find(reg, settledIds[settledIds.length - 1]))
  // Oldest first in the list.
  const times = list.map((r: any) => Date.parse(r.createdAt))
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1])
})

test('many open requests are never dropped', () => {
  const reg = createRegistry()
  const ids = Array.from({ length: 230 }, (_, i) => openPerm(reg, { command: String(i) }).id)
  const list = reg.list()
  for (const id of ids) assert.ok(list.some((r: any) => r.id === id), 'open request kept')
  assert.ok(list.every((r: any) => r.status === 'open'))
})

test('ids are unique non-empty strings', () => {
  // schema request.id: string, minLength 1
  const reg = createRegistry()
  const ids = new Set<string>()
  for (let i = 0; i < 50; i++) {
    const { id } = i % 2 ? openPerm(reg) : reg.open(replyCard())
    assert.equal(typeof id, 'string')
    assert.ok(id.length > 0)
    ids.add(id)
  }
  assert.equal(ids.size, 50)
  assert.equal(new Set(reg.list().map((r: any) => r.id)).size, 50)
})
