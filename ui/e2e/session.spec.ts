// ui-web: request cards, message box and header (ADR-0011 Decisions 2, 3, 6; R-3, R-7, R-15, R-20, R-22).
// Written from the spec before ui/web exists. The server is the real createServer on port 0 with the real
// createRegistry (startInterface); the cards come from the real questionCard and permissionCard on the inputs
// recorded in ui/contract/fixtures/sdk-stream.jsonl. No fake Claude session. Controls are found by role and
// accessible name, never by a fixed id or class.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expectD2Colours, startInterface, rand, rx, repoRoot, WITHIN, yourMove, goalBox, sendButton, sessionStatus, runStatus, type Iface, type QuestionSpec } from './harness.ts'
import { questionCard, permissionCard } from '../server/session/index.ts'

// ---- fixture inputs ------------------------------------------------------------------------------------

const fixtureLines = readFileSync(join(repoRoot, 'ui', 'contract', 'fixtures', 'sdk-stream.jsonl'), 'utf8').trim().split('\n')
const rec = (seq: number): any => {
  const r = fixtureLines.map((l) => JSON.parse(l)).find((m) => m._seq === seq)
  if (!r) throw new Error(`no fixture line with _seq ${seq}`)
  return r
}
const ASK = rec(42) // AskUserQuestion: two single-select questions, recommended option first
const BASH_VAR = rec(14) // Bash, decisionReason
const BASH_GIT = rec(22) // Bash, decisionReason
const READ = rec(27) // Read, decisionReason
const BASH_BLOCKED = rec(54) // Bash, blockedPath
const permCard = (r: any) => permissionCard(r.toolName, r.input, r.options)

// ---- helpers -------------------------------------------------------------------------------------------

// ADR-0018: a request card is an `article` named `Question from Claude: <header>`, `Permission request: <tool>`
// `The PM replied` or `Approval needed` (ADR-0028 section 2; was `Reply needed`). An open card holds its buttons; an answered one keeps its name and loses them.
const ANY_CARD = /^(Question from Claude: |Permission request: |The PM replied$|Approval needed$)/
// The open card that holds `text` and a button matching `controls`.
function openCard(page: Page, text: RegExp | string, controls: RegExp): Locator {
  const hasText = typeof text === 'string' ? rx(text) : text
  return page.getByRole('article', { name: ANY_CARD }).filter({ hasText }).filter({ has: page.getByRole('button', { name: controls }) }).last()
}
// Any request card (open, answered or cancelled) that holds all the given texts.
function cardHolding(page: Page, ...texts: Array<RegExp | string>): Locator {
  let l = page.getByRole('article', { name: ANY_CARD })
  for (const t of texts) l = l.filter({ hasText: typeof t === 'string' ? rx(t) : t })
  return l.first()
}
// ADR-0028 section 2: the reply card button names carry a hint ("Sends: Approved."), so anchor the start only.
const APPROVE = /^Approve\b/
const DENY = /^Deny\b/
const SUBMIT = /^Submit answers$/
const SEND_REPLY = /^Send reply$/ // ADR-0028 section 2
const YOUR_REPLY = { name: 'Your reply', exact: true } as const // ADR-0028 section 2
const ANSWERED = /answered|approved|allowed|denied|replied/i
const MESSAGE_WITH_ANSWER = { name: 'Message with your answer', exact: true } as const

// An option of a question: a radio (single select) or a checkbox (multi select), by its label, inside the
// radiogroup named after the question text when one is given.
function option(card: Locator, label: string, question?: string): Locator {
  const name = rx(label.replace(/ \(Recommended\)$/, ''))
  const scope = question ? card.getByRole('radiogroup', { name: rx(question.slice(0, 40)) }) : card
  return scope.getByRole('radio', { name }).or(scope.getByRole('checkbox', { name })).first()
}
async function submit(card: Locator): Promise<void> {
  await card.getByRole('button', { name: SUBMIT }).click()
}
const banner = (page: Page) => page.getByRole('banner')

async function open(page: Page, iface: Iface): Promise<void> {
  await page.goto(iface.url)
  await expect(banner(page)).toBeVisible({ timeout: 10000 })
}

