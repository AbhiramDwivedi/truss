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
    test(`empty (${theme}): no Your move, the PM node and dashed card, Start run, Run metrics, and the move colour`, async ({ browser }) => {
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
        // ADR-0028 section 10 / UX: nothing pending means no Your move section and no "Start a run" hero
        await expect(move).toHaveCount(0, T)
        await expect(page.getByText('Nothing needs you right now')).toHaveCount(0, T)
        const form = page.getByRole('form', { name: 'Message' })
        await expect(form.getByRole('radio', { name: 'New goal' }), 'New goal is the default before a run').toBeChecked(T)
        // ADR-0028 section 1: with no plan the composer is "Your goal" and the button "Start run"
        await expect(form.getByRole('textbox', { name: 'Your goal', exact: true })).toBeVisible(T)
        const send = form.getByRole('button', { name: 'Start run', exact: true })
        await expect(send).toBeVisible(T)
        await expect(send, 'the one primary action is the move surface').toHaveCSS('background-color', token('move', theme), T)
        await expect(page.locator('body')).toHaveCSS('background-color', token('bg', theme), T)
        await expect(page.getByRole('region', { name: 'Run metrics' }), 'Run metrics is always shown (R-43)').toBeVisible(T)
        // ADR-0028 section 10 (R-36): the PM node and a dashed card replace the old empty-plan line
        const network = page.getByRole('region', { name: 'Build network' })
        await expect(network.getByText('Waiting for your goal')).toBeVisible(T)
        await expect(network.getByText('Crews appear here once the PM has a plan.')).toBeVisible(T)
        await expect(page.getByText(/No plan\s+yet/)).toHaveCount(0, T)
        await expect(network.getByRole('article')).toHaveCount(0, T)
        await expect(page.getByText('Nothing built yet. Deliverables appear as crews finish.')).toBeVisible(T)
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
        // the Your move pill is signal-soft with signal-text text (ADR-0023 section 3), never D2's raw #3B2604 on signal
        const pill = card.getByText('Your move', { exact: true })
        await expect(pill, 'the Your move pill is on the card').toBeVisible(T)
        await expect(pill, 'the pill is tokens.json signal-soft').toHaveCSS('background-color', token('signal-soft', theme), T)
        await expect(pill, 'the pill text is tokens.json signal-text').toHaveCSS('color', token('signal-text', theme), T)
        // the Recommended chip is move with move-fg text (ADR-0023 section 3)
        const rec = card.getByText('Recommended', { exact: true })
        await expect(rec, 'the Recommended chip is on the card').toBeVisible(T)
        await expect(rec, 'the Recommended chip is tokens.json move').toHaveCSS('background-color', token('move', theme), T)
        await expect(rec, 'the Recommended chip text is tokens.json move-fg').toHaveCSS('color', token('move-fg', theme), T)
        // the checked option is move-fg with move text for its label and description, never D2's bg-white and #475569
        const opt = q.options[0]
        await card.getByText(opt.description, { exact: true }).click()
        await expect(group.getByRole('radio').first(), 'clicking the option checks its radio').toBeChecked(T)
        const desc = card.getByText(opt.description, { exact: true })
        await expect(desc, 'the selected description is tokens.json move').toHaveCSS('color', token('move', theme), T)
        const option = await desc.evaluate((el) => {
          for (let n = el.parentElement; n; n = n.parentElement) {
            const s = getComputedStyle(n)
            if (s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent') return { bg: s.backgroundColor, color: s.color }
          }
          return null
        })
        expect(option?.bg, `the selected option is tokens.json move-fg (${theme})`).toBe(token('move-fg', theme))
        expect(option?.color, `the selected option's label text is tokens.json move (${theme})`).toBe(token('move', theme))
        await expect(page).toHaveTitle('(1) Truss', T)
        const form = page.getByRole('form', { name: 'Message' })
        // views/move/move.test.ts:239-246 and ADR-0028 section 1: the queue note and the answer intent are gone;
        // the box says the PM waits on the card above, and Message stays the checked intent.
        await expect(form.getByRole('textbox', { name: 'Message to the PM' })).toHaveAccessibleDescription('The PM is waiting on the card above; a message here is sent as well.', T)
        await expect(form.getByRole('radiogroup', { name: 'Send as' }).getByRole('radio', { name: 'Answer the question' })).toHaveCount(0, T)
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
        // ADR-0028 section 2 (R-47): the planted reply is an approval ask (approvalAsk true), so "Approval needed"
        const replyCard = move.getByRole('article', { name: 'Approval needed' })
        await expect(replyCard).toBeVisible(LOAD)
        await expect(replyCard, 'the oldest article is the filled move surface').toHaveCSS('background-color', token('move', theme), T)
        await expect(replyCard).toContainText(reply.text, T)
        await expect(replyCard.getByRole('button', { name: /^Approve\b/ })).toBeVisible(T)
        await expect(replyCard.getByText('Sends: Approved.')).toBeVisible(T)
        await expect(replyCard.getByRole('button', { name: /^Deny\b/ })).toBeVisible(T)
        await expect(replyCard.getByText('Sends: Not approved.')).toBeVisible(T)
        await expect(replyCard.getByRole('textbox', { name: 'Your reply' })).toBeVisible(T)
        await expect(replyCard.getByRole('button', { name: 'Send reply' })).toBeVisible(T)
        const permCard = move.getByRole('article', { name: `Permission request: ${perm.toolName}` })
        await expect(permCard).toBeVisible(T)
        await expect(permCard, 'the second card is a surface card, not the move colour').not.toHaveCSS('background-color', token('move', theme), T)
        await expect(permCard).toHaveCSS('background-color', token('surface', theme), T)
        for (const text of [perm.toolName, perm.title, perm.summary, perm.decisionReason, perm.blockedPath]) await expect(permCard).toContainText(text, T)
        await expect(permCard.getByRole('button', { name: /^Approve\b/ })).toBeVisible(T)
        await expect(permCard.getByRole('button', { name: /^Deny\b/ })).toBeVisible(T)
        await expect(move.getByRole('article')).toHaveCount(2, T)
        await expect(move.getByText('1 more waiting on you')).toBeVisible(T)
        await expect(page).toHaveTitle('(2) Truss', T)
        expect(await o.problems()).toEqual([])
      } finally { await o.close(); await s.stop() }
    })
  }

  test('reply, not an approval ask: "The PM replied", a Your reply box and Send reply, and no Approve or Deny on the card (R-47)', async ({ browser }) => {
    const s = await scenario('approval', {
      edit: (f) => {
        for (const r of f.requests) {
          if (r.kind !== 'reply') continue
          r.approvalAsk = false
          r.text = 'Nothing is waiting on approval right now. Tell me what you want next, or give me something new.'
        }
      },
    })
    const o = await openState(browser, s, 'light', DESKTOP)
    try {
      const { page } = o
      const move = page.getByRole('region', { name: 'Your move' })
      const card = move.getByRole('article', { name: 'The PM replied' })
      await expect(card).toBeVisible(LOAD)
      await expect(card.getByRole('heading', { name: 'The PM replied' })).toBeVisible(T)
      await expect(card).toContainText('Nothing is waiting on approval', T)
      await expect(card.getByRole('button', { name: 'Read in thread' })).toBeVisible(T)
      await expect(card.getByRole('button', { name: /^Approve\b/ })).toHaveCount(0, T)
      await expect(card.getByRole('button', { name: /^Deny\b/ })).toHaveCount(0, T)
      const box = card.getByRole('textbox', { name: 'Your reply' })
      await expect(box).toBeVisible(T)
      await box.fill('Add a CSV export')
      const send = card.getByRole('button', { name: 'Send reply' })
      const posted = page.waitForRequest((r) => r.method() === 'POST' && /^\/api\/requests\/[^/]+\/answer$/.test(new URL(r.url()).pathname), LOAD)
      await send.click()
      expect(JSON.parse((await posted).postData() ?? '{}'), 'Send reply posts {decision: message, message}').toMatchObject({ decision: 'message', message: 'Add a CSV export' })
      expect(await o.problems()).toEqual([])
    } finally { await o.close(); await s.stop() }
  })

  test('follow-up: Queued and Sent chips, newest first, no plan-revision status, the send name follows Message / New goal', async ({ browser }) => {
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
      // the intent label is sentence case: no text-transform uppercase (D2's `uppercase tracking-wide` goes)
      await expect(region.getByText('New goal', { exact: true }).first(), 'the New goal label is not uppercased').toHaveCSS('text-transform', 'none', T)
      await expect(region.getByText('Add to current goal', { exact: true }).first(), 'the Add to current goal label is not uppercased').toHaveCSS('text-transform', 'none', T)
      await expect(page.getByText(/In the plan|plan revision/i)).toHaveCount(0, T)
      // newest first: the queued row (msg-4) comes before the long one (msg-2)
      const rows = await region.getByRole('listitem').allInnerTexts()
      const iNew = rows.findIndex((r) => r.includes('Also keep the quota error text short.'))
      const iOld = rows.findIndex((r) => r.includes('Please also make the follow-up list'))
      expect(iNew, 'the queued row is listed').toBeGreaterThanOrEqual(0)
      expect(iNew, 'newest first').toBeLessThan(iOld)
      const group = page.getByRole('form', { name: 'Message' }).getByRole('radiogroup', { name: 'Send as' })
      await expect(group.getByRole('radio', { name: 'Answer the question' })).toHaveCount(0, T)
      await expect(group.getByRole('radio', { name: 'Message', exact: true }), 'Message is checked by default once a goal exists (ADR-0028 section 1)').toBeChecked(T)
      await expect(page.getByRole('form', { name: 'Message' }).getByRole('button', { name: 'Send to PM' })).toBeVisible(T)
      await group.getByRole('radio', { name: 'New goal' }).check()
      await expect(page.getByRole('form', { name: 'Message' }).getByRole('button', { name: 'Add as new goal' })).toBeVisible(T)
      await group.getByRole('radio', { name: 'Message', exact: true }).check()
      await expect(page.getByRole('form', { name: 'Message' }).getByRole('button', { name: 'Send to PM' })).toBeVisible(T)
      expect(await o.problems()).toEqual([])
    } finally { await o.close(); await s.stop() }
  })

  for (const theme of THEMES) {
    // ADR-0028 section 1: both states offer Message (Send to PM) and New goal (Add as new goal); the answer intent is gone
    for (const [state, intents] of [
      ['follow-up', [['New goal', 'Add as new goal'], ['Message', 'Send to PM']]],
      ['question', [['New goal', 'Add as new goal'], ['Message', 'Send to PM']]],
    ] as const) {
      test(`${state} (${theme}): the send button is --primary, move with move-fg text, for every intent`, async ({ browser }) => {
        const s = await scenario(state)
        const o = await openState(browser, s, theme, DESKTOP)
        try {
          const { page } = o
          await expect(page.getByRole('button', { name: 'Dark theme' })).toHaveAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false', LOAD)
          const form = page.getByRole('form', { name: 'Message' })
          const group = form.getByRole('radiogroup', { name: 'Send as' })
          await expect(group.getByRole('radio', { name: 'Message', exact: true }), 'Message is checked by default').toBeChecked(T)
          for (const [intent, name] of intents) {
            await group.getByRole('radio', { name: intent, exact: true }).check()
            await expect(group.getByRole('radio', { name: intent, exact: true })).toBeChecked(T)
            const send = form.getByRole('button', { name, exact: true })
            await expect(send, `${name} is tokens.json move in ${theme}, not D2's brand`).toHaveCSS('background-color', token('move', theme), T)
            await expect(send, `${name} text is tokens.json move-fg in ${theme}`).toHaveCSS('color', token('move-fg', theme), T)
          }
          expect(await o.problems()).toEqual([])
        } finally { await o.close(); await s.stop() }
      })
    }
  }

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
      // and it is one line with an ellipsis: no wrap, cut short, its box at most one line-height high (+1 px rounding)
      await expect(full, 'the row text is cut short with an ellipsis').toHaveCSS('text-overflow', 'ellipsis', T)
      await expect(full, 'the row text never wraps').toHaveCSS('white-space', 'nowrap', T)
      const box = await full.evaluate((el) => {
        const s = getComputedStyle(el)
        const lh = s.lineHeight === 'normal' ? 1.2 * parseFloat(s.fontSize) : parseFloat(s.lineHeight)
        return { height: el.getBoundingClientRect().height, lineHeight: lh, scroll: el.scrollWidth, client: el.clientWidth }
      })
      expect(box.lineHeight, 'the row text has a line-height').toBeGreaterThan(0)
      expect(box.height, `the 300-character row is ${box.height}px high, more than one ${box.lineHeight}px line`).toBeLessThanOrEqual(box.lineHeight + 1)
      expect(box.scroll, `the row text is cut short in view: scrollWidth ${box.scroll} > clientWidth ${box.client}`).toBeGreaterThan(box.client)
      const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
      expect(w[0], 'the long row never widens the phone page').toBeLessThanOrEqual(w[1]!)
    } finally { await o.close(); await s.stop() }
  })

  test('error path: a session error reads error: <first line> and the composer keeps its typed text', async ({ browser }) => {
    const s = await scenario('follow-up')
    const o = await openState(browser, s, 'light', DESKTOP)
    try {
      const { page } = o
      const box = page.getByRole('form', { name: 'Message' }).getByRole('textbox', { name: 'Message to the PM', exact: true })
      await expect(page.getByRole('button', { name: 'Dark theme' })).toBeVisible(LOAD)
      await box.fill('my half-typed detail')
      s.iface.setSession({ status: 'error', error: 'rate limited\nretry in 30s' })
      await expect(page.getByRole('status', { name: 'Session' })).toHaveText('error: rate limited', T)
      await expect(box).toHaveValue('my half-typed detail', T)
    } finally { await o.close(); await s.stop() }
  })
})
