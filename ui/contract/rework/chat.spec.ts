// The conversation, composer and reply-card contract (ADR-0028 sections 1, 2 and 10; UX direction checklist items
// 6-15 and 19-22), written before rework-chat builds it. Cases are titled `R-<n>: ` for R-40, R-41, R-45, R-46 and
// R-47. Elements are reached by role and name only. Placement and page layout are page.spec.ts's, not this file's.
//
// The fake interface (ui/e2e/harness.ts) records a send as text only, so the intent a message carries is read off
// the wire: a route on POST /api/message captures the body. A reply card answer is read from `iface.calls`.
import { test, expect, type Page } from '@playwright/test'
import { T, LOAD, WIDTHS, openFixture } from './support.ts'

const DESKTOP = WIDTHS.wide
const THEME = 'light' as const
const NOT_SENT = /^Not sent: .+\. Your text is still here\.$/

/** Records every POST /api/message body; `fail` makes them answer 500 instead of reaching the server. */
async function spyMessages(page: Page, mode: { fail?: boolean; hold?: boolean } = {}) {
  const bodies: Array<{ text: string; intent?: string }> = []
  await page.route('**/api/message', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    bodies.push(route.request().postDataJSON())
    if (mode.hold) return // never answered: the send is stuck
    if (mode.fail) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'server' }) })
    return route.continue()
  })
  return { bodies, mode }
}

const composerOf = (page: Page) => page.getByRole('form', { name: 'Message' })