// Runs `fn` against a fresh interface server on port 0 and always stops it.
async function withIface(opts: Parameters<typeof startInterface>[0], fn: (iface: Iface) => Promise<void>): Promise<void> {
  const iface = await startInterface(opts)
  try { await fn(iface) } finally { await iface.stop() }
}
// Waits for the next SessionControl call of `kind` after `from` calls; returns it.
async function nextCall(iface: Iface, kind: 'send' | 'answer', from: number) {
  await expect.poll(() => iface.calls.slice(from).filter((c) => c.kind === kind).length, { timeout: 1000 }).toBeGreaterThan(0)
  return iface.calls.slice(from).find((c) => c.kind === kind)!
}
function specOf(items: ReturnType<typeof questionCard>['questions']): QuestionSpec[] {
  return items.map((q) => ({ question: q.question, header: q.header, multiSelect: q.multiSelect, options: q.options.map((o) => ({ label: o.label, description: o.description })) }))
}
const wrapRequest = (card: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id: `req-${rand()}`, status: 'open', createdAt: new Date().toISOString(), answeredAt: null, cancelReason: null, ...card, ...over,
})

// ---- question cards ------------------------------------------------------------------------------------

// ADR-0023 checklist item 22: with a question open, the card is the move surface and paints tokens.json move.
test('D2 colours: with a question card open, body is tokens.json bg and the card is move', async ({ page }) => {
  await withIface({}, async (iface) => {
    await open(page, iface)
    const specs = specOf(questionCard(ASK.input).questions)
    iface.question(specs)
    await expect(openCard(page, rx(specs[0]!.header), SUBMIT)).toBeVisible(WITHIN)
    await expectD2Colours(page, 'light')
  })
})

