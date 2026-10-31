// ui-web: request cards, message box and header (ADR-0011 Decisions 2, 3, 6; R-3, R-7, R-15, R-20, R-22).
// Written from the spec before ui/web exists. The server is the real createServer on port 0 with the real
// createRegistry (startInterface); the cards come from the real questionCard and permissionCard on the inputs
// recorded in ui/contract/fixtures/sdk-stream.jsonl. No fake Claude session. Controls are found by role and
// accessible name, never by a fixed id or class.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startInterface, rand, rx, root, WITHIN, type Iface, type QuestionSpec } from './harness.ts'
import { questionCard, permissionCard } from '../server/session/index.ts'

// ---- fixture inputs ------------------------------------------------------------------------------------

const fixtureLines = readFileSync(join(root, 'ui', 'contract', 'fixtures', 'sdk-stream.jsonl'), 'utf8').trim().split('\n')
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

const CARD_ROLES = ['article', 'group', 'region', 'listitem', 'form'] as const
// The innermost card-like element that holds `text` and a control matching `controls` (a card still open).
function openCard(page: Page, text: RegExp | string, controls: RegExp): Locator {
  const hasText = typeof text === 'string' ? rx(text) : text
  return CARD_ROLES.map((r) => page.getByRole(r as 'article').filter({ hasText }).filter({ has: page.getByRole('button', { name: controls }) })).reduce((a, b) => a.or(b)).last()
}
// Any card-like element that holds all the given texts (works after the card lost its buttons).
function cardHolding(page: Page, ...texts: Array<RegExp | string>): Locator {
  return CARD_ROLES.map((r) => {
    let l = page.getByRole(r as 'article')
    for (const t of texts) l = l.filter({ hasText: typeof t === 'string' ? rx(t) : t })
    return l
  }).reduce((a, b) => a.or(b)).first()
}
const APPROVE = /approve|allow/i
const DENY = /deny|reject/i
const SUBMIT = /submit|send|answer|reply/i
const ANSWERED = /answered|approved|allowed|denied|replied/i

