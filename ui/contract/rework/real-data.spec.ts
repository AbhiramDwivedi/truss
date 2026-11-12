// The real-data contract on the client (ADR-0029 points 1 to 5), over the snapshot fixtures/rework/real-data/state.json
// planted with plant('real-data') into the fake interface (port 0), never a live server. Written before the build:
// every case here fails against the client as it is. Elements are reached by role and name; the agent card is the
// list item that holds the agent's name. The snapshot's times are not moved (now = FIXTURE_ANCHOR), because the
// decisions run heading inside a string is not shifted by the harness, and run time reads from it.
import { test, expect, type Page } from '@playwright/test'
import { FIXTURE_ANCHOR } from '../../e2e/harness.ts'
import { openFixture, WIDTHS, T, LOAD } from './support.ts'

const DESKTOP = WIDTHS.wide
const NOW = Date.parse(FIXTURE_ANCHOR)

const network = (page: Page) => page.getByRole('region', { name: 'Build network' })
const crewCard = (page: Page, slug: string) => network(page).getByRole('article', { name: new RegExp(`\\b${slug}\\b`) })
const agent = (page: Page, slug: string, name: string) => crewCard(page, slug).getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) })
// Runner and general-purpose agents sit in a collapsed "N check runs" row; open it before reading their cards.
const openRuns = async (page: Page, slug: string) => {
  const btn = crewCard(page, slug).getByRole('button', { name: /^\d+ check runs?$/ })
  await expect(btn).toBeVisible(T)
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click()
  await expect(btn).toHaveAttribute('aria-expanded', 'true')
}
const metrics = (page: Page) => page.getByRole('region', { name: 'Run metrics', exact: true })
const tile = (page: Page, label: string) => metrics(page).getByText(label, { exact: true }).locator('..')

