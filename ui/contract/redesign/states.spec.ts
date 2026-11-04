// The redesigned client, pinned by role and accessible name: ADR-0018 section 10 (the shell and the per-state
// roles) as ADR-0023 section 4 re-pins it to D2's ten states. Each test plants a fixture from
// fixtures/run/<state>/ into the fake interface (ui/e2e/harness.ts, port 0), opens the page in a context of its
// own (colour scheme and width), and fails on any console error, page error or securitypolicyviolation.
// Written before the client exists: every test fails against the old client at a D2-only assertion (the
// Dark theme toggle, a D2 name, a token colour).
import { test, expect, type Locator, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { STATES, WIDTHS, THEMES, HEIGHT, T, LOAD, scenario, openState, boxName, screensDir, token, tokens, typeCounts, type Scenario, type Theme } from './support.ts'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
// ADR-0028 section 1: Start run (no plan), Send to PM, Add as new goal (New goal chosen); Send answer stays for a question.
const SEND = /^(Start run|Send to PM|Add as new goal|Send answer)$/

// The shell every state has (ADR-0018 section 10, first table) plus ADR-0023's Dark theme toggle.
async function shell(page: Page, theme: Theme, state: string): Promise<void> {
  await expect(page.getByRole('link', { name: 'Skip to Your move' })).toBeAttached(T)
  await expect(page.getByRole('banner')).toBeVisible(T)
  await expect(page.getByRole('banner').getByRole('heading', { level: 1, name: 'Truss' })).toBeVisible(T)
  await expect(page.getByRole('status', { name: 'Session' })).toBeVisible(T)
  await expect(page.getByRole('button', { name: 'Turn on notifications' })).toBeVisible(T)
  const toggle = page.getByRole('banner').getByRole('button', { name: 'Dark theme' })
  await expect(toggle).toBeVisible(T)
  await expect(toggle, 'the page starts in the OS theme').toHaveAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false', T)
  await expect(page.getByRole('main')).toBeVisible(T)
  const move = page.getByRole('region', { name: 'Your move' })
  if (state === 'question' || state === 'approval') {
    await expect(move).toBeVisible(T)
    await expect(move.getByRole('heading', { level: 2, name: 'Your move' })).toBeVisible(T)
  } else {
    // ADR-0028 section 10 / UX: Your move renders only when the session waits on the client; no hero otherwise
    await expect(move, 'no Your move section with nothing pending').toHaveCount(0, T)
    await expect(page.getByText('Nothing needs you right now')).toHaveCount(0, T)
  }
  const form = page.getByRole('form', { name: 'Message' })
  await expect(form.getByRole('textbox', { name: boxName(state), exact: true })).toBeVisible(T)
  await expect(form.getByRole('button', { name: SEND })).toBeVisible(T)
  // ADR-0028 section 10: no Crews, Decisions or Design tabs; the network is the first view in main (R-36)
  await expect(page.getByRole('tablist', { name: 'Run' })).toHaveCount(0, T)
  await expect(page.getByRole('tab')).toHaveCount(0, T)
  await expect(page.getByRole('main').getByRole('region', { name: 'Build network' })).toBeVisible(T)
  await expect(page.getByRole('region', { name: 'Decisions and ADRs' }), 'the rail timeline is the one list of decisions and ADRs').toBeVisible(T)
  await expect(page.getByRole('main').getByRole('heading', { level: 2, name: 'Run metrics' })).toBeVisible(T)
  const log = page.getByRole('log', { name: 'Conversation with the PM', exact: true })
  await expect(log).toBeVisible(T)
  await expect(page.getByRole('heading', { level: 2, name: 'Conversation' })).toBeVisible(T)
}

// What a rendered token looks like: bg on body, and the move surface (the card when Your move has one, else the
// one primary button, the composer's send).
async function colours(page: Page, state: string, theme: Theme): Promise<void> {
  expect(tokens.colors.move, 'tokens.json holds move').toBeTruthy()
  await expect(page.locator('body')).toHaveCSS('background-color', token('bg', theme), T)
  const move = page.getByRole('region', { name: 'Your move' })
  const surface: Locator = state === 'question' || state === 'approval' ? move.getByRole('article').first() : page.getByRole('form', { name: 'Message' }).getByRole('button', { name: SEND })
  await expect(surface).toHaveCSS('background-color', token('move', theme), T)
}

// The contrast pairs ADR-0023 section 4 rules, as the app's own styles render them (checklist item 25): a
// Live metrics term is muted text on a sunken tile (never subtle), and an ok status chip's text is fg (ok is
// for dots, bars and icons only). The tile is the term's nearest ancestor that paints a background.
async function pairs(page: Page, state: string, theme: Theme): Promise<void> {
  if (state === 'live-counter') {
    const term = page.getByRole('region', { name: 'Run metrics' }).getByRole('term').first()
    await expect(term, 'a Run metrics term is muted text').toHaveCSS('color', token('muted', theme), T)
    expect(token('muted', theme)).not.toBe(token('subtle', theme))
    const tile = await term.evaluate((el) => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        const bg = getComputedStyle(n).backgroundColor
        if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg
      }
      return null
    })
    expect(tile, `the Run metrics tile behind a term is tokens.json sunken (${theme})`).toBe(token('sunken', theme))
  } else if (state === 'crews-running') {
    const chip = page.getByRole('region', { name: 'Build network' }).getByText('Done', { exact: true }).first()
    await expect(chip, 'the merged crew carries an ok StatusBadge that reads Done (ADR-0028 section 9)').toBeVisible(T)
    await expect(chip, 'ok status chip text is fg').toHaveCSS('color', token('fg', theme), T)
    expect(await chip.evaluate((el) => getComputedStyle(el).color), 'ok is never a text colour').not.toBe(token('ok', theme))
  }
}