test.describe('R-3 question cards', () => {
  test('R-3: a brief question card shows each header, text and option in sent order, the recommended option first and marked in text', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const specs = specOf(questionCard(ASK.input).questions)
      iface.question(specs)
      const first = specs[0]!
      const card = openCard(page, rx(first.header), SUBMIT)
      await expect(card).toBeVisible(WITHIN)
      const text = await card.innerText()
      // Every header, question text and option label appears, and in the order they were sent.
      let at = -1
      for (const q of specs) {
        const h = text.indexOf(q.header, at + 1)
        expect(h, `header ${q.header}`).toBeGreaterThan(at)
        const qi = text.indexOf(q.question.slice(0, 40), h)
        expect(qi, `question ${q.header}`).toBeGreaterThan(-1)
        at = qi
        for (const o of q.options) {
          const oi = text.indexOf(o.label.replace(/ \(Recommended\)$/, ''), at + 1)
          expect(oi, `option ${o.label}`).toBeGreaterThan(at)
          at = oi
        }
      }
      // The recommended option comes first and is marked in words, not by color (R-18).
      await expect(page.getByRole('article', { name: rx(`Question from Claude: ${first.header}`) })).toBeVisible()
      await expect(yourMove(page).getByRole('article', { name: rx(`Question from Claude: ${first.header}`) })).toBeVisible()
      for (const q of specs) {
        await expect(card.getByRole('radiogroup', { name: rx(q.question.slice(0, 40)) }).getByRole('radio')).toHaveCount(q.options.length)
        await expect(card.getByRole('textbox', { name: 'Your own answer', exact: true })).toHaveCount(specs.length)
      }
      const rec1 = option(card, first.options[0]!.label, first.question)
      await expect(rec1).toBeVisible()
      await expect(rec1).toHaveAccessibleName(/node\.js cli.*recommended/i)
      expect(iface.calls.length).toBe(0)
    })
  })

  test('R-3, R-7, R-15: single-select answers for both fixture questions POST {answers} and reach SessionControl.answer within 1 s', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const specs = specOf(questionCard(ASK.input).questions)
      const id = iface.question(specs)
      const card = openCard(page, rx(specs[0]!.header), SUBMIT)
      await expect(card).toBeVisible(WITHIN)
      await option(card, 'Python CLI', specs[0]!.question).click()
      await option(card, 'Bare semver, exit 0 (Recommended)', specs[1]!.question).click()
      const t0 = Date.now()
      await submit(card)
      const call = await nextCall(iface, 'answer', 0)
      expect(call.at - t0).toBeLessThan(1000)
      expect(call.id).toBe(id)
      expect(call.body).toEqual({ answers: { [specs[0]!.question]: 'Python CLI', [specs[1]!.question]: 'Bare semver, exit 0 (Recommended)' } })
      expect((call.result as any).ok).toBe(true)
      await expect(cardHolding(page, rx(specs[0]!.header), ANSWERED)).toBeVisible(WITHIN)
      expect(iface.requests()[0].status).toBe('answered')
    })
  })

  test('R-3, R-7: multiSelect answers are joined with ", " in the POST body', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const tag = rand()
      const q = `Which parts ${tag}?`
      iface.question([{ header: `Parts ${tag}`, question: q, multiSelect: true, options: [{ label: `Alpha ${tag}` }, { label: `Beta ${tag}` }, { label: `Gamma ${tag}` }] }])
      const card = openCard(page, rx(`Parts ${tag}`), SUBMIT)
      await expect(card).toBeVisible(WITHIN)
      await expect(card.getByRole('checkbox')).toHaveCount(3)
      await expect(card.getByRole('radio')).toHaveCount(0)
      await card.getByRole('checkbox', { name: rx(`Alpha ${tag}`) }).check()
      await card.getByRole('checkbox', { name: rx(`Gamma ${tag}`) }).check()
      await submit(card)
      const call = await nextCall(iface, 'answer', 0)
      expect(call.body).toEqual({ answers: { [q]: `Alpha ${tag}, Gamma ${tag}` } })
    })
  })

  test('R-3, R-7: a free-text answer is posted as typed', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const tag = rand()
      const q = `What should it be called ${tag}?`
      iface.question([{ header: `Name ${tag}`, question: q, options: [{ label: `One ${tag} (Recommended)` }, { label: `Two ${tag}` }] }])
      const card = openCard(page, rx(`Name ${tag}`), SUBMIT)
      await expect(card).toBeVisible(WITHIN)
      // The text box `Your own answer` is always shown under the options; no radio has to be opened first.
      const typed = `my own words ${tag}`
      await card.getByRole('textbox', { name: 'Your own answer', exact: true }).fill(typed)
      await submit(card)
      const call = await nextCall(iface, 'answer', 0)
      expect(call.body).toEqual({ answers: { [q]: typed } })
    })
  })
})

// ---- approval cards ------------------------------------------------------------------------------------