test.describe('real-data design', () => {
  test("real-data 1: a running crew's BLOCKED agent still reads Waiting on you", async ({ browser }) => {
    const o = await openFixture(browser, 'real-data', 'light', DESKTOP, { now: NOW })
    try {
      await expect(network(o.page)).toBeVisible(LOAD)
      const projectManager = agent(o.page, 'build-crew', 'build-crew')
      await expect(projectManager.getByText('Waiting on you', { exact: true })).toHaveCount(1, T)
      await expect(projectManager.getByText('Done', { exact: true })).toHaveCount(0, T)
    } finally { await o.stop() }
  })

  test("real-data 1: a merged crew's agents read Done, the project manager's last BLOCKED tag included", async ({ browser }) => {
    const o = await openFixture(browser, 'real-data', 'light', DESKTOP, { now: NOW })
    try {
      await expect(network(o.page)).toBeVisible(LOAD)
      await openRuns(o.page, 'docs-crew')
      for (const name of ['docs-crew', 'docs-crew-runner', 'docs-crew-runner-2']) {
        const card = agent(o.page, 'docs-crew', name)
        await expect(card.getByText('Done', { exact: true }), `${name} reads Done`).toHaveCount(1, T)
        await expect(card.getByText('Waiting on you', { exact: true }), `${name} does not read Waiting on you`).toHaveCount(0, T)
      }
    } finally { await o.stop() }
  })

  test('real-data 1: a null model shows no model badge and the page never says model unknown', async ({ browser }) => {
    const o = await openFixture(browser, 'real-data', 'light', DESKTOP, { now: NOW })
    try {
      await expect(network(o.page)).toBeVisible(LOAD)
      for (const slug of ['docs-crew', 'build-crew']) await openRuns(o.page, slug)
      for (const slug of ['docs-crew', 'build-crew']) {
        await expect(agent(o.page, slug, slug), `${slug} project manager has a null model, so no badge`).not.toContainText(/opus|sonnet|haiku|unknown/i)
        await expect(agent(o.page, slug, `${slug}-runner`), `${slug} member keeps its model badge`).toContainText(/sonnet/i)
      }
      await expect(o.page.getByText(/model unknown/i)).toHaveCount(0, T)
    } finally { await o.stop() }
  })

  test("real-data 2: an agent shows its own task first, then a project manager's crew goal, then a non-marker detail, then Reported with its marker", async ({ browser }) => {
    const o = await openFixture(browser, 'real-data', 'light', DESKTOP, {
      now: NOW,
      edit: (s) => {
        const build = s.run.crews.find((c: any) => c.slug === 'build-crew')
        // the runner: no task, a detail that is not a marker
        build.members.find((m: any) => m.name === 'build-crew-runner').detail = 'Reading the design note'
        // the builder: no task, reported with a marker
        const builder = build.members.find((m: any) => m.name === 'build-crew-builder')
        builder.task = null; builder.detail = 'DONE'
      },
    })
    try {
      await expect(network(o.page)).toBeVisible(LOAD)
      await openRuns(o.page, 'docs-crew'); await openRuns(o.page, 'build-crew')
      // task first
      await expect(agent(o.page, 'docs-crew', 'docs-crew-runner-2').getByText('Write the design note for the fixture widget in docs/widget.md.')).toBeVisible(T)
      // a project manager with no task shows its crew goal, not "No activity yet" and not the BLOCKED marker
      const projectManager = agent(o.page, 'build-crew', 'build-crew')
      await expect(projectManager.getByText('Build the fixture widget.')).toBeVisible(T)
      await expect(projectManager.getByText('No activity yet')).toHaveCount(0, T)
      await expect(projectManager.getByText('BLOCKED')).toHaveCount(0, T)
      // a non-marker detail
      const runner = agent(o.page, 'build-crew', 'build-crew-runner')
      await expect(runner.getByText('Reading the design note')).toBeVisible(T)
      await expect(runner.getByText('No activity yet')).toHaveCount(0, T)
      // Reported, with its marker
      const builder = agent(o.page, 'build-crew', 'build-crew-builder')
      await expect(builder.getByText(/Reported\b.*\bDONE\b/)).toBeVisible(T)
      await expect(builder.getByText('No activity yet')).toHaveCount(0, T)
    } finally { await o.stop() }
  })

  test('real-data 2: "No activity yet" shows only for a spawned agent with no task, no goal, no detail and no report', async ({ browser }) => {
    const o = await openFixture(browser, 'real-data', 'light', DESKTOP, { now: NOW })
    try {
      await expect(network(o.page)).toBeVisible(LOAD)
      await openRuns(o.page, 'docs-crew'); await openRuns(o.page, 'build-crew')
      await expect(network(o.page).getByText('No activity yet')).toHaveCount(1, T)
      await expect(agent(o.page, 'build-crew', 'build-crew-runner').getByText('No activity yet')).toHaveCount(1, T)
      // a reported agent with a null detail and a task shows the task, never the fallback
      await expect(agent(o.page, 'docs-crew', 'docs-crew-runner').getByText('No activity yet')).toHaveCount(0, T)
    } finally { await o.stop() }
  })

  test('real-data 3: run time reads from the decisions run heading, not a dash', async ({ browser }) => {
    const o = await openFixture(browser, 'real-data', 'light', DESKTOP, { now: NOW })
    try {
      await expect(metrics(o.page)).toBeVisible(LOAD)
      // 11:00:26 to the latest project manager stamp 11:59:00 is 58 minutes (the run is not hosted, so it ends there)
      const t = tile(o.page, 'Run time')
      await expect(t).toContainText(/\b5[89]m\b/, T)
      await expect(t).not.toHaveText(/—/, T)
      await expect(t).not.toContainText('No usage yet', T)
    } finally { await o.stop() }
  })

  test('real-data 3: Cost reads "Not recorded" when a run exists and there is no usage and no transcript', async ({ browser }) => {
    const o = await openFixture(browser, 'real-data', 'light', DESKTOP, { now: NOW })
    try {
      await expect(metrics(o.page)).toBeVisible(LOAD)
      await expect(tile(o.page, 'Cost')).toContainText('Not recorded', T)
      await expect(metrics(o.page).getByText('No usage yet')).toHaveCount(0, T)
    } finally { await o.stop() }
  })

  test('real-data 3: the header summary agrees with the Cost tile', async ({ browser }) => {
    const o = await openFixture(browser, 'real-data', 'light', DESKTOP, { now: NOW })
    try {
      await expect(metrics(o.page)).toBeVisible(LOAD)
      await expect(tile(o.page, 'Cost')).toContainText('Not recorded', T)
      const link = o.page.locator('a[href="#run-metrics"]')
      await expect(link).toBeVisible(T)
      // no $0.00 beside a Cost that is not recorded; the run time alone is left
      await expect(link).not.toContainText('$', T)
      await expect(link).toContainText(/\b5[89]m\b/, T)
    } finally { await o.stop() }
  })

  test('real-data 4: the Run region has no Pause build button and no Hint for it', async ({ browser }) => {
    const o = await openFixture(browser, 'real-data', 'light', DESKTOP, { now: NOW })
    try {
      await expect(network(o.page)).toBeVisible(LOAD)
      await expect(o.page.getByRole('button', { name: 'Pause build' })).toHaveCount(0, T)
      await expect(o.page.getByText(/Pausing needs a server endpoint/)).toHaveCount(0, T)
      await expect(o.page.getByRole('tooltip')).toHaveCount(0, T)
    } finally { await o.stop() }
  })
})
