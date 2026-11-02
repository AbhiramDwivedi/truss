// The redesigned client, pinned by role and accessible name (ADR-0018 sections 10 and 11).
// Each test starts the real server (ui/e2e/harness.ts, port 0) on its own mkdtemp copy of fixtures/run,
// opens the page in a context of its own (colour scheme and width), and fails on any console error,
// page error or securitypolicyviolation. Written before the client exists: every test fails against the
// old client at a role assertion.
import { test, expect, type Browser, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { STATES, THEMES, WIDTHS, T, LOAD, scenario, screensDir, watch, type Scenario } from './support.ts'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const HEIGHT = 900

const SCHEMES = ['light', 'dark'] as const
type Theme = (typeof THEMES)[number]

async function open(browser: Browser, s: Scenario, theme: Theme, width: number) {
  const context = await browser.newContext({ colorScheme: theme, viewport: { width, height: HEIGHT }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const problems = await watch(page)
  await page.goto(s.url)
  return { page, problems, close: () => context.close() }
}

// The shell every state has (section 10, first table).
async function shell(page: Page): Promise<void> {
  await expect(page.getByRole('link', { name: 'Skip to Your move' })).toBeAttached(T)
  await expect(page.getByRole('banner')).toBeVisible(T)
  await expect(page.getByRole('banner').getByRole('heading', { level: 1, name: 'Truss' })).toBeVisible(T)
  await expect(page.getByRole('status', { name: 'Session' })).toBeVisible(T)
  await expect(page.getByRole('button', { name: 'Turn on notifications' })).toBeVisible(T)
  await expect(page.getByRole('main')).toBeVisible(T)
  const move = page.getByRole('region', { name: 'Your move' })
  await expect(move).toBeVisible(T)
  await expect(move.getByRole('heading', { level: 2, name: 'Your move' })).toBeVisible(T)
  const form = page.getByRole('form', { name: 'Message' })
  await expect(form.getByRole('textbox', { name: 'Goal or message' })).toBeVisible(T)
  await expect(form.getByRole('button', { name: 'Send' })).toBeVisible(T)
  const tabs = page.getByRole('tablist', { name: 'Run' })
  for (const name of ['Crews', 'Decisions and ADRs', 'Design']) await expect(tabs.getByRole('tab', { name })).toBeVisible(T)
  const log = page.getByRole('log', { name: 'Transcript' })
  await expect(log).toBeVisible(T)
  await expect(page.getByRole('heading', { level: 2, name: 'Transcript' })).toBeVisible(T)
}

// What section 10 gives the state beyond the shell. Returns the text the page shows after change().
async function content(page: Page, state: string, s: Scenario): Promise<void> {
  const move = page.getByRole('region', { name: 'Your move' })
  const crews = page.getByRole('region', { name: 'Crews' })
  const retro = page.getByRole('region', { name: 'Retro stage' })
  if (state === 'empty') {
    await expect(page.getByRole('status', { name: 'Session' })).toHaveText(/\bidle\b/, T)
    await expect(move.getByRole('article')).toHaveCount(0, T)
    await expect(move.getByRole('heading', { level: 3, name: 'Start a run' })).toBeVisible(T)
    await expect(move.getByText('Type a goal. Truss plans it, and asks you here when it needs a call.')).toBeVisible(T)
    const notes = page.getByRole('list', { name: 'Run status' }).getByRole('listitem')
    await expect(notes.filter({ hasText: s.run })).toHaveCount(1, T)
    await expect(notes.first()).toHaveText(/^\s*Status:/, T)
    await expect(page.getByRole('tabpanel').getByRole('region', { name: 'Crews' }).getByText('No plan yet.')).toBeVisible(T)
    await expect(crews.getByRole('button')).toHaveCount(0, T)
    await expect(retro).toHaveCount(0, T)
  } else if (state === 'pending-question') {
    const card = move.getByRole('article', { name: `Question from Claude: Store ${s.run}` })
    await expect(card).toBeVisible(T)
    const group = card.getByRole('radiogroup', { name: `Which store should hold the quotas ${s.run}?` })
    await expect(group.getByRole('radio')).toHaveCount(2, T)
    await expect(group.getByRole('radio').first()).toHaveAccessibleName(/\(Recommended\)$/, T)
    await expect(card.getByRole('textbox', { name: 'Your own answer' })).toBeVisible(T)
    await expect(card.getByRole('button', { name: 'Submit answers' })).toBeVisible(T)
    await expect(page).toHaveTitle('(1) Truss', T)
  } else if (state === 'pending-approval') {
    const reply = move.getByRole('article', { name: 'Reply needed' })
    await expect(reply).toContainText(`The plan is ready ${s.run}`, T)
    await expect(reply.getByRole('button', { name: 'Approve' })).toBeVisible(T)
    await expect(reply.getByRole('button', { name: 'Deny' })).toBeVisible(T)
    await expect(reply.getByRole('textbox', { name: 'Message with your answer' })).toBeVisible(T)
    const perm = move.getByRole('article', { name: 'Permission request: Bash' })
    await expect(perm).toContainText(`Run the checks ${s.run}`, T)
    await expect(perm).toContainText('npm --prefix ui test', T)
    await expect(perm.getByRole('button', { name: 'Approve' })).toBeVisible(T)
    await expect(perm.getByRole('button', { name: 'Deny' })).toBeVisible(T)
    await expect(page).toHaveTitle('(2) Truss', T)
  } else if (state === 'crews-running' || state === 'blocked-crew') {
    for (const n of [0, 1, 2]) {
      const group = crews.getByRole('group', { name: `Stage ${n}` })
      await expect(group).toBeVisible(T)
      await expect(group.getByRole('heading', { level: 3, name: `Stage ${n}` })).toBeVisible(T)
      await expect(group.getByRole('list').getByRole('listitem').first()).toBeVisible(T)
    }
    for (const slug of ['ui-design', 'ui-state', 'ui-session', 'ui-server', s.copy.webSlug]) {
      const line = crews.getByRole('button', { name: new RegExp(`\\b${slug}\\b`) })
      await expect(line).toHaveCount(1, T)
      await expect(line).toHaveAttribute('aria-expanded', /^(true|false)$/, T)
      await expect(line).toHaveAccessibleName(/QC (PASS|FAIL|none)/, T)
    }
    if (state === 'crews-running') {
      const line = crews.getByRole('button', { name: /\bui-session\b/ })
      await expect(line).toHaveAccessibleName(/running/i, T)
      await expect(line).toHaveAccessibleName(/stage 1/i, T)
      await line.click()
      await expect(line).toHaveAttribute('aria-expanded', 'true', T)
      await expect(page.getByRole('list', { name: 'ui-session members' }).getByRole('listitem').first()).toBeVisible(T)
      await expect(crews.getByRole('button', { name: new RegExp(`\\b${s.copy.webSlug}\\b`) })).toHaveAccessibleName(/planned/i, T)
    } else {
      const line = crews.getByRole('button', { name: /\bui-server\b/ })
      await expect(line).toHaveAccessibleName(/blocked/i, T)
      await expect(line).toHaveAccessibleName(/QC FAIL/, T)
      await expect(move.getByRole('article')).toHaveCount(0, T)
    }
  } else if (state === 'retro') {
    await expect(crews).toBeVisible(T)
    await expect(retro).toBeVisible(T)
    const after = await crews.evaluate((a, b) => !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING), await retro.elementHandle())
    expect(after, 'the Retro stage region comes after the Crews region').toBe(true)
    const steps = retro.getByRole('list').getByRole('listitem')
    await expect(steps).toHaveCount(5, T)
    for (const [label, status] of [['Extract', 'done'], ['Judges', 'running'], ['Triage', 'pending'], ['Fix goal', 'pending'], ['Fixes applied', 'pending']]) {
      await expect(retro.getByRole('listitem', { name: new RegExp(`^${label}: ${status}`) })).toBeVisible(T)
    }
    await expect(retro).toContainText(`judging ${s.run}`, T)
  } else if (state === 'decisions') {
    const tab = page.getByRole('tab', { name: 'Decisions and ADRs' })
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true', T)
    await expect(page.getByRole('tabpanel', { name: 'Decisions and ADRs' })).toBeVisible(T)
    const decisions = page.getByRole('region', { name: 'Decisions' })
    await expect(decisions.getByRole('heading', { level: 3 })).toHaveCount(2, T)
    await expect(decisions.getByRole('list').getByRole('listitem').first()).toBeVisible(T)
    const adrs = page.getByRole('region', { name: 'ADRs' })
    await expect(adrs.getByRole('list').getByRole('listitem').first()).toContainText(/\S/, T)
  }
}

// After change(): the page shows it.
async function shows(page: Page, state: string, s: Scenario): Promise<void> {
  if (state === 'crews-running') {
    await expect(page.getByRole('region', { name: 'Crews' }).getByRole('button', { name: new RegExp(`\\b${s.copy.webSlug}\\b`) })).toHaveAccessibleName(/merged/i, LOAD)
  } else if (state === 'blocked-crew') {
    await expect(page.getByRole('region', { name: 'Crews' }).getByRole('button', { name: /\bui-session\b/ })).toHaveAccessibleName(/blocked/i, LOAD)
  } else if (state === 'retro') {
    await expect(page.getByRole('region', { name: 'Retro stage' })).toContainText(`triaging ${s.run}`, LOAD)
  } else if (state === 'decisions') {
    await expect(page.getByRole('region', { name: 'Decisions' }).getByRole('listitem').filter({ hasText: `decision marker ${s.run}` })).toHaveCount(1, LOAD)
  } else {
    await expect(page.getByRole('log', { name: 'Transcript' })).toContainText(`hello ${s.run}`, LOAD)
  }
}

for (const state of STATES) {
  for (const theme of SCHEMES) {
    test(`axe: ${state} in ${theme} has the ADR-0018 roles and no WCAG 2.2 AA violations`, async ({ browser }) => {
      const s = await scenario(state)
      const { page, problems, close } = await open(browser, s, theme, WIDTHS[2]![1])
      try {
        await shell(page)
        await content(page, state, s)
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
      const { page, problems, close } = await open(browser, s, theme, WIDTHS[2]![1])
      try {
        mkdirSync(screensDir, { recursive: true })
        await shell(page)
        await content(page, state, s)
        for (const [name, width] of WIDTHS) {
          await page.setViewportSize({ width, height: HEIGHT })
          await shell(page)
          const fit = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
          expect(fit.scroll, `${state} ${name} ${theme}: scrollWidth ${fit.scroll} > clientWidth ${fit.client}`).toBeLessThanOrEqual(fit.client)
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
    const { page, problems, close } = await open(browser, s, 'light', WIDTHS[2]![1])
    try {
      await shell(page)
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
