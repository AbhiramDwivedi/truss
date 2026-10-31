// Contract check for ui-session (ADR-0011 Decisions 2, 3 and 9; R-8, R-20, R-22).
// Written from the ADR and the recorded SDK stream before any implementation exists.
// Self-contained on purpose. It replays the real recording in
// ui/contract/fixtures/sdk-stream.jsonl; every expected value is read from that file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.dirname(here)
const producerUrl = pathToFileURL(path.join(uiDir, 'server/session/index.ts')).href
let producer: any
try {
  producer = await import(producerUrl)
} catch {
  throw new Error('producer missing: ui/server/session')
}

// ---------------------------------------------------------------------------
// The recording. Lines with `_spike` were written by the spike, the rest are SDK messages.
// ---------------------------------------------------------------------------
const lines: any[] = fs
  .readFileSync(path.join(here, 'fixtures/sdk-stream.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l))
const sdk = lines.filter((o) => !('_spike' in o))
const spike = (kind: string) => lines.filter((o) => o._spike === kind)
const inits = sdk.filter((m) => m.type === 'system' && m.subtype === 'init')
const results = sdk.filter((m) => m.type === 'result')
const asks = spike('canUseTool').filter((c) => c.toolName === 'AskUserQuestion')
const perms = spike('canUseTool').filter((c) => c.toolName !== 'AskUserQuestion')

test('the recording has what the check needs', () => {
  assert.ok(inits.length >= 2, 'several init messages')
  assert.ok(results.length >= 2, 'several result messages')
  assert.equal(asks.length, 1, 'one AskUserQuestion call')
  assert.ok(perms.length >= 3, 'permission calls')
})

const pickModelUsage = (mu: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(mu).map(([k, v]: [string, any]) => [
      k,
      {
        inputTokens: v.inputTokens,
        outputTokens: v.outputTokens,
        cacheReadInputTokens: v.cacheReadInputTokens,
        cacheCreationInputTokens: v.cacheCreationInputTokens,
      },
    ]),
  )

test('initialView is idle and empty', () => {
  const v = producer.initialView()
  assert.equal(v.session.status, 'idle')
  assert.equal(v.session.sessionId, null)
  assert.equal(v.session.model, null)
  assert.equal(v.session.usage, null)
  assert.deepEqual(v.requests, [])
  assert.deepEqual(v.transcript, [])
})

test('replaying the stream: init gives model, session id, mode and plugin; result gives usage', () => {
  let view = producer.initialView()
  let seenInit = 0
  let seenResult = 0
  for (const msg of sdk) {
    view = producer.foldMessage(view, msg)
    if (msg.type === 'system' && msg.subtype === 'init') {
      seenInit++
      assert.equal(view.session.status, 'running')
      assert.equal(view.session.model, msg.model)
      assert.equal(view.session.sessionId, msg.session_id)
      assert.equal(view.session.claudeCodeVersion, msg.claude_code_version)
      assert.equal(view.session.permissionMode, msg.permissionMode)
      const p = msg.plugins.find((x: any) => x.name === 'truss')
      assert.deepEqual(view.session.plugin, {
        name: 'truss',
        version: p.version ?? null,
        path: p.path,
        source: p.source ?? null,
      })
    }
    if (msg.type === 'result') {
      seenResult++
      assert.equal(view.session.status, 'waiting')
      const u = view.session.usage
      assert.ok(u, 'usage set after a result')
      assert.equal(u.costUsd, msg.total_cost_usd)
      assert.equal(u.results, seenResult)
      assert.deepEqual(u.models, pickModelUsage(msg.modelUsage))
      assert.ok(!Number.isNaN(Date.parse(u.at)), 'usage.at is a date')
    }
  }
  assert.equal(seenInit, inits.length)
  assert.equal(seenResult, results.length)
  // Session totals: the latest result replaces the earlier one, nothing is summed.
  const last = results[results.length - 1]
  assert.equal(view.session.usage.costUsd, last.total_cost_usd)
  assert.deepEqual(view.session.usage.models, pickModelUsage(last.modelUsage))
  assert.notEqual(last.total_cost_usd, results[0].total_cost_usd, 'fixture costs differ per turn')
})

test('replaying the stream: top-level assistant text reaches the transcript', () => {
  let view = producer.initialView()
  for (const msg of sdk) view = producer.foldMessage(view, msg)
  const expected: string[] = []
  for (const m of sdk) {
    if (m.type !== 'assistant' || m.parent_tool_use_id || m.agent_id) continue
    for (const b of m.message?.content ?? []) if (b.type === 'text' && b.text) expected.push(b.text)
  }
  assert.ok(expected.length > 0, 'fixture has assistant text')
  const got = view.transcript.filter((e: any) => e.role === 'assistant')
  assert.deepEqual(got.map((e: any) => e.text), expected)
  view.transcript.forEach((e: any, i: number) => {
    assert.equal(typeof e.n, 'number')
    if (i > 0) assert.ok(e.n > view.transcript[i - 1].n, 'n rises')
  })
})

test('foldMessage does not change the view it was given', () => {
  const v0 = producer.initialView()
  const snap = JSON.stringify(v0)
  producer.foldMessage(v0, inits[0])
  assert.equal(JSON.stringify(v0), snap)
})

// ---------------------------------------------------------------------------
// The AskUserQuestion card and the answer shape.
// ---------------------------------------------------------------------------
const ask = asks[0]
const askReply = spike('canUseTool_reply').find((r) => r.toolName === 'AskUserQuestion')

test('questionCard turns the recorded AskUserQuestion input into a card', () => {
  const card = producer.questionCard(ask.input)
  assert.equal(card.kind, 'question')
  assert.equal(card.answers, null)
  assert.equal(card.questions.length, ask.input.questions.length)
  ask.input.questions.forEach((q: any, i: number) => {
    const c = card.questions[i]
    assert.equal(c.question, q.question)
    assert.equal(c.header, q.header)
    assert.equal(c.multiSelect, q.multiSelect)
    assert.deepEqual(
      c.options.map((o: any) => [o.label, o.description]),
      q.options.map((o: any) => [o.label, o.description]),
    )
    assert.deepEqual(
      c.options.map((o: any) => o.recommended),
      q.options.map((o: any) => o.label.endsWith(' (Recommended)')),
    )
  })
  const flags = card.questions.flatMap((q: any) => q.options.map((o: any) => o.recommended))
  assert.ok(flags.includes(true) && flags.includes(false), 'fixture mixes recommended and not')
})

test('questionAnswer builds {behavior:"allow", updatedInput:{questions, answers}} as recorded', () => {
  const answers = askReply.reply.updatedInput.answers
  assert.deepEqual(Object.keys(answers), ask.input.questions.map((q: any) => q.question))
  const out = producer.questionAnswer(ask.input, answers)
  assert.equal(out.behavior, 'allow')
  assert.deepEqual(out.updatedInput.questions, ask.input.questions)
  assert.deepEqual(out.updatedInput.answers, answers)
  assert.deepEqual(out, askReply.reply)
  // A different answer set gives a different reply.
  const other = Object.fromEntries(Object.keys(answers).map((k) => [k, 'Stop the client brief']))
  assert.deepEqual(producer.questionAnswer(ask.input, other).updatedInput.answers, other)
})

// ---------------------------------------------------------------------------
// Permission cards, from every recorded canUseTool call.
// ---------------------------------------------------------------------------
test('permissionCard on the recorded permission calls', () => {
  for (const c of perms) {
    const card = producer.permissionCard(c.toolName, c.input, c.options)
    assert.equal(card.kind, 'permission')
    assert.equal(card.toolName, c.toolName)
    assert.equal(card.title, c.options.description ?? c.input.description ?? c.toolName)
    const summary =
      c.toolName === 'Bash'
        ? c.input.command
        : ['Read', 'Write', 'Edit', 'NotebookEdit'].includes(c.toolName)
          ? c.input.file_path
          : JSON.stringify(c.input)
    assert.equal(card.summary, summary)
    assert.deepEqual(card.input, c.input)
    assert.equal(card.decisionReason, c.options.decisionReason ?? null)
    assert.equal(card.blockedPath, c.options.blockedPath ?? null)
    assert.equal(card.decision, null)
    assert.equal(card.message, null)
  }
  assert.ok(perms.some((c) => c.options.blockedPath), 'fixture has a blockedPath')
  assert.ok(perms.some((c) => !c.options.blockedPath), 'fixture has a call without one')
  assert.ok(perms.some((c) => c.toolName === 'Read'), 'fixture has a Read call')
})

// ---------------------------------------------------------------------------
// The registry: each request is answered at most once (R-8).
// ---------------------------------------------------------------------------
test('registry: open, answer once, a second answer is refused as answered', () => {
  const reg = producer.createRegistry()
  const { id } = reg.open(producer.questionCard(ask.input))
  assert.equal(typeof id, 'string')
  assert.ok(id.length > 0)
  const open = reg.list().find((r: any) => r.id === id)
  assert.equal(open.status, 'open')
  assert.equal(open.kind, 'question')

  const first = askReply.reply.updatedInput.answers
  const r1 = reg.answer(id, { answers: first })
  assert.equal(r1.ok, true)
  assert.equal(r1.request.id, id)
  assert.equal(r1.request.status, 'answered')
  assert.deepEqual(r1.request.answers, first)
  assert.ok(r1.request.answeredAt)

  const second = Object.fromEntries(Object.keys(first).map((k) => [k, 'Stop the client brief']))
  const r2 = reg.answer(id, { answers: second })
  assert.equal(r2.ok, false)
  assert.equal(r2.error, 'answered')
  const after = reg.list().find((r: any) => r.id === id)
  assert.equal(after.status, 'answered')
  assert.deepEqual(after.answers, first, 'the first answers stand')
  assert.deepEqual(reg.answer(id, { answers: first }).error, 'answered', 'even the same answers again')
})

test('registry: unknown id, bad body and cancelled request', () => {
  const reg = producer.createRegistry()
  const miss = reg.answer('no-such-id', { answers: {} })
  assert.equal(miss.ok, false)
  assert.equal(miss.error, 'unknown')

  const a = reg.open(producer.questionCard(ask.input))
  for (const body of [null, 'x', 42, {}, { answers: 'x' }, { answers: { q: 1 } }]) {
    const bad = reg.answer(a.id, body)
    assert.equal(bad.ok, false, `body ${JSON.stringify(body)} refused`)
    assert.equal(bad.error, 'answer')
  }
  assert.equal(reg.list().find((r: any) => r.id === a.id).status, 'open', 'a bad body leaves it open')

  const b = reg.open(producer.questionCard(ask.input))
  reg.cancel(b.id, 'aborted')
  const gone = reg.list().find((r: any) => r.id === b.id)
  assert.equal(gone.status, 'cancelled')
  assert.equal(gone.cancelReason, 'aborted')
  const late = reg.answer(b.id, { answers: askReply.reply.updatedInput.answers })
  assert.equal(late.ok, false)
  assert.equal(late.error, 'cancelled')
})