test.describe('R-7 permission cards', () => {
  test('R-7: a permission card shows tool name, title, summary, decisionReason and blockedPath from the recorded inputs', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      // Display only: the interface harness opens permission cards without decisionReason or blockedPath, so
      // these requests are pushed as state; the cards are the real permissionCard output.
      const blocked = permCard(BASH_BLOCKED)
      const bash = permCard(BASH_VAR)
      const read = permCard(READ)
      expect(blocked.blockedPath).toBe('/tmp/truss-spike-pkZDEP/spike-out')
      iface.emit({ requests: [wrapRequest(blocked as any), wrapRequest(bash as any), wrapRequest(read as any)] })

      const c1 = cardHolding(page, 'Create spike-out directory', 'mkdir /tmp/truss-spike-pkZDEP/spike-out')
      await expect(c1).toBeVisible(WITHIN)
      await expect(c1).toContainText('Bash')
      await expect(c1).toContainText('/tmp/truss-spike-pkZDEP/spike-out')
      await expect(c1.getByRole('button', { name: APPROVE })).toBeVisible()
      await expect(c1.getByRole('button', { name: DENY })).toBeVisible()

      const c2 = cardHolding(page, 'Inspect repo files and brief branches', 'head -80 $P/skills/brief/branches.md')
      await expect(c2).toBeVisible(WITHIN)
      await expect(c2).toContainText("A variable in this command can't be checked before it runs")

      // Read shows the file_path as its summary.
      const c3 = cardHolding(page, 'Read', '/skills/brief/branches.md', 'Path is outside allowed working directories')
      await expect(c3).toBeVisible(WITHIN)
    })
  })

  for (const [name, decision, button, message] of [
    ['approve with no message', 'allow', APPROVE, ''],
    ['deny with no message', 'deny', DENY, ''],
    ['approve with a message', 'allow', APPROVE, 'go ahead'],
    ['deny with a message', 'deny', DENY, 'not that path'],
  ] as const) {
    test(`R-7, R-15: ${name} posts the decision and reaches SessionControl.answer within 1 s`, async ({ page }) => {
      await withIface({}, async (iface) => {
        await open(page, iface)
        const c = permCard(BASH_GIT)
        const tag = rand()
        const id = iface.permission({ toolName: c.toolName, title: `${c.title} ${tag}`, summary: c.summary, input: c.input })
        const card = openCard(page, rx(tag), button)
        await expect(card).toBeVisible(WITHIN)
        await expect(card).toContainText(c.summary)
        if (message) await card.getByRole('textbox', MESSAGE_WITH_ANSWER).fill(message)
        const t0 = Date.now()
        await card.getByRole('button', { name: button }).click()
        const call = await nextCall(iface, 'answer', 0)
        expect(call.at - t0).toBeLessThan(1000)
        expect(call.id).toBe(id)
        const body = call.body as any
        expect(body.decision).toBe(decision)
        expect(body.message ?? '').toBe(message)
        const req = iface.requests()[0]
        expect(req.status).toBe('answered')
        expect(req.decision).toBe(decision)
        if (decision === 'deny') expect(req.message).toBe(message || 'Denied by the client in the Truss UI.')
        await expect(cardHolding(page, rx(tag), ANSWERED)).toBeVisible(WITHIN)
        await expect(page.getByRole('button', { name: button }).filter({ hasText: /./ })).toHaveCount(0)
      })
    })
  }

  test('R-7: a double click answers once and the card shows answered', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const tag = rand()
      iface.permission({ toolName: 'Bash', title: `Double ${tag}`, summary: 'ls -la', input: { command: 'ls -la' } })
      const card = openCard(page, rx(tag), APPROVE)
      await expect(card).toBeVisible(WITHIN)
      await card.getByRole('button', { name: APPROVE }).dblclick()
      await expect(cardHolding(page, rx(tag), ANSWERED)).toBeVisible(WITHIN)
      // The session got the answer once; any second POST was refused as answered.
      const answers = iface.calls.filter((c) => c.kind === 'answer')
      expect(answers.filter((c) => (c.result as any).ok === true)).toHaveLength(1)
      for (const c of answers.slice(1)) expect((c.result as any).error).toBe('answered')
      expect(iface.requests()[0].status).toBe('answered')
    })
  })

  test('R-7, R-8: a 409 answered from the server leaves the card answered and the page usable', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const tag = rand()
      iface.permission({ toolName: 'Bash', title: `Stale ${tag}`, summary: 'pwd', input: { command: 'pwd' } })
      const card = openCard(page, rx(tag), APPROVE)
      await expect(card).toBeVisible(WITHIN)
      // Another viewer answers first: the real server gets the page's request twice, and the page's own is the second.
      await page.route('**/api/requests/*/answer', async (route) => {
        await route.fetch()
        await route.continue()
      })
      await card.getByRole('button', { name: APPROVE }).click()
      await expect.poll(() => iface.calls.filter((c) => c.kind === 'answer').length, { timeout: 2000 }).toBe(2)
      const [first, second] = iface.calls.filter((c) => c.kind === 'answer')
      expect((first!.result as any).ok).toBe(true)
      expect((second!.result as any).error).toBe('answered')
      await expect(cardHolding(page, rx(tag), ANSWERED)).toBeVisible(WITHIN)
      // Not a dead page: a new card still opens and can be answered.
      const tag2 = rand()
      iface.permission({ toolName: 'Bash', title: `Next ${tag2}`, summary: 'date', input: { command: 'date' } })
      await expect(openCard(page, rx(tag2), DENY)).toBeVisible(WITHIN)
    })
  })

  test('R-7, R-8: a cancelled card shows its reason in words and offers no approve', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const cards = [
        ['aborted', /abort|interrupt|stopped/i],
        ['superseded', /supersede|replaced|started a turn|on its own/i],
        ['ended', /ended|session (is )?over|finished/i],
      ] as const
      const reqs = cards.map(([reason], i) => wrapRequest(permCard({ toolName: 'Bash', input: { command: `echo ${reason}-${i}` }, options: { description: `Cancel ${reason}` } }) as any, { status: 'cancelled', cancelReason: reason }))
      iface.emit({ requests: reqs })
      // Answered and cancelled requests the page did not just answer sit in one closed disclosure.
      await page.getByText(/\d+ earlier requests? answered/).click()
      for (const [reason, words] of cards) {
        const c = cardHolding(page, `Cancel ${reason}`)
        await expect(c).toBeVisible(WITHIN)
        await expect(c).toContainText(/cancelled|canceled/i)
        await expect(c).toContainText(words)
        await expect(c.getByRole('button', { name: APPROVE })).toHaveCount(0)
      }
    })
  })
})

