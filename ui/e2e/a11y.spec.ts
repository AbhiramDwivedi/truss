// Accessibility of every page state the e2e specs reach (architecture frontend rule 12; R-18).
// Each test reaches one state by role and accessible name (ADR-0018 section 10), waits for a per-run value
// to show, then runs axe with the WCAG 2.2 AA tags in the light and the dark theme and requires zero
// violations in both. Servers bind port 0 (harness). Written before ui/web is rebuilt: every test fails
// on the old client, which lacks the ADR-0018 roles and names.
import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { WITHIN, card, crewLine, rand, rx, runStatus, sessionStatus, spawnEvent, startInterface, startReal, type Iface, type Real } from './harness.ts'

const LOAD = { timeout: 10000 }
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const SCHEMES = ['light', 'dark'] as const

let real: Real | undefined
let iface: Iface | undefined
test.afterEach(async () => {
  await real?.stop()
  await iface?.stop()
  real = undefined
  iface = undefined
})

// Zero axe violations in the state the page is in now, once per colour scheme.
async function expectNoViolations(page: Page, state: string): Promise<void> {
  for (const colorScheme of SCHEMES) {
    await page.emulateMedia({ colorScheme })
    const res = await new AxeBuilder({ page }).withTags(TAGS).analyze()
    const lines = res.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).slice(0, 5).join('\n    ')}`)
    expect(res.violations, `axe violations in state "${state}" (${colorScheme}):\n${lines.join('\n')}`).toEqual([])
  }
}

const crewsRegion = (page: Page) => page.getByRole('region', { name: 'Crews', exact: true })
const members = (page: Page, slug: string) => page.getByRole('list', { name: `${slug} members`, exact: true })
const openTab = async (page: Page, name: string) => {
  const tab = page.getByRole('tab', { name, exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

test('a11y: empty run, with the no-Truss-dir notice', async ({ page }) => {
  const run = rand()
  const text = `No Truss directory yet ${run}`
  iface = await startInterface({ state: { notices: [{ id: 'no-truss-dir', text }] } })
  await page.goto(iface.url)
  await expect(runStatus(page).getByRole('listitem').filter({ hasText: rx(text) })).toContainText('Status:', LOAD)
  await expect(sessionStatus(page)).toContainText('idle')
  await expectNoViolations(page, 'empty run')
})

test('a11y: a live run with the crews collapsed, then expanded', async ({ page }) => {
  const run = rand()
  const member = `quotas-builder-${run}`
  real = await startReal({
    plan: (p) => { p.crews.find((c: { slug: string }) => c.slug === 'quotas').status = 'running' },
    events: [spawnEvent('quotas', 'quotas', { type: 'truss:foreman', model: 'opus', effort: 'high', by: 'main' }), spawnEvent('quotas', member)],
    trussFiles: { 'reports/quotas/quotas-qc.md': 'VERDICT: PASS\n\nChecked.\n', 'reports/gateway/gateway-qc.md': 'VERDICT: FAIL\n\nChecked.\n' },
  })
  await page.goto(real.url)
  await expect(crewLine(page, 'quotas')).toBeVisible(LOAD)
  await expect(crewLine(page, 'gateway')).toHaveAccessibleName(/FAIL/, LOAD)
  await expectNoViolations(page, 'live run, crews collapsed')

  for (const slug of ['ratelimit-design', 'quotas', 'gateway']) await crewLine(page, slug).click()
  await expect(crewLine(page, 'quotas')).toHaveAttribute('aria-expanded', 'true')
  await expect(members(page, 'quotas').getByRole('listitem').filter({ hasText: rx(member) })).toBeVisible(WITHIN)
  await expectNoViolations(page, 'live run, crews expanded')
})

test('a11y: an open question card', async ({ page }) => {
  const run = rand()
  iface = await startInterface()
  await page.goto(iface.url)
  iface.question([
    { question: `Which store ${run}?`, header: 'Store', options: [{ label: 'SQLite (Recommended)', description: 'one file' }, { label: 'Postgres', description: 'a server' }] },
    { question: `Which cache ${run}?`, header: 'Cache', multiSelect: true, options: [{ label: 'Memory' }, { label: 'Disk' }] },
  ])
  await expect(card(page, 'question', `Which store ${run}?`)).toBeVisible(LOAD)
  await expect(card(page, 'question', `Which store ${run}?`).getByRole('radiogroup', { name: rx(`Which store ${run}?`) })).toBeVisible()
  await expectNoViolations(page, 'question card')
})

test('a11y: an open permission card', async ({ page }) => {
  const run = rand()
  iface = await startInterface()
  await page.goto(iface.url)
  iface.permission({ toolName: 'Bash', title: `Run tests ${run}`, summary: `npm test ${run}`, input: { command: `npm test ${run}` } })
  await expect(card(page, 'permission', `Run tests ${run}`)).toBeVisible(LOAD)
  await expectNoViolations(page, 'permission card')
})

test('a11y: a reply card, plain and as an error', async ({ page }) => {
  const run = rand()
  iface = await startInterface()
  await page.goto(iface.url)
  iface.reply({ text: `Approve the plan ${run}?`, backgroundTasks: 2 })
  await expect(card(page, 'reply', `Approve the plan ${run}?`)).toBeVisible(LOAD)
  await expectNoViolations(page, 'reply card')

  iface.reply({ text: `The run failed ${run}`, isError: true })
  await expect(card(page, 'reply', `The run failed ${run}`)).toBeVisible(WITHIN)
  await expectNoViolations(page, 'reply card, error')
})

test('a11y: the design panel open', async ({ page }) => {
  const run = rand()
  real = await startReal({ trussFiles: { 'plan.md': `# Plan ${run}\n\nThe plan for run ${run}.\n` } })
  await page.goto(real.url)
  await expect(crewLine(page, 'quotas')).toBeVisible(LOAD)
  await openTab(page, 'Design')
  const panel = page.getByRole('tabpanel', { name: 'Design', exact: true })
  await expect(panel.getByText(rx(`The plan for run ${run}.`)).first()).toBeVisible(LOAD)
  await expect(panel.getByText('mermaid diagram (source)').first()).toBeVisible(LOAD)
  await expectNoViolations(page, 'design panel')
})

