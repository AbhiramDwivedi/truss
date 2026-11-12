// Accessibility of every page state the e2e specs reach (architecture frontend rule 12; R-18).
// Each test reaches one state by role and accessible name (ADR-0018 section 10), waits for a per-run value
// to show, then runs axe with the WCAG 2.2 AA tags in the light and the dark theme and requires zero
// violations in both. Servers bind port 0 (harness). Written before ui/web is rebuilt: every test fails
// on the old client, which lacks the ADR-0018 roles and names.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { WITHIN, adrTimeline, card, crewLine, openArchitecture, expectD2Colours, rand, rx, runStatus, sessionStatus, spawnEvent, startInterface, startReal, type Iface, type Real } from './harness.ts'

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

const tokens = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'contract', 'redesign', 'tokens.json'), 'utf8'))

// Renders one sample per [text colour token, background token] pair on the page (styles set through the CSSOM,
// which the CSP allows), runs axe's color-contrast rule over them and returns the violated rule ids.
async function contrastViolations(page: Page, pairs: ReadonlyArray<readonly [string, string]>, text: string): Promise<string[]> {
  const hex = pairs.map(([fg, bg]) => [tokens.colors[fg].light, tokens.colors[bg].light])
  await page.evaluate(([list, label]) => {
    document.getElementById('contrast-fixture')?.remove()
    const box = document.createElement('div')
    box.id = 'contrast-fixture'
    for (const [fg, bg] of list as string[][]) {
      const p = document.createElement('p')
      p.textContent = label as string
      p.style.color = fg!
      p.style.backgroundColor = bg!
      p.style.fontSize = '14px'
      box.appendChild(p)
    }
    document.body.prepend(box)
  }, [hex, text] as const)
  const res = await new AxeBuilder({ page }).withTags(TAGS).include('#contrast-fixture').analyze()
  await page.evaluate(() => document.getElementById('contrast-fixture')?.remove())
  return res.violations.map((v) => v.id)
}

const crewsRegion =(page: Page) => page.getByRole('region', { name: 'Build network', exact: true }) // ADR-0028 section 10

test('a11y: empty run, with the no-Truss-dir notice', async ({ page }) => {
  const run = rand()
  const text = `No Truss directory yet ${run}`
  iface = await startInterface({ state: { notices: [{ id: 'no-truss-dir', text }] } })
  await page.goto(iface.url)
  await expect(runStatus(page).getByRole('listitem').filter({ hasText: rx(text) })).toContainText('Status:', LOAD)
  await expect(sessionStatus(page)).toContainText('idle')
  await expectNoViolations(page, 'empty run')

  // D2 contrast pairs (ADR-0023 section 3), rendered by hex from tokens.json: the allowed pairs pass axe,
  // and each failing pair (light theme) is caught by axe's color-contrast rule.
  await page.emulateMedia({ colorScheme: 'light' })
  const sample = 'Contrast sample text'
  const ok = [['muted', 'sunken'], ['fg', 'ok-soft'], ['move-fg', 'move'], ['signal-text', 'signal-soft']] as const
  const bad = [['subtle', 'sunken'], ['ok', 'surface'], ['ok', 'ok-soft'], ['sonnet', 'surface'], ['signal', 'surface']] as const
  expect(await contrastViolations(page, ok, sample), 'muted on sunken, fg on ok-soft: no violation').toEqual([])
  for (const [fg, bg] of bad) {
    const hit = await contrastViolations(page, [[fg, bg]], sample)
    expect(hit, `${fg} text on ${bg} must fail color-contrast`).toContain('color-contrast')
  }
})

// ADR-0023 checklist item 22: the app's own styles, not a planted sample, paint the tokens.json colours.
test('a11y: D2 colours, body is tokens.json bg and the move surface is move, light and dark', async ({ page }) => {
  iface = await startInterface()
  await page.goto(iface.url)
  await expect(sessionStatus(page)).toContainText('idle', LOAD)
  for (const colorScheme of SCHEMES) {
    await page.emulateMedia({ colorScheme })
    await expectD2Colours(page, colorScheme)
  }
})