// ---- reply cards ---------------------------------------------------------------------------------------

test.describe('R-7 reply cards', () => {
  test('R-7: a reply card shows the result text, the error flag and the background task count', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const tag = rand()
      iface.reply({ text: `Plan is ready ${tag}. Approve?`, isError: true, backgroundTasks: 3, approvalAsk: true })
      const card = openCard(page, rx(tag), APPROVE)
      await expect(card).toBeVisible(WITHIN)
      await expect(card).toContainText(/error/i)
      await expect(card).toContainText(/3\s+background|background[^0-9]{0,30}3/i)
      await expect(card.getByRole('button', { name: DENY })).toBeVisible()
    })
  })

  for (const [name, decision, button, message, sent] of [
    ['approve', 'allow', APPROVE, '', 'Approved.'],
    ['deny', 'deny', DENY, '', 'Not approved.'],
    // ADR-0028 section 2: with text in the box, "Send reply" sends the text instead of Approved. / Not approved.
    // (ReplyCard hint "Sends your text instead of Approved. or Not approved."); Approve and Deny still send their own words.
    ['approve with a message', 'message', SEND_REPLY, 'but mind the tests', 'but mind the tests'],
    ['deny with a message', 'message', SEND_REPLY, 'use a smaller plan', 'use a smaller plan'],
  ] as const) {
    test(`R-7, R-15: reply card ${name} posts the decision and reaches SessionControl.answer within 1 s`, async ({ page }) => {
      await withIface({}, async (iface) => {
        await open(page, iface)
        const tag = rand()
        const id = iface.reply({ text: `Push now? ${tag}`, approvalAsk: true })
        const card = openCard(page, rx(tag), button)
        await expect(card).toBeVisible(WITHIN)
        await expect(card).toHaveAccessibleName('Approval needed') // ADR-0028 section 2
        await expect(card).toContainText(name.startsWith('approve') ? 'Sends: Approved.' : 'Sends: Not approved.')
        if (message) await card.getByRole('textbox', YOUR_REPLY).fill(message)
        const t0 = Date.now()
        await card.getByRole('button', { name: button }).click()
        const call = await nextCall(iface, 'answer', 0)
        expect(call.at - t0).toBeLessThan(1000)
        expect(call.id).toBe(id)
        expect((call.body as any).decision).toBe(decision)
        expect((call.body as any).message ?? '').toBe(message)
        const req = iface.requests()[0]
        expect(req.status).toBe('answered')
        expect(req.message).toBe(sent)
        await expect(cardHolding(page, rx(tag), ANSWERED)).toBeVisible(WITHIN)
      })
    })
  }

  // ADR-0028 section 2 (R-47): a turn that is not an approval ask gets a reply form, with no Approve and no Deny.
  test('R-47: a reply card for a turn that is not an approval ask is "The PM replied" with Send reply and no Approve or Deny', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const tag = rand()
      const text = `Nothing is waiting on approval. Give me something new. ${tag}`
      const id = iface.reply({ text, approvalAsk: false })
      const card = openCard(page, rx(tag), SEND_REPLY)
      await expect(card).toBeVisible(WITHIN)
      await expect(card).toHaveAccessibleName('The PM replied')
      await expect(card.getByRole('button', { name: APPROVE })).toHaveCount(0)
      await expect(card.getByRole('button', { name: DENY })).toHaveCount(0)
      await expect(page.getByRole('button', { name: APPROVE })).toHaveCount(0)
      await expect(page.getByRole('button', { name: DENY })).toHaveCount(0)
      const reply = `Add CSV export ${tag}`
      await card.getByRole('textbox', YOUR_REPLY).fill(reply)
      await card.getByRole('button', { name: SEND_REPLY }).click()
      const call = await nextCall(iface, 'answer', 0)
      expect(call.id).toBe(id)
      expect(call.body).toEqual({ decision: 'message', message: reply })
    })
  })

  test('R-7: a message typed in the box while a reply card is open answers that card', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const tag = rand()
      iface.reply({ text: `Shall I go on? ${tag}`, approvalAsk: false })
      await expect(openCard(page, rx(tag), SEND_REPLY)).toBeVisible(WITHIN)
      const typed = `Yes, go on ${tag}`
      const t0 = Date.now()
      await goalBox(page).fill(typed)
      await sendButton(page).click()
      const call = await nextCall(iface, 'send', 0)
      expect(call.at - t0).toBeLessThan(2000)
      expect(call.text).toBe(typed)
      const req = iface.requests()[0]
      expect(req.status).toBe('answered')
      expect(req.decision).toBe('message')
      expect(req.message).toBe(typed)
      await page.getByText(/\d+ earlier requests? answered/).click()
      await expect(cardHolding(page, rx(tag), ANSWERED)).toBeVisible(WITHIN)
    })
  })
})