function option(card: Locator, label: string): Locator {
  const name = rx(label.replace(/ \(Recommended\)$/, ''))
  return card.getByRole('radio', { name }).or(card.getByRole('checkbox', { name })).or(card.getByRole('button', { name })).first()
}
async function submit(card: Locator): Promise<void> {
  const b = card.getByRole('button', { name: SUBMIT })
  if ((await b.count()) > 0) await b.first().click()
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
      const rec1 = option(card, first.options[0]!.label)
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
      await option(card, 'Python CLI').click()
      await option(card, 'Bare semver, exit 0 (Recommended)').click()
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
      const other = card.getByRole('radio', { name: /other|own|free|type/i }).or(card.getByRole('button', { name: /other|own answer|free|type/i }))
      if ((await other.count()) > 0) await other.first().click()
      const typed = `my own words ${tag}`
      await card.getByRole('textbox').first().fill(typed)
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
        if (message) await card.getByRole('textbox').first().fill(message)
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
      iface.reply({ text: `Plan is ready ${tag}. Approve?`, isError: true, backgroundTasks: 3 })
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
    ['approve with a message', 'allow', APPROVE, 'but mind the tests', 'Approved.\n\nbut mind the tests'],
    ['deny with a message', 'deny', DENY, 'use a smaller plan', 'Not approved.\n\nuse a smaller plan'],
  ] as const) {
    test(`R-7, R-15: reply card ${name} posts the decision and reaches SessionControl.answer within 1 s`, async ({ page }) => {
      await withIface({}, async (iface) => {
        await open(page, iface)
        const tag = rand()
        const id = iface.reply({ text: `Push now? ${tag}` })
        const card = openCard(page, rx(tag), button)
        await expect(card).toBeVisible(WITHIN)
        if (message) await card.getByRole('textbox').first().fill(message)
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

  test('R-7: a message typed in the box while a reply card is open answers that card', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const tag = rand()
      iface.reply({ text: `Shall I go on? ${tag}` })
      await expect(openCard(page, rx(tag), APPROVE)).toBeVisible(WITHIN)
      const typed = `Yes, go on ${tag}`
      const t0 = Date.now()
      await page.getByRole('textbox', { name: /goal|message/i }).fill(typed)
      await page.getByRole('button', { name: /^(send|start)|send message|start/i }).click()
      const call = await nextCall(iface, 'send', 0)
      expect(call.at - t0).toBeLessThan(2000)
      expect(call.text).toBe(typed)
      const req = iface.requests()[0]
      expect(req.status).toBe('answered')
      expect(req.decision).toBe('message')
      expect(req.message).toBe(typed)
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
      const box = page.getByRole('textbox', { name: /goal|message/i })
      await expect(box).toBeVisible()
      const posted = page.waitForRequest((r) => r.url().endsWith('/api/message') && r.method() === 'POST')
      const t0 = Date.now()
      await box.fill(typed)
      await page.getByRole('button', { name: /send|start/i }).click()
      const req = await posted
      expect(req.postDataJSON()).toEqual({ text: typed })
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
      const box = page.getByRole('textbox', { name: /goal|message/i })
      await box.focus()
      await page.keyboard.type(typed)
      await page.keyboard.press('Tab')
      await expect(page.getByRole('button', { name: /send|start/i })).toBeFocused()
      await page.keyboard.press('Enter')
      const call = await nextCall(iface, 'send', 0)
      expect(call.text).toBe(typed)
    })
  })

  test('R-15: after the session ended a message gets the 409 ended answer, shown in words', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      iface.setSession({ status: 'ended' })
      iface.endSession()
      const typed = `too late ${rand()}`
      const box = page.getByRole('textbox', { name: /goal|message/i })
      await box.fill(typed)
      const resp = page.waitForResponse((r) => r.url().endsWith('/api/message'))
      await page.getByRole('button', { name: /send|start/i }).click().catch(() => {})
      const r = await resp.catch(() => null)
      if (r) {
        expect(r.status()).toBe(409)
        expect(await r.json()).toEqual({ error: 'ended' })
      }
      // Either the control is off or the page says so in words; the text is not lost and nothing was sent.
      await expect(page.getByText(/ended/i).first()).toBeVisible(WITHIN)
      expect(iface.calls.filter((c) => (c.result as any).ok === true)).toHaveLength(0)
      if (await box.isEnabled()) await expect(box).toHaveValue(typed)
    })
  })

  test('R-15: an empty message is not sent', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      await page.getByRole('textbox', { name: /goal|message/i }).fill('   ')
      await page.getByRole('button', { name: /send|start/i }).click({ force: true, timeout: 1000 }).catch(() => {})
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
      await expect(banner(page)).toContainText('claude-opus-5-5', WITHIN)
      iface.setSession({ model: 'claude-haiku-5-5' })
      await expect(banner(page)).toContainText('claude-haiku-5-5', WITHIN)
      await expect(banner(page)).not.toContainText('claude-opus-5-5')
    })
  })

  for (const [status, words] of [['idle', /idle/i], ['running', /running/i], ['waiting', /waiting/i], ['ended', /ended/i]] as const) {
    test(`R-3: the header shows session status ${status} in words`, async ({ page }) => {
      await withIface({}, async (iface) => {
        await open(page, iface)
        iface.setSession({ status })
        await expect(banner(page)).toContainText(words, WITHIN)
      })
    })
  }

  test('R-3: status error shows the first line of the error in words', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const line = `claude exited with code 1 ${rand()}`
      iface.setSession({ status: 'error', error: line })
      await expect(banner(page)).toContainText(/error/i, WITHIN)
      await expect(page.getByText(line).first()).toBeVisible(WITHIN)
    })
  })

  test('R-22: the header shows total_cost_usd and the usage of each model, with no limit or ceiling', async ({ page }) => {
    await withIface({}, async (iface) => {
      await open(page, iface)
      const u = usage()
      iface.setSession({ model: 'claude-opus-5-5', status: 'waiting', usage: u })
      const b = banner(page)
      await expect(b).toContainText('claude-haiku-5-5', WITHIN)
      await expect(b).toContainText('claude-opus-5-5')
      // 0.5544791 USD, however it is rounded.
      await expect(b).toContainText(/\$?\s?0\.55/)
      // Output tokens of the opus entry (2865), with or without a thousands separator or a k suffix.
      await expect(b).toContainText(/2,?865|2\.9\s?k/i)
      const text = (await b.innerText()).toLowerCase()
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
      iface.emit({ notices: [] })
      await expect(page.getByText(notice)).toHaveCount(0, WITHIN)
    })
  })

  test('R-3: the notice already in the first snapshot shows', async ({ page }) => {
    const text = `The Truss dir does not exist yet ${rand()}`
    await withIface({ state: { notices: [{ id: 'no-truss-dir', text }] } }, async (iface) => {
      await open(page, iface)
      await expect(page.getByText(text).first()).toBeVisible(WITHIN)
    })
  })
})
