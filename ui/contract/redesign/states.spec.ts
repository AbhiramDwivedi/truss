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
import { STATES, WIDTHS, THEMES, HEIGHT, T, LOAD, scenario, openState, screensDir, token, tokens, type Scenario, type Theme } from './support.ts'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const SEND = /^(Send|Add goal|Send details|Send answer)$/

// The shell every state has (ADR-0018 section 10, first table) plus ADR-0023's Dark theme toggle.
async function shell(page: Page, theme: Theme): Promise<void> {
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
  await expect(move).toBeVisible(T)
  await expect(move.getByRole('heading', { level: 2, name: 'Your move' })).toBeVisible(T)
  const form = page.getByRole('form', { name: 'Message' })
  await expect(form.getByRole('textbox', { name: 'Goal or message' })).toBeVisible(T)
  await expect(form.getByRole('button', { name: SEND })).toBeVisible(T)
  const tabs = page.getByRole('tablist', { name: 'Run' })
  for (const name of ['Crews', 'Decisions and ADRs', 'Design']) await expect(tabs.getByRole('tab', { name })).toBeVisible(T)
  const log = page.getByRole('log', { name: 'Transcript' })
  await expect(log).toBeVisible(T)
  await expect(page.getByRole('heading', { level: 2, name: 'Transcript' })).toBeVisible(T)
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

// What ADR-0023 section 4 gives the state beyond the shell.
async function content(page: Page, state: string, s: Scenario): Promise<void> {
  const move = page.getByRole('region', { name: 'Your move' })
  const crews = page.getByRole('region', { name: 'Crews' })
  const retro = page.getByRole('region', { name: 'Retro stage' })
  const metrics = page.getByRole('region', { name: 'Live metrics' })
  const form = page.getByRole('form', { name: 'Message' })
  const f = s.fixture
  // the per-run value planted in the first user line
  const firstUser = f.transcript.find((e: any) => e.role === 'user')
  if (firstUser) await expect(page.getByRole('log', { name: 'Transcript' })).toContainText(firstUser.text, T)
  if (state === 'empty') {
    await expect(page.getByRole('status', { name: 'Session' })).toHaveText(/\bidle\b/, T)
    await expect(move.getByRole('article')).toHaveCount(0, T)
    await expect(move.getByRole('heading', { level: 3, name: 'Start a run' })).toBeVisible(T)
    await expect(move.getByText('Type a goal. Truss plans it, and asks you here when it needs a call.')).toBeVisible(T)
    await expect(form.getByRole('radiogroup', { name: 'What this message is' })).toHaveCount(0, T)
    await expect(form.getByRole('button', { name: 'Send', exact: true })).toBeVisible(T)
    await expect(metrics).toHaveCount(0, T)
    await expect(page.getByRole('tabpanel').getByRole('region', { name: 'Crews' }).getByText('No plan yet.')).toBeVisible(T)
    await expect(crews.getByRole('button')).toHaveCount(0, T)
    await expect(page.getByText('Nothing built yet. Plans, ADRs and screenshots appear here as crews finish.')).toBeVisible(T)
    await expect(page.getByRole('group', { name: 'Filter by type' })).toHaveCount(0, T)
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
    await expect(form.getByText("Claude's turn is open on your question. Anything you send now waits in the queue and goes out once you answer it.")).toBeVisible(T)
    const answer = form.getByRole('radio', { name: 'Answer the question' })
    await expect(answer).toBeVisible(T)
    await answer.check()
    await expect(answer).toBeChecked(T)
    await expect(form.getByRole('button', { name: 'Send answer' }), 'the send button follows the checked intent').toBeVisible(T)
  } else if (state === 'approval') {
    const [reply, perm] = f.requests
    const replyCard = move.getByRole('article', { name: 'Reply needed' })
    await expect(replyCard).toContainText(reply.text, T)
    await expect(replyCard.getByRole('button', { name: 'Approve' })).toBeVisible(T)
    await expect(replyCard.getByRole('button', { name: 'Deny' })).toBeVisible(T)
    await expect(replyCard.getByRole('textbox', { name: 'Message with your answer' })).toBeVisible(T)
    const permCard = move.getByRole('article', { name: `Permission request: ${perm.toolName}` })
    for (const text of [perm.toolName, perm.title, perm.summary, perm.decisionReason, perm.blockedPath]) await expect(permCard).toContainText(text, T)
    await expect(permCard.getByRole('button', { name: 'Approve' })).toBeVisible(T)
    await expect(permCard.getByRole('button', { name: 'Deny' })).toBeVisible(T)
    await expect(move.getByRole('article')).toHaveCount(2, T)
    await expect(move.getByText('1 more waiting on you')).toBeVisible(T)
    await expect(page).toHaveTitle('(2) Truss', T)
  } else if (state === 'follow-up') {
    const region = page.getByRole('region', { name: 'Follow-ups' })
    await expect(region).toBeVisible(T)
    await expect(region.getByText('Queued', { exact: true })).toHaveCount(f.session.queue.length, T)
    await expect(region.getByText(/^Sent \d\d:\d\d$/).first()).toBeVisible(T)
    await expect(region.getByText('New goal').first()).toBeVisible(T)
    await expect(region.getByText('Add to current goal').first()).toBeVisible(T)
    await expect(page.getByText(/In the plan|plan revision/i)).toHaveCount(0, T)
    const group = form.getByRole('radiogroup', { name: 'What this message is' })
    await expect(group.getByRole('radio', { name: 'New goal' })).toBeVisible(T)
    await expect(group.getByRole('radio', { name: 'Add to current goal' })).toBeVisible(T)
    await expect(group.getByRole('radio', { name: 'Answer the question' })).toHaveCount(0, T)
    await group.getByRole('radio', { name: 'New goal' }).check()
    await expect(form.getByRole('button', { name: 'Add goal' })).toBeVisible(T)
    await group.getByRole('radio', { name: 'Add to current goal' }).check()
    await expect(form.getByRole('button', { name: 'Send details' })).toBeVisible(T)
  } else if (state === 'crews-running') {
    for (const n of [0, 1, 2]) {
      const group = crews.getByRole('group', { name: `Stage ${n}` })
      await expect(group).toBeVisible(T)
      await expect(group.getByRole('heading', { level: 3, name: `Stage ${n}` })).toBeVisible(T)
      await expect(group.getByRole('list').getByRole('listitem').first()).toBeVisible(T)
    }
    for (const c of f.run.crews) {
      const line = crews.getByRole('button', { name: new RegExp(`\\b${c.slug}\\b`) })
      await expect(line).toHaveCount(1, T)
      await expect(line).toHaveAttribute('aria-expanded', /^(true|false)$/, T)
      await expect(line).toHaveAccessibleName(new RegExp(`${c.estAgents} agents planned`), T)
    }
    const line = crews.getByRole('button', { name: new RegExp(`\\b${s.apiSlug}\\b`) })
    await expect(line).toHaveAccessibleName(/running/i, T)
    await expect(line).toHaveAccessibleName(/stage 1/i, T)
    await line.click()
    await expect(line).toHaveAttribute('aria-expanded', 'true', T)
    await expect(page.getByRole('list', { name: `${s.apiSlug} members` }).getByRole('listitem').first()).toBeVisible(T)
  } else if (state === 'stuck-crew') {
    const stuck = f.run.crews.find((c: any) => c.stuck)
    const line = crews.getByRole('button', { name: /stuck: stalled \d+ min/ })
    await expect(line).toHaveCount(1, T)
    await expect(line).toHaveAccessibleName(new RegExp(`stuck: stalled ${stuck.stuck.minutes} min`), T)
    for (const name of ['Restart builder', 'Re-plan crew', 'Ask Claude']) await expect(crews.getByRole('button', { name })).toBeVisible(T)
    const pause = page.getByRole('button', { name: 'Pause build' })
    await expect(pause).toHaveAttribute('aria-disabled', 'true', T)
    await expect(pause).toHaveAccessibleDescription("Pausing needs a server endpoint that doesn't exist yet.", T)
    await expect(metrics.getByRole('link', { name: '1 crew stuck' })).toBeVisible(T)
    await expect(move.getByRole('article')).toHaveCount(0, T)
  } else if (state === 'artifacts') {
    const filter = page.getByRole('group', { name: 'Filter by type' })
    await expect(filter.getByRole('button').first()).toHaveAttribute('aria-pressed', /^(true|false)$/, T)
    const list = page.getByRole('list', { name: 'Deliverables' })
    await expect(list).toBeVisible(T)
    await expect(list.getByRole('listitem').first()).toBeVisible(T)
    await expect(page.getByText(/^Arrives when .+ merges\. Nothing to open yet\.$/).first()).toBeVisible(T)
    await expect(page.getByRole('link', { name: /Arrives when/ })).toHaveCount(0, T)
  } else if (state === 'live-counter') {
    await expect(metrics).toBeVisible(T)
    await expect(metrics.getByRole('term')).toHaveText(['Elapsed', 'Tokens', 'Spend', 'Agents', 'Crews merged', 'Tasks done'], T)
    await expect(metrics.getByRole('definition')).toHaveCount(6, T)
    await expect(metrics.getByText(/since you approved, /)).toBeVisible(T)
    await expect(metrics.getByText(/as of \d\d:\d\d(?!, not updating)/).first()).toBeVisible(T)
    await expect(metrics.getByText(/as of turn end \d\d:\d\d/)).toBeVisible(T)
    await expect(metrics.getByText('needs a server change')).toHaveCount(0, T)
    await expect(metrics.getByText('from events today')).toHaveCount(0, T)
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
    const tab = page.getByRole('tab', { name: 'Decisions and ADRs' })
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true', T)
    await expect(page.getByRole('tabpanel', { name: 'Decisions and ADRs' })).toBeVisible(T)
    const decisions = page.getByRole('region', { name: 'Decisions' })
    await expect(decisions.getByRole('heading', { level: 3 }).first()).toBeVisible(T)
    await expect(decisions.getByRole('list').getByRole('listitem').first()).toBeVisible(T)
    const adrs = page.getByRole('region', { name: 'ADRs' })
    await expect(adrs.getByRole('list').getByRole('listitem')).toHaveCount(f.adrs.length, T)
    await expect(page.getByText(/Approved by you at \d\d:\d\d/).first()).toBeVisible(T)
    await expect(page.getByText(/Plan revision/i)).toHaveCount(0, T)
  }
}

// After change(): the page shows it.
async function shows(page: Page, state: string, s: Scenario): Promise<void> {
  if (state === 'crews-running') {
    await expect(page.getByRole('region', { name: 'Crews' }).getByRole('button', { name: new RegExp(`\\b${s.apiSlug}\\b`) })).toHaveAccessibleName(/merged/i, LOAD)
  } else if (state === 'retro') {
    await expect(page.getByRole('region', { name: 'Retro stage' })).toContainText(`triaging ${s.run}`, LOAD)
  } else if (state === 'decisions') {
    await expect(page.getByRole('region', { name: 'Decisions' }).getByRole('listitem').filter({ hasText: `decision marker ${s.run}` })).toHaveCount(1, LOAD)
  } else {
    await expect(page.getByRole('log', { name: 'Transcript' })).toContainText(`hello ${s.run}`, LOAD)
  }
}

for (const state of STATES) {
  for (const theme of THEMES) {
    test(`axe: ${state} in ${theme} has the D2 roles, tokens and no WCAG 2.2 AA violations`, async ({ browser }) => {
      const s = await scenario(state)
      const { page, problems, close } = await openState(browser, s, theme, WIDTHS[2]![1])
      try {
        await shell(page, theme)
        await content(page, state, s)
        await colours(page, state, theme)
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
        await shell(page, theme)
        await content(page, state, s)
        for (const [name, width] of WIDTHS) {
          await page.setViewportSize({ width, height: HEIGHT })
          await shell(page, theme)
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

  test(`live: ${state} shows a changed file after load`, async ({ browser }) => {
    const s = await scenario(state)
    const { page, problems, close } = await openState(browser, s, 'light', WIDTHS[2]![1])
    try {
      await shell(page, 'light')
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