test.describe('chat: composer', () => {
  test('R-41: with no plan the composer is "Your goal" and the button "Start run", which sends intent goal', async ({ browser }) => {
    const o = await openFixture(browser, 'no-run', THEME, DESKTOP)
    try {
      const { page } = o
      const spy = await spyMessages(page)
      const form = composerOf(page)
      const box = form.getByRole('textbox', { name: 'Your goal', exact: true })
      await expect(box).toBeVisible(LOAD)
      const send = form.getByRole('button', { name: 'Start run', exact: true })
      // empty: Send is disabled and the hint says why (UX states, Composer / Empty; checklist 8)
      await expect(send).toBeDisabled(T)
      await expect(box).toHaveAccessibleDescription('Type a goal first.', T)
      await expect(form.getByRole('radio'), 'no Message / New goal choice before a plan').toHaveCount(0, T)
      // typed: the hint says what Start run does (checklist 6)
      await box.fill('Add CSV export')
      await expect(send).toBeEnabled(T)
      await expect(box).toHaveAccessibleDescription('Starts a truss run on this goal.', T)
      await send.click()
      await expect.poll(() => o.planted.iface.calls.filter((c) => c.kind === 'send').length, T).toBe(1)
      expect(spy.bodies).toEqual([{ text: 'Add CSV export', intent: 'goal' }])
      expect(o.planted.iface.calls[0]!.text, 'the transcript text is what was typed').toBe('Add CSV export')
      expect(await o.problems()).toEqual([])
    } finally { await o.stop() }
  })

  test('R-41: while a run is live the button is "Send to PM" with no intent; "New goal" relabels it and sends goal', async ({ browser }) => {
    const o = await openFixture(browser, 'live', THEME, DESKTOP)
    try {
      const { page } = o
      const spy = await spyMessages(page)
      const form = composerOf(page)
      const box = form.getByRole('textbox', { name: 'Message to the PM', exact: true })
      await expect(box).toBeVisible(LOAD)
      await expect(form.getByRole('textbox', { name: 'Your goal' })).toHaveCount(0, T)
      await box.fill('Please also cover the dark theme')
      await expect(form.getByRole('button', { name: 'Send to PM', exact: true })).toBeEnabled(T)
      await expect(box).toHaveAccessibleDescription('Sends to the PM as a message.', T)
      await form.getByRole('button', { name: 'Send to PM', exact: true }).click()
      await expect.poll(() => spy.bodies.length, T).toBe(1)
      expect(spy.bodies[0], 'a plain message carries no intent').toEqual({ text: 'Please also cover the dark theme' })
      // now the other choice
      await form.getByRole('radio', { name: 'Message', exact: true }).waitFor(T)
      await form.getByRole('radio', { name: 'New goal', exact: true }).click()
      await expect(form.getByRole('button', { name: 'Send to PM' })).toHaveCount(0, T)
      await expect(box).toHaveAccessibleDescription('Sends to the PM as a new goal for this run.', T)
      await box.fill('Add a second export format')
      await form.getByRole('button', { name: 'Add as new goal', exact: true }).click()
      await expect.poll(() => spy.bodies.length, T).toBe(2)
      expect(spy.bodies[1]).toEqual({ text: 'Add a second export format', intent: 'goal' })
      expect(await o.problems()).toEqual([])
    } finally { await o.stop() }
  })

  test('R-45: a failed send shows "Not sent: <reason>. Your text is still here." tied to the box, keeps the text, and Try again resends', async ({ browser }) => {
    const o = await openFixture(browser, 'live', THEME, DESKTOP)
    try {
      const { page } = o
      const spy = await spyMessages(page, { fail: true })
      const form = composerOf(page)
      const box = form.getByRole('textbox', { name: 'Message to the PM' })
      await expect(box).toBeVisible(LOAD)
      await box.fill('This one will fail')
      await form.getByRole('button', { name: 'Send to PM' }).click()
      const alert = form.getByRole('alert')
      await expect(alert).toHaveText(NOT_SENT, T)
      await expect(box).toHaveValue('This one will fail', T)
      await expect(box).toHaveAttribute('aria-invalid', 'true', T)
      await expect(box, 'the alert is the box description').toHaveAccessibleDescription(NOT_SENT, T)
      // Try again goes out once the failure is gone
      spy.mode.fail = false
      await form.getByRole('button', { name: 'Try again' }).click()
      await expect.poll(() => o.planted.iface.calls.filter((c) => c.kind === 'send').length, T).toBe(1)
      expect(o.planted.iface.calls[0]!.text).toBe('This one will fail')
      await expect(box).toHaveValue('', T)
    } finally { await o.stop() }
  })

  test('R-45: no ack shows "Still sending…" at 10 s and, at 30 s, an alert offering Try again with the text kept', async ({ browser }) => {
    const o = await openFixture(browser, 'live', THEME, DESKTOP, { before: (page) => page.clock.install() })
    try {
      const { page } = o
      await spyMessages(page, { hold: true })
      const form = composerOf(page)
      const box = form.getByRole('textbox', { name: 'Message to the PM' })
      await expect(box).toBeVisible(LOAD)
      await box.fill('Nobody answers this')
      await form.getByRole('button', { name: 'Send to PM' }).click()
      await expect(form.getByRole('button', { name: 'Sending…' }), 'the button reads Sending… and is disabled').toBeDisabled(T)
      await page.clock.fastForward(10_500)
      await expect(form.getByText('Still sending…')).toBeVisible(T)
      await page.clock.fastForward(20_000)
      await expect(form.getByRole('alert')).toContainText("The session hasn't taken the message. Try again, or reload if it keeps happening.", T)
      await expect(form.getByRole('button', { name: 'Try again' })).toBeVisible(T)
      await expect(box).toHaveValue('Nobody answers this', T)
    } finally { await o.stop() }
  })

  test('R-45: while a Your move card is open the composer stays usable and its hint says the PM waits on the card', async ({ browser }) => {
    const o = await openFixture(browser, 'reply-open', THEME, DESKTOP)
    try {
      const { page } = o
      const box = composerOf(page).getByRole('textbox', { name: 'Message to the PM' })
      await expect(box).toBeEnabled(LOAD)
      await expect(box).toHaveAccessibleDescription('The PM is waiting on the card above; a message here is sent as well.', T)
    } finally { await o.stop() }
  })
})

