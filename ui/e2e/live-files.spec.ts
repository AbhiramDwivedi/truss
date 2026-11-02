// What the page shows from Truss's files (ADR-0011; R-4, R-5, R-6, R-14, R-15). Every test starts the real
// ui/server/main.ts on a temp copy of real Truss files (harness.startReal), port 0, no fake Claude session.
// Elements are found by role and accessible name, with per-run random values in the names, so no fixed
// string can pass by accident. Written before ui/web exists: each test fails now on a missing page.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG, WITHIN, rand, root, rx, spawnEvent, startReal, type Real } from './harness.ts'

const LOAD = { timeout: 10000 }
let real: Real | undefined
test.afterEach(async () => {
  await real?.stop()
  real = undefined
})

type Page = import('@playwright/test').Page
// A crew line: the one button per crew, in its stage group of the Crews region (ADR-0018 section 10).
const crewButtons = (page: Page, slug: string) =>
  page.getByRole('region', { name: 'Crews', exact: true }).getByRole('group', { name: /^Stage \d+$/ }).getByRole('listitem')
    .getByRole('button', { name: new RegExp(`\\b${slug}\\b`, 'i') })
const crewLine = (page: Page, slug: string) => crewButtons(page, slug).first()
// The members of an open crew line: a list named "<slug> members".
const members = (page: Page, slug: string) => page.getByRole('list', { name: `${slug} members`, exact: true })
const member = (page: Page, slug: string, name: string) => members(page, slug).getByRole('listitem').filter({ hasText: name })
async function openTab(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('tab', { name, exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}
const panel = (page: Page, name: string) => page.getByRole('tabpanel', { name, exact: true })

test('R-4: one status line per crew shows stage, status, latest activity and QC verdict as text, and opens into its members', async ({ page }) => {
  const run = rand()
  const memberName = `quotas-builder-${run}`
  real = await startReal({
    plan: (p) => { p.crews.find((c: { slug: string }) => c.slug === 'quotas').status = 'running' },
    events: [spawnEvent('quotas', 'quotas', { type: 'truss:foreman', model: 'opus', effort: 'high', by: 'main' }), spawnEvent('quotas', memberName)],
    trussFiles: { 'reports/quotas/quotas-qc.md': `VERDICT: PASS\n\nQC ${run}\n` },
  })
  await page.goto(real.url)

  // One line per plan crew, each a button.
  for (const slug of ['ratelimit-design', 'quotas', 'gateway']) await expect(crewLine(page, slug)).toBeVisible(LOAD)
  for (const slug of ['ratelimit-design', 'quotas', 'gateway']) {
    await expect(page.getByRole('button', { name: new RegExp(`\\b${slug}\\b`, 'i') })).toHaveCount(1)
  }
  // Crews sit in stage groups; the example plan's quotas crew is stage 1.
  await expect(page.getByRole('region', { name: 'Crews', exact: true }).getByRole('group', { name: 'Stage 1', exact: true }).getByRole('heading', { level: 3, name: 'Stage 1' })).toBeVisible()

  // Stage, status, latest activity and QC verdict are words in the line (not color alone).
  const line = crewLine(page, 'quotas')
  await expect(line).toHaveAccessibleName(/stage 1/i)
  await expect(line).toHaveAccessibleName(/running/i)
  await expect(line).toHaveAccessibleName(new RegExp(`${memberName} spawned`, 'i'))
  await expect(line).toHaveAccessibleName(/QC PASS/)
  // A crew with no QC file does not claim a verdict.
  await expect(crewLine(page, 'gateway')).toHaveAccessibleName(/QC none/)
  await expect(crewLine(page, 'gateway')).not.toHaveAccessibleName(/PASS|FAIL/)

  // The line is a button with aria-expanded; opening it shows the members' one-line status.
  await expect(line).toHaveAttribute('aria-expanded', 'false')
  await line.click()
  await expect(line).toHaveAttribute('aria-expanded', 'true')
  const m = member(page, 'quotas', memberName)
  await expect(m).toBeVisible()
  for (const word of ['kit:builder', 'sonnet', 'medium', 'spawned']) await expect(m).toContainText(word)
  await line.press('Enter') // keyboard (R-18) closes it again
  await expect(line).toHaveAttribute('aria-expanded', 'false')
  await expect(members(page, 'quotas')).toBeHidden()

  // R-15: a new event changes the latest activity and the member's state within 2 s.
  real.appendEvent({ v: 1, ts: new Date().toISOString(), event: 'stall', crew: 'quotas', agent: memberName, kind: 'agent', minutes: 15 })
  await expect(line).toHaveAccessibleName(new RegExp(`${memberName} stalled 15 min`, 'i'), WITHIN)
  await line.click()
  await expect(member(page, 'quotas', memberName)).toContainText(/stalled/, WITHIN)
})

test('R-15, R-4: a QC file with VERDICT: FAIL written to reports/<crew>/<crew>-qc.md shows in the crew line within 2 s', async ({ page }) => {
  real = await startReal()
  await page.goto(real.url)
  await expect(crewLine(page, 'gateway')).toBeVisible(LOAD)
  await expect(crewLine(page, 'gateway')).not.toHaveAccessibleName(/FAIL/)
  real.writeQc('gateway', 'FAIL')
  await expect(crewLine(page, 'gateway')).toHaveAccessibleName(/FAIL/, WITHIN)
})

test('R-15, R-4: plan.json status and stage changes show in the crew line within 2 s without a reload', async ({ page }) => {
  real = await startReal()
  await page.goto(real.url)
  await expect(crewLine(page, 'gateway')).toHaveAccessibleName(/planned/i, LOAD)
  real.writePlan((p) => { p.crews.find((c: { slug: string }) => c.slug === 'gateway').status = 'merged' })
  await expect(crewLine(page, 'gateway')).toHaveAccessibleName(/merged/i, WITHIN)
})

test('R-5, R-15: decisions.md lines and a new ADR file show in the decisions and ADRs panel within 2 s', async ({ page }) => {
  const run = rand()
  real = await startReal()
  await page.goto(real.url)
  await expect(crewLine(page, 'quotas')).toBeVisible(LOAD)
  await openTab(page, 'Decisions and ADRs')
  const decisions = panel(page, 'Decisions and ADRs').getByRole('region', { name: 'Decisions', exact: true })
  const adrs = panel(page, 'Decisions and ADRs').getByRole('region', { name: 'ADRs', exact: true })
  // The real ADR already on disk is listed with its title and status.
  await expect(adrs.getByRole('listitem').filter({ hasText: /a design phase, principle packs/i }).first()).toBeVisible(LOAD)

  const decision = `choose-${run}-store`
  real.appendDecision(`- 10:00 | ${decision} | because ${run} | checker: none | followed`)
  await expect(decisions.getByRole('listitem').filter({ hasText: rx(decision) })).toBeVisible(WITHIN)

  const adrTitle = `Adopt ${run} queue`
  real.writeAdr(`0099-${run}.md`, `ADR-0099: ${adrTitle}`, 'accepted')
  const adr = adrs.getByRole('listitem').filter({ hasText: rx(adrTitle) })
  await expect(adr).toBeVisible(WITHIN)
  // Its status is words too.
  await expect(adr).toContainText(/accepted/i)
})

test('R-6: the design panel shows plan.md, the architecture doc as markdown and a mermaid block as labelled source', async ({ page }) => {
  const run = rand()
  const arch = readFileSync(join(root, 'docs', 'architecture.md'), 'utf8')
  const title = /^# (.+)$/m.exec(arch)![1]!
  const mermaidFirst = /```mermaid\n([^\n]+)\n/.exec(arch)![1]!
  real = await startReal({ trussFiles: { 'plan.md': `# Plan ${run}\n\nThe plan for run ${run}.\n` } })
  await page.goto(real.url)
  await expect(crewLine(page, 'quotas')).toBeVisible(LOAD)
  await openTab(page, 'Design')
  const design = panel(page, 'Design')

  // plan.md, rendered: its heading is a heading.
  await expect(design.getByText(rx(`The plan for run ${run}.`)).first()).toBeVisible(LOAD)
  await expect(design.getByRole('heading', { name: rx(`Plan ${run}`) }).first()).toBeVisible()

  // The architecture doc, rendered as markdown (loaded when the panel opens): its title is a heading, no raw "# ".
  await expect(design.getByRole('heading', { name: rx(title) }).first()).toBeVisible(LOAD)
  await expect(design.getByText(`# ${title}`, { exact: true })).toHaveCount(0)

  // A mermaid block is shown as source under the label, not drawn.
  await expect(design.getByText('mermaid diagram (source)').first()).toBeVisible()
  await expect(design.getByText(mermaidFirst, { exact: false }).first()).toBeVisible()
})

test('R-6: an image a crew branch added shows in the design panel, loaded through /api/image', async ({ page }) => {
  const run = rand()
  const path = `docs/shots/built-${run}.png`
  real = await startReal({ images: [{ slug: 'quotas', path }] })
  const imageResponses: string[] = []
  page.on('response', (r) => { if (r.url().includes('/api/image')) imageResponses.push(`${r.status()} ${r.url()}`) })
  await page.goto(real.url)
  await expect(crewLine(page, 'quotas')).toBeVisible(LOAD)
  await openTab(page, 'Design')

  // git runs every 5 s (Decision 4), so the image may take a few seconds to be listed.
  const img = panel(page, 'Design').getByRole('img', { name: rx(`built-${run}`) }).first()
  await expect(img).toBeVisible({ timeout: 15000 })
  await expect(img).toHaveAttribute('src', /\/api\/image\?/)
  await expect(img).toHaveAttribute('src', new RegExp(`ref=truss-quotas`))
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { timeout: 5000 }).toBe(1)
  expect(imageResponses.some((r) => r.startsWith('200 '))).toBe(true)
  // The bytes the server sends are the PNG the branch holds.
  const res = await page.request.get((await img.getAttribute('src'))!)
  expect(res.status()).toBe(200)
  expect(Buffer.compare(await res.body(), PNG)).toBe(0)
})

test('R-14, R-15: a plan of 12 crews with 100 agents renders, opens, and a change still shows within 2 s', async ({ page }) => {
  const run = rand()
  const slugs = Array.from({ length: 12 }, (_, i) => `lane-${String(i + 1).padStart(2, '0')}`)
  const events: Array<Record<string, unknown>> = []
  const members = new Map<string, string[]>()
  let agents = 0
  for (const slug of slugs) { events.push(spawnEvent(slug, slug, { type: 'truss:foreman', model: 'opus', effort: 'high', by: 'main' })); agents++ }
  for (let i = 0; agents < 100; i++, agents++) {
    const slug = slugs[i % 12]!
    const name = `${slug}-m${String(i).padStart(3, '0')}-${run}`
    members.set(slug, [...(members.get(slug) ?? []), name])
    events.push(spawnEvent(slug, name))
  }
  expect(agents).toBe(100)
  real = await startReal({
    plan: (p) => {
      const tpl = p.crews.find((c: { slug: string }) => c.slug === 'quotas')
      p.crews = slugs.map((slug, i) => ({ ...tpl, slug, stage: 1 + (i % 3), status: 'running', owns: [`src/${slug}/**`], modules: [slug] }))
    },
    events,
  })
  const t0 = Date.now()
  await page.goto(real.url)
  for (const slug of slugs) await expect(crewLine(page, slug)).toBeVisible(LOAD)
  expect(Date.now() - t0, 'first render of 12 crews, ms').toBeLessThan(10000)
  for (const slug of slugs) await expect(page.getByRole('button', { name: new RegExp(`\\b${slug}\\b`, 'i') })).toHaveCount(1)

  // A crew with many members opens into all of them.
  const last = slugs[11]!
  const names = members.get(last)!
  expect(names.length).toBeGreaterThanOrEqual(7)
  await crewLine(page, last).click()
  for (const n of names) await expect(member(page, last, n)).toBeVisible()

  // A change in the busy run still shows within 2 s.
  real.writeQc('lane-05', 'FAIL')
  await expect(crewLine(page, 'lane-05')).toHaveAccessibleName(/FAIL/, WITHIN)
  const decision = `busy-${run}-decision`
  real.appendDecision(`- 11:00 | ${decision} | because ${run} | checker: none | followed`)
  await openTab(page, 'Decisions and ADRs')
  await expect(panel(page, 'Decisions and ADRs').getByRole('region', { name: 'Decisions', exact: true }).getByRole('listitem').filter({ hasText: rx(decision) })).toBeVisible(WITHIN)
})