// ---- goal and message box ------------------------------------------------------------------------------

test.describe('goal and message box', () => {
  test('R-15: the goal box sends POST /api/message and the text reaches SessionControl.send within 1 s', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const typed = `Build the thing ${rand()}`
      const box = goalBox(page)
      await expect(box).toBeVisible()
      // ADR-0028 section 1: with no plan the box is "Your goal" and the button "Start run"; the box is not in Your move.
      await expect(page.getByRole('textbox', { name: 'Your goal', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Start run', exact: true })).toBeVisible()
      await expect(yourMove(page).getByRole('textbox', { name: 'Your goal', exact: true })).toHaveCount(0)
      const posted = page.waitForRequest((r) => r.url().endsWith('/api/message') && r.method() === 'POST')
      const t0 = Date.now()
      await box.fill(typed)
      await sendButton(page).click()
      const req = await posted
      expect(req.postDataJSON()).toEqual({ text: typed, intent: 'goal' }) // ADR-0028 section 1: no plan sends intent goal
      const call = await nextCall(iface, 'send', 0)
      expect(call.at - t0).toBeLessThan(1000)
      expect(call.text).toBe(typed)
      expect(call.result).toEqual({ ok: true })
      // The sent text shows in the transcript.
      await expect(page.getByText(typed).first()).toBeVisible(WITHIN)
    })
  })

  test('R-15: the message box can be used by keyboard alone', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const typed = `by keyboard ${rand()}`
      const box = goalBox(page)
      await box.focus()
      await page.keyboard.type(typed)
      await page.keyboard.press('Tab')
      await expect(sendButton(page)).toBeFocused()
      await page.keyboard.press('Enter')
      const call = await nextCall(iface, 'send', 0)
      expect(call.text).toBe(typed)
      // ADR-0018: Ctrl+Enter in the box sends too, and a plain Enter only adds a line.
      const tag2 = rand()
      await box.focus()
      await page.keyboard.type(`line one ${tag2}`)
      await page.keyboard.press('Enter')
      await page.keyboard.type(`line two ${tag2}`)
      expect(iface.calls.filter((c) => c.kind === 'send')).toHaveLength(1)
      await page.keyboard.press('Control+Enter')
      await expect.poll(() => iface.calls.filter((c) => c.kind === 'send').length, { timeout: 1000 }).toBe(2)
      expect(iface.calls.filter((c) => c.kind === 'send')[1]!.text).toBe(`line one ${tag2}\nline two ${tag2}`)
    })
  })

  test('R-15: after the session ended a message gets the 409 ended answer, shown in words', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      iface.setSession({ status: 'ended' })
      iface.endSession()
      const typed = `too late ${rand()}`
      const box = goalBox(page)
      await box.fill(typed)
      const resp = page.waitForResponse((r) => r.url().endsWith('/api/message'))
      await sendButton(page).click().catch(() => {})
      const r = await resp.catch(() => null)
      if (r) {
        expect(r.status()).toBe(409)
        expect(await r.json()).toEqual({ error: 'ended' })
        // ADR-0018 section 9: the 409 shows this sentence in the Your move region.
        await expect(yourMove(page)).toContainText('The session has ended. Start the UI again to send more.', WITHIN)
      }
      // Either the control is off or the page says so in words; the text is not lost and nothing was sent.
      await expect(sessionStatus(page)).toContainText(/ended/i, WITHIN)
      expect(iface.calls.filter((c) => (c.result as any).ok === true)).toHaveLength(0)
      if (await box.isEnabled()) await expect(box).toHaveValue(typed)
    })
  })

  test('R-15: an empty message is not sent', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      await goalBox(page).fill('   ')
      await sendButton(page).click({ force: true, timeout: 1000 }).catch(() => {})
      await page.waitForTimeout(300)
      expect(iface.calls.filter((c) => c.kind === 'send' && (c.result as any).ok === true)).toHaveLength(0)
    })
  })
})