// What ADR-0023 section 4 gives the state beyond the shell.
async function content(page: Page, state: string, s: Scenario): Promise<void> {
  const move = page.getByRole('region', { name: 'Your move' })
  const crews = page.getByRole('region', { name: 'Build network' })
  const retro = page.getByRole('region', { name: 'Retro stage' })
  const metrics = page.getByRole('region', { name: 'Run metrics' })
  const form = page.getByRole('form', { name: 'Message' })
  const f = s.fixture
  // the per-run value planted in the first user line
  const firstUser = f.transcript.find((e: any) => e.role === 'user')
  if (firstUser) await expect(page.getByRole('log', { name: 'Conversation with the PM', exact: true })).toContainText(firstUser.text, T)
  if (state === 'empty') {
    await expect(page.getByRole('status', { name: 'Session' })).toHaveText(/\bidle\b/, T)
    await expect(move.getByRole('article')).toHaveCount(0, T)
    await expect(form.getByRole('radiogroup', { name: 'Send as' })).toHaveCount(0, T)
    await expect(form.getByRole('button', { name: 'Start run', exact: true })).toBeVisible(T)
    // ADR-0028 section 8: Run metrics is always the last section of main; with no usage every tile reads "No usage yet"
    await expect(metrics).toBeVisible(T)
    await expect(metrics.getByText('No usage yet').first()).toBeVisible(T)
    // ADR-0028 section 10: the PM node and the dashed card replace the old empty-plan line
    await expect(crews.getByText('Waiting for your goal')).toBeVisible(T)
    await expect(crews.getByText('Crews appear here once the PM has a plan.')).toBeVisible(T)
    await expect(page.getByText(/No plan\s+yet/)).toHaveCount(0, T)
    await expect(crews.getByRole('article')).toHaveCount(0, T)
    await expect(page.getByText('Nothing built yet. Deliverables appear as crews finish.')).toBeVisible(T)
    await expect(page.getByRole('group', { name: 'Filter by type' })).toHaveCount(0, T)
    await expect(page.getByRole('region', { name: 'Follow-ups' }), 'ADR-0028: no Follow-ups region before a plan exists').toHaveCount(0, T)
    await expect(retro).toHaveCount(0, T)
  } else if (state === 'question') {
    const q = f.requests[0].questions[0]
    const card = move.getByRole('article', { name: `Question from Claude: ${q.header}` })
    await expect(card).toBeVisible(T)
    const group = card.getByRole('radiogroup', { name: q.question })
    await expect(group.getByRole('radio')).toHaveCount(q.options.length, T)
    await expect(group.getByRole('radio').first()).toHaveAccessibleName(/\(Recommended\)$/, T)
    await expect(card.getByRole('textbox', { name: 'Your own answer' })).toBeVisible(T)
    await expect(card.getByRole('button', { name: 'Submit answers' })).toBeVisible(T)
    await expect(page).toHaveTitle('(1) Truss', T)
    await expect(form.getByRole('textbox', { name: 'Message to the PM' })).toHaveAccessibleDescription('The PM is waiting on the card above; a message here is sent as well.', T)
    const sendAs = form.getByRole('radiogroup', { name: 'Send as' })
    await expect(sendAs.getByRole('radio', { name: 'Answer the question' }), 'ADR-0028: the answer intent is gone').toHaveCount(0, T)
    await expect(sendAs.getByRole('radio', { name: 'Message', exact: true }), 'Message stays checked while a question is open: answering belongs to Your move').toBeChecked(T)
    await sendAs.getByRole('radio', { name: 'New goal' }).check()
    await expect(form.getByRole('button', { name: 'Add as new goal' }), 'the send button follows the checked intent').toBeVisible(T)
  } else if (state === 'approval') {
    const [reply, perm] = f.requests
    // ADR-0028 section 2 (R-47): the planted reply is an approval ask, so the card is "Approval needed"
    const replyCard = move.getByRole('article', { name: 'Approval needed' })
    await expect(replyCard).toContainText(reply.text, T)
    await expect(replyCard.getByRole('button', { name: /^Approve\b/ })).toBeVisible(T)
    await expect(replyCard.getByText('Sends: Approved.')).toBeVisible(T)
    await expect(replyCard.getByRole('button', { name: /^Deny\b/ })).toBeVisible(T)
    await expect(replyCard.getByText('Sends: Not approved.')).toBeVisible(T)
    await expect(replyCard.getByRole('textbox', { name: 'Your reply' })).toBeVisible(T)
    await expect(replyCard.getByRole('button', { name: 'Send reply' })).toBeVisible(T)
    const permCard = move.getByRole('article', { name: `Permission request: ${perm.toolName}` })
    for (const text of [perm.toolName, perm.title, perm.summary, perm.decisionReason, perm.blockedPath]) await expect(permCard).toContainText(text, T)
    await expect(permCard.getByRole('button', { name: /^Approve\b/ })).toBeVisible(T)
    await expect(permCard.getByRole('button', { name: /^Deny\b/ })).toBeVisible(T)
    await expect(move.getByRole('article')).toHaveCount(2, T)
    await expect(move.getByText('1 more waiting on you')).toBeVisible(T)
    await expect(page).toHaveTitle('(2) Truss', T)
  } else if (state === 'follow-up') {
    const region = page.getByRole('region', { name: 'Follow-ups' })
    await expect(region).toBeVisible(T)
    await expect(region.getByText('Queued', { exact: true })).toHaveCount(f.session.queue.length, T)
    await expect(region.getByText(/^Sent \d\d:\d\d$/).first()).toBeVisible(T)
    await expect(region.getByText('New goal').first()).toBeVisible(T)
    await expect(page.getByText(/In the plan|plan revision/i)).toHaveCount(0, T)
    const group = form.getByRole('radiogroup', { name: 'Send as' })
    await expect(group.getByRole('radio', { name: 'New goal' })).toBeVisible(T)
    await expect(group.getByRole('radio', { name: 'Message', exact: true })).toBeVisible(T)
    await expect(group.getByRole('radio', { name: 'Answer the question' })).toHaveCount(0, T)
    await expect(group.getByRole('radio', { name: 'Message', exact: true }), 'Message is checked by default once a goal exists').toBeChecked(T)
    await expect(form.getByRole('button', { name: 'Send to PM' }), 'the default intent names the send button').toBeVisible(T)
    await group.getByRole('radio', { name: 'New goal' }).check()
    await expect(form.getByRole('button', { name: 'Add as new goal' })).toBeVisible(T)
    await group.getByRole('radio', { name: 'Message', exact: true }).check()
    await expect(form.getByRole('button', { name: 'Send to PM' })).toBeVisible(T)
  } else if (state === 'crews-running') {
    // ADR-0028 section 10: crews sit in stage rows (a list per stage), each crew an article named by its slug,
    // with a wire per crew (data-crew)
    await expect(crews.getByRole('list').first()).toBeVisible(T)
    for (const c of f.run.crews) {
      await expect(crews.getByRole('article', { name: new RegExp(`\\b${c.slug}\\b`) })).toHaveCount(1, T)
    }
    await expect(crews.locator('[data-crew]'), 'one wire per crew card').toHaveCount(f.run.crews.length, T)
    const card = crews.getByRole('article', { name: new RegExp(`\\b${s.apiSlug}\\b`) })
    await expect(card.getByText('Active', { exact: true }).first()).toBeVisible(T)
  } else if (state === 'stuck-crew') {
    const stuck = f.run.crews.find((c: any) => c.stuck)
    const line = crews.getByRole('article', { name: new RegExp(`\\b${stuck.slug}\\b`) })
    await expect(line).toHaveCount(1, T)
    await expect(line.getByText('Stuck', { exact: true }).first(), 'ADR-0028 section 9: the Stuck StatusBadge word').toBeVisible(T)
    for (const name of ['Restart builder', 'Re-plan crew', 'Ask Claude']) await expect(crews.getByRole('button', { name })).toBeVisible(T)
    for (const label of ['Why', 'How long', 'Next']) await expect(crews.getByText(label, { exact: true }).first(), `the StuckCard names ${label}`).toBeVisible(T)
    await expect(crews.getByRole('img', { name: 'Alert' }), 'the stuck band carries an alert icon by role, so stuck is not colour alone').toHaveCount(1, T)
    await expect(crews.getByRole('img', { name: 'Alert' })).toBeVisible(T)
    const pause = page.getByRole('button', { name: 'Pause build' })
    await expect(pause).toHaveAttribute('aria-disabled', 'true', T)
    await expect(pause).toHaveAccessibleDescription("Pausing needs a server endpoint that doesn't exist yet.", T)
    await expect(page.getByRole('tooltip'), 'the Pause tip is a description, not a tooltip').toHaveCount(0, T)
    await expect(move.getByRole('article')).toHaveCount(0, T)
  } else if (state === 'artifacts') {
    const filter = page.getByRole('group', { name: 'Filter by type' })
    await expect(filter.getByRole('button').first()).toHaveAttribute('aria-pressed', /^(true|false)$/, T)
    for (const [name, n] of Object.entries(typeCounts(f))) {
      const chip = filter.getByRole('button', { name: new RegExp(`^${name}\\b`) })
      await expect(chip).toHaveCount(1, T)
      await expect(chip, `the ${name} chip counts ${n}`).toHaveAccessibleName(new RegExp(`^${name}\\b.*\\b${n}\\b`), T)
      await expect(chip).toHaveAttribute('aria-pressed', /^(true|false)$/, T)
    }
    const list = page.getByRole('list', { name: 'Deliverables' })
    await expect(list).toBeVisible(T)
    await expect(list.getByRole('listitem').first()).toBeVisible(T)
    await expect(page.getByText(/^Arrives when .+ merges\. Nothing to open yet\.$/).first()).toBeVisible(T)
    await expect(page.getByRole('link', { name: /Arrives when/ })).toHaveCount(0, T)
  } else if (state === 'live-counter') {
    await expect(metrics).toBeVisible(T)
    // ADR-0028 section 8 (R-43): cost, tokens per model (a table), run time, agents started and crews done "n of m"
    await expect(metrics.getByRole('heading', { level: 2, name: 'Run metrics' })).toBeVisible(T)
    await expect(metrics.getByRole('term').filter({ hasText: /cost/i })).toHaveCount(1, T)
    await expect(metrics.getByRole('term').filter({ hasText: /run time/i })).toHaveCount(1, T)
    await expect(metrics.getByRole('term').filter({ hasText: /agents started/i })).toHaveCount(1, T)
    await expect(metrics.getByRole('term').filter({ hasText: /crews done/i })).toHaveCount(1, T)
    await expect(metrics.getByText(/\d+ of \d+/).first(), 'crews done reads n of m').toBeVisible(T)
    const table = metrics.getByRole('table')
    for (const name of ['Model', 'In', 'Out', 'Cache read', 'Cache write']) await expect(table.getByRole('columnheader', { name })).toBeVisible(T)
    await expect(metrics.getByText(/limit|budget|ceiling|of \$/i), 'no limit, budget, ceiling or "of $X" anywhere').toHaveCount(0, T)
  } else if (state === 'retro') {
    await expect(crews).toBeVisible(T)
    await expect(retro).toBeVisible(T)
    const after = await crews.evaluate((a, b) => !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING), await retro.elementHandle())
    expect(after, 'the Retro stage region comes after the Crews region').toBe(true)
    await expect(retro.getByRole('list').getByRole('listitem')).toHaveCount(5, T)
    for (const [label, status] of [['Extract', 'done'], ['Judges', 'running'], ['Triage', 'pending'], ['Fix goal', 'pending'], ['Fixes applied', 'pending']]) {
      await expect(retro.getByRole('listitem', { name: new RegExp(`^${label}: ${status}`) })).toBeVisible(T)
    }
    await expect(retro).toContainText(f.retro.steps.judges.detail, T)
  } else if (state === 'decisions') {
    // ADR-0028 section 3 (R-37): the rail timeline lists decisions and ADRs; there is no tab to open
    await expect(page.getByRole('tab', { name: 'Decisions and ADRs' })).toHaveCount(0, T)
    const timeline = page.getByRole('region', { name: 'Decisions and ADRs' })
    await expect(timeline.getByRole('list').getByRole('listitem').first()).toBeVisible(T)
    for (const a of f.adrs) await expect(timeline.getByText(a.title).first()).toBeVisible(T)
    await expect(page.getByRole('list', { name: 'Deliverables' }).getByText(f.adrs[0].title), 'Deliverables hold no ADR item').toHaveCount(0, T)
    await expect(page.getByText(/Approved by you at \d\d:\d\d/).first()).toBeVisible(T)
    await expect(page.getByText(/Plan revision/i)).toHaveCount(0, T)
  }
}