test('a11y: the decisions and ADRs panel open', async ({ page }) => {
  const run = rand()
  real = await startReal()
  real.appendDecision(`- 10:00 | choose-${run}-store | because ${run} | checker: none | followed`)
  await page.goto(real.url)
  await expect(crewLine(page, 'quotas')).toBeVisible(LOAD)
  await openTab(page, 'Decisions and ADRs')
  const panel = page.getByRole('tabpanel', { name: 'Decisions and ADRs', exact: true })
  await expect(panel.getByRole('region', { name: 'Decisions', exact: true }).getByRole('listitem').filter({ hasText: rx(`choose-${run}-store`) })).toBeVisible(LOAD)
  await expect(panel.getByRole('region', { name: 'ADRs', exact: true }).getByRole('listitem').first()).toBeVisible(LOAD)
  await expectNoViolations(page, 'decisions and ADRs panel')
})

test('a11y: the session error state', async ({ page }) => {
  const run = rand()
  const message = `The session stopped ${run}`
  iface = await startInterface()
  await page.goto(iface.url)
  iface.setSession({ status: 'error', error: message })
  iface.emit(null, [{ n: 1, role: 'error', text: message, ts: new Date().toISOString() }])
  await expect(sessionStatus(page)).toContainText(rx(`error: ${message}`), LOAD)
  await expect(page.getByRole('log', { name: 'Transcript', exact: true }).getByText(rx(message)).first()).toBeVisible(LOAD)
  await expectNoViolations(page, 'session error')
})