// ---- header --------------------------------------------------------------------------------------------

const usage = (): any => {
  const r = rec(82)
  return {
    costUsd: r.total_cost_usd,
    models: Object.fromEntries(Object.entries(r.modelUsage as Record<string, any>).map(([k, v]) => [k, {
      inputTokens: v.inputTokens, outputTokens: v.outputTokens, cacheReadInputTokens: v.cacheReadInputTokens, cacheCreationInputTokens: v.cacheCreationInputTokens,
    }])),
    results: 4,
    at: new Date().toISOString(),
  }
}

test.describe('header', () => {
  test('R-20: the header shows the model the session reports', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      iface.setSession({ model: 'claude-opus-5-5', status: 'running', sessionId: 'sess-1' })
      // ADR-0028 section 8: the model is no longer in the banner; the rail's run context shows it below the lg
      // breakpoint (views/rail/RunContext.tsx), so the viewport is narrowed.
      await page.setViewportSize({ width: 800, height: 900 })
      await expect(banner(page)).not.toContainText('claude-opus-5-5')
      await expect(page.getByText('claude-opus-5-5', { exact: true }).first()).toBeVisible(WITHIN)
      iface.setSession({ model: 'claude-haiku-5-5' })
      await expect(page.getByText('claude-haiku-5-5', { exact: true }).first()).toBeVisible(WITHIN)
      await expect(page.getByText('claude-opus-5-5', { exact: true })).toHaveCount(0)
    })
  })

  for (const [status, words] of [['idle', /idle/i], ['running', /running/i], ['waiting', /waiting/i], ['ended', /ended/i]] as const) {
    test(`R-3: the header shows session status ${status} in words`, async ({ page }) => {
      await withIface({}, async (iface) => {
        await open(page, iface)
        iface.setSession({ status })
        await expect(banner(page)).toContainText(words, WITHIN)
        // ADR-0018: the words are the text of the `status` named Session.
        await expect(sessionStatus(page)).toHaveText(words, WITHIN)
      })
    })
  }

  test('R-3: status error shows the first line of the error in words', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const line = `claude exited with code 1 ${rand()}`
      // D2 (ADR-0023): a session error leaves the composer's typed text in place.
      const typed = `unsent draft ${rand()}`
      await goalBox(page).fill(typed)
      iface.setSession({ status: 'error', error: line })
      await expect(banner(page)).toContainText(/error/i, WITHIN)
      await expect(goalBox(page)).toHaveValue(typed)
      await expect(sessionStatus(page)).toHaveText(`error: ${line}`, WITHIN)
      await expect(page.getByText(line).first()).toBeVisible(WITHIN)
    })
  })

  test('R-22: the header shows total_cost_usd and the usage of each model, with no limit or ceiling', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const u = usage()
      iface.setSession({ model: 'claude-opus-5-5', status: 'waiting', usage: u })
      // ADR-0028 section 8: the model and token usage moved to Run metrics ("Tokens by model" table); the banner
      // keeps a summary link "$<cost> · <time>" to #run-metrics.
      const b = banner(page)
      const tokens = page.getByRole('region', { name: 'Tokens by model', exact: true })
      await expect(tokens).toContainText('claude-haiku-5-5', WITHIN)
      await expect(tokens).toContainText('claude-opus-5-5')
      // 0.5544791 USD, however it is rounded.
      await expect(b.getByRole('link', { name: /\$0\.55/ })).toBeVisible()
      // Output tokens of the opus entry (2865), with or without a thousands separator or a k suffix.
      await expect(tokens).toContainText(/2,?865|2\.9\s?k/i)
      const text = (await b.innerText()).toLowerCase() + (await tokens.innerText()).toLowerCase()
      for (const word of ['limit', 'ceiling', 'budget', 'remaining', 'quota', 'cap ']) expect(text, word).not.toContain(word)
      expect(text).not.toMatch(/\bof \$?\d/)
      // A later result replaces the totals; nothing is summed.
      iface.setSession({ usage: { ...u, costUsd: 0.7 } })
      await expect(b).toContainText(/0\.70?\b/, WITHIN)
      await expect(b).not.toContainText(/0\.55/)
      await expect(b).not.toContainText(/1\.25/)
    })
  })

  test('R-22: with no usage yet the header shows no cost and no limit', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const text = (await banner(page).innerText()).toLowerCase()
      expect(text).not.toMatch(/limit|ceiling|budget/)
    })
  })

  test('R-3: the header shows the background task count', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const task = (n: number) => ({ taskId: `t${n}`, description: `task ${n}`, subagentType: null })
      iface.setSession({ status: 'waiting', backgroundTasks: [task(1), task(2)] })
      await expect(banner(page)).toContainText(/2\s+background|background[^0-9]{0,30}2/i, WITHIN)
      await expect(banner(page)).toContainText('working (2 background tasks)', WITHIN)
      await expect(sessionStatus(page)).toHaveText('working (2 background tasks)', WITHIN)
      iface.setSession({ backgroundTasks: [task(1)] })
      await expect(banner(page)).toContainText(/1\s+background|background[^0-9]{0,30}1/i, WITHIN)
    })
  })

  test('R-3: a notice, such as no Truss dir yet, shows in words', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const notice = `Config file missing ${rand()}`
      iface.emit({ notices: [{ id: 'no-config', text: notice }] })
      await expect(page.getByText(notice).first()).toBeVisible(WITHIN)
      const item = runStatus(page).getByRole('listitem').filter({ hasText: notice })
      await expect(item).toContainText('Status:', WITHIN)
      await expect(item).not.toContainText('Notice:')
      iface.emit({ notices: [] })
      await expect(page.getByText(notice)).toHaveCount(0, WITHIN)
    })
  })

  test('R-3: the notice already in the first snapshot shows', async ({ page }) => {
    const text = `The Truss dir does not exist yet ${rand()}`
    await withIface({ state: { notices: [{ id: 'no-truss-dir', text }] } }, async (iface) => {
      await open(page, iface)
      await expect(page.getByText(text).first()).toBeVisible(WITHIN)
      const item = runStatus(page).getByRole('listitem').filter({ hasText: text })
      await expect(item).toContainText('Status:', WITHIN)
      await expect(item).not.toContainText('Notice:')
    })
  })
})