// After change(): the page shows it.
async function shows(page: Page, state: string, s: Scenario): Promise<void> {
  if (state === 'crews-running') {
    await expect(page.getByRole('region', { name: 'Build network' }).getByRole('article', { name: new RegExp(`\\b${s.apiSlug}\\b`) }).getByText('Done', { exact: true }).first()).toBeVisible(LOAD)
  } else if (state === 'retro') {
    await expect(page.getByRole('region', { name: 'Retro stage' })).toContainText(`triaging ${s.run}`, LOAD)
  } else if (state === 'decisions') {
    await expect(page.getByRole('region', { name: 'Decisions and ADRs' }).getByRole('listitem').filter({ hasText: `decision marker ${s.run}` })).toHaveCount(1, LOAD)
  } else {
    await expect(page.getByRole('log', { name: 'Conversation with the PM', exact: true })).toContainText(`hello ${s.run}`, LOAD)
  }
}

for (const state of STATES) {
  for (const theme of THEMES) {
    test(`axe: ${state} in ${theme} has the D2 roles, tokens and no WCAG 2.2 AA violations`, async ({ browser }) => {
      const s = await scenario(state)
      const { page, problems, close } = await openState(browser, s, theme, WIDTHS[2]![1])
      try {
        await shell(page, theme, state)
        await content(page, state, s)
        await colours(page, state, theme)
        await pairs(page, state, theme)
        const res = await new AxeBuilder({ page }).withTags(TAGS).analyze()
        const lines = res.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).slice(0, 5).join('\n    ')}`)
        expect(res.violations, `axe violations in ${state}, ${theme}:\n${lines.join('\n')}`).toEqual([])
        expect(await problems(), 'console errors, page errors and CSP violations').toEqual([])
      } finally {
        await close()
        await s.stop()
      }
    })

    test(`layout: ${state} in ${theme} fits phone, tablet and desktop widths and is photographed`, async ({ browser }) => {
      const s = await scenario(state)
      const { page, problems, close } = await openState(browser, s, theme, WIDTHS[2]![1])
      try {
        mkdirSync(screensDir, { recursive: true })
        await shell(page, theme, state)
        await content(page, state, s)
        for (const [name, width] of WIDTHS) {
          await page.setViewportSize({ width, height: HEIGHT })
          await shell(page, theme, state)
          await colours(page, state, theme)
          const fit = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
          expect(fit.scroll, `${state} ${name} ${theme}: scrollWidth ${fit.scroll} > clientWidth ${fit.client}`).toBeLessThanOrEqual(fit.client)
          // axe at every width (ADR-0023 checklist 23): the stacked order below 1024 px and the sheet get a run too.
          const res = await new AxeBuilder({ page }).withTags(TAGS).analyze()
          const lines = res.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).slice(0, 5).join('\n    ')}`)
          expect(res.violations, `axe violations in ${state}, ${name} ${width} px, ${theme}:\n${lines.join('\n')}`).toEqual([])
          await page.screenshot({ path: join(screensDir, `${state}-${name}-${theme}.png`), fullPage: true })
        }
        expect(await problems(), 'console errors, page errors and CSP violations').toEqual([])
      } finally {
        await close()
        await s.stop()
      }
    })
  }

  if (state === 'question' || state === 'stuck-crew') {
    // 200% zoom on a phone, emulated as a viewport twice the phone width (ADR-0023 section 5).
    const ZOOM = 2 * WIDTHS[0]![1]
    test(`zoom: ${state} at ${ZOOM} px (200% of the phone width) shows its card with no horizontal scroll`, async ({ browser }) => {
      expect(ZOOM, 'the zoom viewport is 720 px').toBe(720)
      const s = await scenario(state)
      const { page, problems, close } = await openState(browser, s, 'light', ZOOM)
      try {
        await shell(page, 'light', state)
        await content(page, state, s)
        await colours(page, state, 'light')
        if (state === 'question') {
          await expect(page.getByRole('region', { name: 'Your move' }).getByRole('article', { name: /^Question from Claude: / })).toBeInViewport(T)
        } else {
          await expect(page.getByRole('region', { name: 'Build network' }).getByRole('button', { name: 'Restart builder' })).toBeVisible(T)
        }
        const fit = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
        expect(fit.scroll, `${state} at ${ZOOM} px: scrollWidth ${fit.scroll} > clientWidth ${fit.client}`).toBeLessThanOrEqual(fit.client)
        expect(await problems(), 'console errors, page errors and CSP violations').toEqual([])
      } finally {
        await close()
        await s.stop()
      }
    })
  }

  test(`live: ${state} shows a changed file after load`, async ({ browser }) => {
    const s = await scenario(state)
    const { page, problems, close } = await openState(browser, s, 'light', WIDTHS[2]![1])
    try {
      await shell(page, 'light', state)
      await content(page, state, s)
      s.change()
      await shows(page, state, s)
      expect(await problems(), 'console errors, page errors and CSP violations').toEqual([])
    } finally {
      await close()
      await s.stop()
    }
  })
}