test('a11y: a live run with crew cards and their agent cards', async ({ page }) => {
  const run = rand()
  const member = `quotas-builder-${run}`
  real = await startReal({
    plan: (p) => { p.crews.find((c: { slug: string }) => c.slug === 'quotas').status = 'running' },
    events: [spawnEvent('quotas', 'quotas', { type: 'truss:project-manager', model: 'opus', effort: 'high', by: 'main' }), spawnEvent('quotas', member)],
    trussFiles: { 'reports/quotas/quotas-qc.md': 'VERDICT: PASS\n\nChecked.\n', 'reports/gateway/gateway-qc.md': 'VERDICT: FAIL\n\nChecked.\n' },
  })
  await page.goto(real.url)
  await expect(crewLine(page, 'quotas')).toBeVisible(LOAD)
  await expect(crewLine(page, 'gateway')).toContainText(/FAIL/, LOAD) // ADR-0028 section 10: crew card is an article named by slug
  await expectNoViolations(page, 'live run, crew cards')

  // ADR-0028 section 10: every crew card lists its agents as cards, with no expand step.
  await expect(crewLine(page, 'quotas').getByRole('listitem').filter({ hasText: rx(member) })).toBeVisible(WITHIN)
  await expectNoViolations(page, 'live run, agent cards shown')
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
  iface.reply({ text: `Approve the plan ${run}?`, backgroundTasks: 2, approvalAsk: true })
  await expect(card(page, 'reply', `Approve the plan ${run}?`)).toBeVisible(LOAD)
  await expect(page.getByRole('article', { name: 'Approval needed', exact: true })).toBeVisible() // ADR-0028 section 2
  await expectNoViolations(page, 'reply card')

  iface.reply({ text: `The run failed ${run}`, isError: true, approvalAsk: false })
  await expect(card(page, 'reply', `The run failed ${run}`)).toBeVisible(WITHIN)
  await expectNoViolations(page, 'reply card, error')
})

// ADR-0028 sections 3, 5, 10: no Design tab; the Architecture deliverable opens in the preview and draws mermaid.
test('a11y: the architecture preview open', async ({ page }) => {
  const run = rand()
  real = await startReal({ trussFiles: { 'plan.md': `# Plan ${run}\n\nThe plan for run ${run}.\n` } })
  await page.goto(real.url)
  await expect(crewLine(page, 'quotas')).toBeVisible(LOAD)
  await openArchitecture(page)
  await expect(page.getByRole('figure', { name: /^Diagram \d+ of \d+$/ }).first()).toBeVisible(LOAD)
  await expect(page.getByText('mermaid diagram (source)')).toHaveCount(0)
  await expectNoViolations(page, 'architecture preview')
})

// ADR-0028 section 3: the rail's timeline is the one list of decisions and ADRs; no tab.
test('a11y: the decisions and ADRs timeline in the rail', async ({ page }) => {
  const run = rand()
  real = await startReal()
  real.appendDecision(`- 10:00 | choose-${run}-store | because ${run} | checker: none | followed`)
  await page.goto(real.url)
  await expect(crewLine(page, 'quotas')).toBeVisible(LOAD)
  await expect(page.getByRole('tab')).toHaveCount(0)
  const timeline = adrTimeline(page)
  // The rail timeline lists ADRs and events; a decisions.md line only raises the "N decisions" count
  // (ADR-0028 section 3, as contract/redesign/states.spec.ts does).
  await expect(page.getByText(/\b[1-9]\d* decisions?$/).first()).toBeVisible(LOAD)
  await expect(timeline.getByRole('listitem').filter({ hasText: /ADR-\d+/ }).first()).toBeVisible(LOAD)
  await expectNoViolations(page, 'decisions and ADRs timeline')
})

test('a11y: the session error state', async ({ page }) => {
  const run = rand()
  const message = `The session stopped ${run}`
  iface = await startInterface()
  await page.goto(iface.url)
  iface.setSession({ status: 'error', error: message })
  iface.emit(null, [{ n: 1, role: 'error', text: message, ts: new Date().toISOString() }])
  await expect(sessionStatus(page)).toContainText(rx(`error: ${message}`), LOAD)
  await expect(page.getByRole('log', { name: 'Conversation with the PM', exact: true }).getByText(rx(message)).first()).toBeVisible(LOAD)
  await expectNoViolations(page, 'session error')
})