test.describe('chat: thread', () => {
  test('R-45: with no messages the thread shows the PM-side line, not a blank panel', async ({ browser }) => {
    const o = await openFixture(browser, 'no-run', THEME, DESKTOP)
    try {
      const log = o.page.getByRole('log', { name: 'Conversation with the PM' })
      await expect(log).toBeVisible(LOAD)
      await expect(log.getByText('Tell the PM what to build. Sending your goal starts a truss run.')).toBeVisible(T)
    } finally { await o.stop() }
  })

  test('R-45: the thread is a polite log; the four newest messages are in view, client right and PM left', async ({ browser }) => {
    const o = await openFixture(browser, 'thread', THEME, DESKTOP)
    try {
      const log = o.page.getByRole('log', { name: 'Conversation with the PM' })
      await expect(log).toBeVisible(LOAD)
      await expect(log).toHaveAttribute('aria-live', 'polite', T)
      const msgs = {
        client1: log.getByText('Add CSV export to the reports page.'),
        pm1: log.getByText('On it. I will plan two crews and start the first now.'),
        client2: log.getByText('Also make it respect the date filter.'),
        pm2: log.getByText('Noted: the export will use the same date filter as the page.'),
      }
      for (const m of Object.values(msgs)) await expect(m).toBeInViewport(T)
      const box = async (l: typeof msgs.pm1) => (await l.boundingBox())!
      const [logBox, c1, c2, p1, p2] = [(await log.boundingBox())!, await box(msgs.client1), await box(msgs.client2), await box(msgs.pm1), await box(msgs.pm2)]
      for (const c of [c1, c2]) expect(logBox.x + logBox.width - (c.x + c.width), 'client messages hug the right edge').toBeLessThan(48)
      for (const p of [p1, p2]) expect(p.x - logBox.x, 'PM messages hug the left edge').toBeLessThan(48)
      expect(c2.x, 'a client message starts right of a PM message').toBeGreaterThan(p2.x)
    } finally { await o.stop() }
  })

  test('R-45: at most 50 messages render first; "Show earlier messages" loads older ones', async ({ browser }) => {
    const o = await openFixture(browser, 'thread', THEME, DESKTOP)
    try {
      const log = o.page.getByRole('log', { name: 'Conversation with the PM' })
      await expect(log.getByText('Noted: the export will use the same date filter as the page.')).toBeVisible(LOAD)
      const older = log.getByText(/^Older (message|reply) \d+ from the (client|PM)\.$/)
      const first = await older.count()
      expect(first, 'the 4 newest plus the older ones make at most 50').toBeLessThanOrEqual(46)
      expect(first).toBeGreaterThan(0)
      await log.getByRole('button', { name: 'Show earlier messages' }).click()
      await expect.poll(() => older.count(), T).toBeGreaterThan(first)
    } finally { await o.stop() }
  })

  test('R-45: scrolled up, a new message shows "New messages" instead of jumping; pressing it shows the message', async ({ browser }) => {
    const o = await openFixture(browser, 'thread', THEME, DESKTOP)
    try {
      const { page } = o
      const log = page.getByRole('log', { name: 'Conversation with the PM' })
      await expect(log.getByText('Noted: the export will use the same date filter as the page.')).toBeVisible(LOAD)
      await log.evaluate((el) => { el.scrollTop = 0 })
      await expect.poll(() => log.evaluate((el) => el.scrollTop), T).toBe(0)
      o.planted.iface.emit(null, [{ n: 65, role: 'assistant', text: 'A fresh reply from the PM.', ts: new Date().toISOString(), id: null, intent: null }])
      const more = page.getByRole('button', { name: 'New messages' })
      await expect(more).toBeVisible(T)
      expect(await log.evaluate((el) => el.scrollTop), 'the thread did not jump').toBe(0)
      await more.click()
      await expect(log.getByText('A fresh reply from the PM.')).toBeInViewport(T)
    } finally { await o.stop() }
  })

  test('R-40: the PM hand-off to a crew shows in the thread as a system line "PM → crew <slug>: <summary>"', async ({ browser }) => {
    const o = await openFixture(browser, 'live', THEME, DESKTOP)
    try {
      const log = o.page.getByRole('log', { name: 'Conversation with the PM' })
      const flow = o.planted.fixture.session.flow as Array<{ to: string | null; summary: string }>
      expect(flow.length).toBeGreaterThan(0)
      for (const f of flow.filter((e) => e.to)) await expect(log.getByText(`PM → crew ${f.to}: ${f.summary}`)).toBeVisible(LOAD)
    } finally { await o.stop() }
  })
})

