// The four states where the person has a move, pinned by behaviour and role: empty, question, approval and
// follow-up (ADR-0023 section 4; ADR-0018 section 10; gaps a and b). Each test plants a fixture from
// fixtures/run/<state>/ (support.ts scenario, port 0, an mkdtemp copy), opens the page, and asserts what only D2
// shows. Written before the client exists: every test fails on the old client at a D2-only assertion.
import { test, expect } from '@playwright/test'
import { T, LOAD, scenario, openState, token, tokens, WIDTHS, type Theme } from './support.ts'

const DESKTOP = WIDTHS[2]![1]
const THEMES: Theme[] = ['light', 'dark']

test.describe('moves', () => {
  for (const theme of THEMES) {
    test(`empty (${theme}): Start a run, no plan, no metrics, Send, and the move colour`, async ({ browser }) => {
      expect(tokens.colors.move, 'tokens.json holds move').toBeTruthy()
      const s = await scenario('empty')
      const o = await openState(browser, s, theme, DESKTOP)
      try {
        const { page } = o
        const toggle = page.getByRole('button', { name: 'Dark theme' })
        const other: Theme = theme === 'dark' ? 'light' : 'dark'
        await expect(toggle).toHaveAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false', LOAD)
        // the toggle works: pressing it flips aria-pressed and the page's bg token, pressing again puts both back
        await toggle.click()
        await expect(toggle, 'pressing Dark theme flips aria-pressed').toHaveAttribute('aria-pressed', other === 'dark' ? 'true' : 'false', T)
        await expect(page.locator('body'), 'pressing Dark theme repaints body with the other theme bg').toHaveCSS('background-color', token('bg', other), T)
        await toggle.click()
        await expect(toggle, 'pressing Dark theme again restores aria-pressed').toHaveAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false', T)
        await expect(page.locator('body'), 'pressing Dark theme again restores the bg').toHaveCSS('background-color', token('bg', theme), T)
        const move = page.getByRole('region', { name: 'Your move' })
        await expect(move.getByRole('article')).toHaveCount(0, T)
        await expect(move.getByRole('heading', { level: 3, name: 'Start a run' })).toBeVisible(T)
        await expect(move.getByText('Type a goal. Truss plans it, and asks you here when it needs a call.')).toBeVisible(T)
        const form = page.getByRole('form', { name: 'Message' })
        await expect(form.getByRole('radiogroup', { name: 'What this message is' })).toHaveCount(0, T)
        const send = form.getByRole('button', { name: 'Send', exact: true })
        await expect(send).toBeVisible(T)
        await expect(send, 'the one primary action is the move surface').toHaveCSS('background-color', token('move', theme), T)
        await expect(page.locator('body')).toHaveCSS('background-color', token('bg', theme), T)
        await expect(page.getByRole('region', { name: 'Live metrics' })).toHaveCount(0, T)
        await expect(page.getByRole('tabpanel').getByText('No plan yet.')).toBeVisible(T)
        await expect(page.getByRole('region', { name: 'Crews' }).getByRole('button')).toHaveCount(0, T)
        await expect(page.getByText('Nothing built yet. Plans, ADRs and screenshots appear here as crews finish.')).toBeVisible(T)
        await expect(page.getByRole('group', { name: 'Filter by type' })).toHaveCount(0, T)
        expect(await o.problems()).toEqual([])
      } finally { await o.close(); await s.stop() }
    })

    test(`question (${theme}): the article, the recommended radio, own answer, title and queue note`, async ({ browser }) => {
      const s = await scenario('question')
      const o = await openState(browser, s, theme, DESKTOP)
      try {
        const { page } = o
        const q = s.fixture.requests[0].questions[0]
        const move = page.getByRole('region', { name: 'Your move' })
        const card = move.getByRole('article', { name: `Question from Claude: ${q.header}` })
        await expect(card).toBeVisible(LOAD)
        await expect(card, 'the only filled move surface').toHaveCSS('background-color', token('move', theme), T)
        const group = card.getByRole('radiogroup', { name: q.question })
        await expect(group.getByRole('radio')).toHaveCount(q.options.length, T)
        await expect(group.getByRole('radio').first()).toHaveAccessibleName(/\(Recommended\)$/, T)
        await expect(card.getByRole('textbox', { name: 'Your own answer' })).toBeVisible(T)
        await expect(card.getByRole('button', { name: 'Submit answers' })).toBeVisible(T)
        await expect(page).toHaveTitle('(1) Truss', T)
        const form = page.getByRole('form', { name: 'Message' })
        await expect(form.getByText("Claude's turn is open on your question. Anything you send now waits in the queue and goes out once you answer it.")).toBeVisible(T)
        await expect(form.getByRole('radiogroup', { name: 'What this message is' }).getByRole('radio', { name: 'Answer the question' })).toBeVisible(T)
        expect(await o.problems()).toEqual([])
      } finally { await o.close(); await s.stop() }
    })

    test(`approval (${theme}): two articles, the oldest filled, one more waiting, title (2)`, async ({ browser }) => {
      const s = await scenario('approval')
      const o = await openState(browser, s, theme, DESKTOP)
      try {
        const { page } = o
        const [reply, perm] = s.fixture.requests
        const move = page.getByRole('region', { name: 'Your move' })
        const replyCard = move.getByRole('article', { name: 'Reply needed' })
        await expect(replyCard).toBeVisible(LOAD)
        await expect(replyCard, 'the oldest article is the filled move surface').toHaveCSS('background-color', token('move', theme), T)
        await expect(replyCard).toContainText(reply.text, T)
        await expect(replyCard.getByRole('button', { name: 'Approve' })).toBeVisible(T)
        await expect(replyCard.getByRole('button', { name: 'Deny' })).toBeVisible(T)
        await expect(replyCard.getByRole('textbox', { name: 'Message with your answer' })).toBeVisible(T)
        const permCard = move.getByRole('article', { name: `Permission request: ${perm.toolName}` })
        await expect(permCard).toBeVisible(T)
        await expect(permCard, 'the second card is a surface card, not the move colour').not.toHaveCSS('background-color', token('move', theme), T)
        await expect(permCard).toHaveCSS('background-color', token('surface', theme), T)
        for (const text of [perm.toolName, perm.title, perm.summary, perm.decisionReason, perm.blockedPath]) await expect(permCard).toContainText(text, T)
        await expect(permCard.getByRole('button', { name: 'Approve' })).toBeVisible(T)
        await expect(permCard.getByRole('button', { name: 'Deny' })).toBeVisible(T)
        await expect(move.getByRole('article')).toHaveCount(2, T)
        await expect(move.getByText('1 more waiting on you')).toBeVisible(T)
        await expect(page).toHaveTitle('(2) Truss', T)
        expect(await o.problems()).toEqual([])
      } finally { await o.close(); await s.stop() }
    })
  }

  test('follow-up: Queued and Sent chips, newest first, no plan-revision status, the send name follows the radio', async ({ browser }) => {
    const s = await scenario('follow-up')
    const o = await openState(browser, s, 'light', DESKTOP)
    try {
      const { page } = o
      const region = page.getByRole('region', { name: 'Follow-ups' })
      await expect(region).toBeVisible(LOAD)
      await expect(region.getByText('Queued', { exact: true })).toHaveCount(s.fixture.session.queue.length, T)
      await expect(region.getByText(/^Sent \d\d:\d\d$/).first()).toBeVisible(T)
      await expect(region.getByText('New goal').first()).toBeVisible(T)
      await expect(region.getByText('Add to current goal').first()).toBeVisible(T)
      await expect(page.getByText(/In the plan|plan revision/i)).toHaveCount(0, T)
      // newest first: the queued row (msg-4) comes before the long one (msg-2)
      const rows = await region.getByRole('listitem').allInnerTexts()
      const iNew = rows.findIndex((r) => r.includes('Also keep the quota error text short.'))
      const iOld = rows.findIndex((r) => r.includes('Please also make the follow-up list'))
      expect(iNew, 'the queued row is listed').toBeGreaterThanOrEqual(0)
      expect(iNew, 'newest first').toBeLessThan(iOld)
      const group = page.getByRole('form', { name: 'Message' }).getByRole('radiogroup', { name: 'What this message is' })
      await expect(group.getByRole('radio', { name: 'Answer the question' })).toHaveCount(0, T)
      await group.getByRole('radio', { name: 'New goal' }).check()
      await expect(page.getByRole('form', { name: 'Message' }).getByRole('button', { name: 'Add goal' })).toBeVisible(T)
      await group.getByRole('radio', { name: 'Add to current goal' }).check()
      await expect(page.getByRole('form', { name: 'Message' }).getByRole('button', { name: 'Send details' })).toBeVisible(T)
      expect(await o.problems()).toEqual([])
    } finally { await o.close(); await s.stop() }
  })

  test('follow-up: a 300-character row keeps its whole text in the accessible name or title', async ({ browser }) => {
    const s = await scenario('follow-up')
    const o = await openState(browser, s, 'dark', 360)
    try {
      const { page } = o
      const long = s.fixture.transcript.find((e: any) => e.id === 'msg-2').text as string
      expect(long.length).toBeGreaterThanOrEqual(300)
      const row = page.getByRole('region', { name: 'Follow-ups' }).getByRole('listitem').filter({ hasText: 'Please also make the follow-up list' })
      await expect(row).toBeVisible(LOAD)
      const full = row.getByTitle(long)
      await expect(full).toHaveCount(1, T)
      // not only a hover tooltip: keyboard and touch users reach the whole text by focus and by name
      await full.focus()
      await expect(full, 'the row text takes focus').toBeFocused(T)
      await expect(full, 'the focused row names the whole 300-character text').toHaveAccessibleName(long, T)
      const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
      expect(w[0], 'the long row never widens the phone page').toBeLessThanOrEqual(w[1]!)
    } finally { await o.close(); await s.stop() }
  })

  test('error path: a session error reads error: <first line> and the composer keeps its typed text', async ({ browser }) => {
    const s = await scenario('follow-up')
    const o = await openState(browser, s, 'light', DESKTOP)
    try {
      const { page } = o
      const box = page.getByRole('form', { name: 'Message' }).getByRole('textbox', { name: 'Goal or message' })
      await expect(page.getByRole('button', { name: 'Dark theme' })).toBeVisible(LOAD)
      await box.fill('my half-typed detail')
      s.iface.setSession({ status: 'error', error: 'rate limited\nretry in 30s' })
      await expect(page.getByRole('status', { name: 'Session' })).toHaveText('error: rate limited', T)
      await expect(box).toHaveValue('my half-typed detail', T)
    } finally { await o.close(); await s.stop() }
  })
})