test.describe('chat: Your move reply card', () => {
  test('R-47: a turn that is not an approval ask is "The PM replied" with Your reply and Send reply, and no Approve or Deny', async ({ browser }) => {
    const o = await openFixture(browser, 'reply-open', THEME, DESKTOP)
    try {
      const { page } = o
      const card = page.getByRole('article', { name: 'The PM replied', exact: true })
      await expect(card).toBeVisible(LOAD)
      await expect(card.getByText('The PM replied', { exact: true })).toBeVisible(T)
      await expect(card.getByRole('textbox', { name: 'Your reply', exact: true })).toBeVisible(T)
      await expect(card.getByRole('button', { name: 'Send reply', exact: true })).toBeVisible(T)
      await expect(card.getByRole('button', { name: 'Read in thread' })).toBeVisible(T)
      await expect(page.getByRole('button', { name: /^(Approve|Deny)\b/ }), 'no Approve or Deny anywhere on the page').toHaveCount(0, T)
      await expect(page.getByText('Reply needed'), 'the old title is gone').toHaveCount(0, T)
    } finally { await o.stop() }
  })

  test('R-47: Send reply posts {decision: message, message}; a failed send keeps the reply text', async ({ browser }) => {
    const o = await openFixture(browser, 'reply-open', THEME, DESKTOP)
    try {
      const { page } = o
      const card = page.getByRole('article', { name: 'The PM replied', exact: true })
      const box = card.getByRole('textbox', { name: 'Your reply', exact: true })
      await expect(box).toBeVisible(LOAD)
      // first answer fails on the wire
      let fail = true
      await page.route('**/api/requests/*/answer', (route) => (fail ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'server' }) }) : route.continue()))
      await box.fill('Add dark mode to the export dialog')
      await card.getByRole('button', { name: 'Send reply', exact: true }).click()
      await expect(card.getByRole('alert')).toBeVisible(T)
      await expect(box, 'the typed reply survives a failed send').toHaveValue('Add dark mode to the export dialog', T)
      fail = false
      await card.getByRole('button', { name: 'Send reply', exact: true }).click()
      await expect.poll(() => o.planted.iface.calls.filter((c) => c.kind === 'answer').length, T).toBe(1)
      const call = o.planted.iface.calls.find((c) => c.kind === 'answer')!
      expect(call.id).toBe('req-reply-1')
      expect(call.body).toEqual({ decision: 'message', message: 'Add dark mode to the export dialog' })
    } finally { await o.stop() }
  })

  test('R-47: an approval ask is "Approval needed" with Approve and Deny hints, and typed text makes Send reply primary', async ({ browser }) => {
    const o = await openFixture(browser, 'approval-ask', THEME, DESKTOP)
    try {
      const { page } = o
      const card = page.getByRole('article', { name: 'Approval needed', exact: true })
      await expect(card).toBeVisible(LOAD)
      const approve = card.getByRole('button', { name: /^Approve\b/ })
      const deny = card.getByRole('button', { name: /^Deny\b/ })
      await expect(approve).toBeVisible(T)
      await expect(deny).toBeVisible(T)
      await expect(approve).toContainText('Sends: Approved.', T)
      await expect(deny).toContainText('Sends: Not approved.', T)
      const reply = card.getByRole('button', { name: 'Send reply', exact: true })
      await expect(reply).toBeVisible(T)
      const before = await reply.evaluate((el) => getComputedStyle(el).backgroundColor)
      await card.getByRole('textbox', { name: 'Your reply', exact: true }).fill('Approved, but keep the old export too')
      await expect.poll(() => reply.evaluate((el) => getComputedStyle(el).backgroundColor), T).not.toBe(before)
      // the Approve button gives up the primary look at the same time: it now looks like the quiet Deny
      const look = (l: typeof approve) => l.evaluate((el) => getComputedStyle(el).backgroundColor)
      expect(await look(approve), 'Approve is no longer the primary button').toBe(await look(deny))
    } finally { await o.stop() }
  })

  test('R-47: Approve on an approval ask answers {decision: allow}', async ({ browser }) => {
    const o = await openFixture(browser, 'approval-ask', THEME, DESKTOP)
    try {
      const card = o.page.getByRole('article', { name: 'Approval needed', exact: true })
      await expect(card.getByRole('button', { name: /^Approve\b/ })).toBeVisible(LOAD)
      await card.getByRole('button', { name: /^Approve\b/ }).click(T)
      await expect.poll(() => o.planted.iface.calls.filter((c) => c.kind === 'answer').length, T).toBe(1)
      expect((o.planted.iface.calls.find((c) => c.kind === 'answer')!.body as any).decision).toBe('allow')
    } finally { await o.stop() }
  })

  for (const name of ['no-run', 'live'] as const) {
    test(`R-47: with nothing pending (${name}) there is no Your move card and no "Nothing needs you right now"`, async ({ browser }) => {
      const o = await openFixture(browser, name, THEME, DESKTOP)
      try {
        const { page } = o
        await expect(composerOf(page)).toBeVisible(LOAD)
        await expect(page.getByRole('region', { name: 'Your move' })).toHaveCount(0, T)
        await expect(page.getByRole('article', { name: /^(The PM replied|Approval needed)$/ })).toHaveCount(0, T)
        await expect(page.getByText('Nothing needs you right now')).toHaveCount(0, T)
      } finally { await o.stop() }
    })
  }
})
