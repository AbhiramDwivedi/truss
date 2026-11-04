// What the page shows from Truss's files (ADR-0011; R-4, R-5, R-6, R-14, R-15). Every test starts the real
// ui/server/main.ts on a temp copy of real Truss files (harness.startReal), port 0, no fake Claude session.
// Elements are found by role and accessible name, with per-run random values in the names, so no fixed
// string can pass by accident. Written before ui/web exists: each test fails now on a missing page.
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG, WITHIN, adrTimeline, crewLine, deliverables, openArchitecture, expectD2Colours, rand, root, rx, spawnEvent, startReal, type Real } from './harness.ts'

const LOAD = { timeout: 10000 }
let real: Real | undefined
test.afterEach(async () => {
  await real?.stop()
  real = undefined
})

type Page = import('@playwright/test').Page
// An agent card inside its crew card (ADR-0028 section 10: every crew card lists its agents as cards).
const member = (page: Page, slug: string, name: string) => crewLine(page, slug).getByRole('listitem').filter({ hasText: name })

// ADR-0023 checklist item 22: the live page paints the tokens.json colours.
test('D2 colours: a live run paints body with tokens.json bg and the move surface with move', async ({ page }) => {
  real = await startReal()
  await page.goto(real.url)
  await expect(crewLine(page, 'quotas')).toBeVisible(LOAD)
  await expectD2Colours(page, 'light')
})

test('R-4: one status line per crew shows stage, status, latest activity and QC verdict as text, and opens into its members', async ({ page }) => {
  const run = rand()
  const memberName = `quotas-builder-${run}`
  real = await startReal({
    plan: (p) => { p.crews.find((c: { slug: string }) => c.slug === 'quotas').status = 'running' },
    events: [spawnEvent('quotas', 'quotas', { type: 'truss:foreman', model: 'opus', effort: 'high', by: 'main' }), spawnEvent('quotas', memberName)],
    trussFiles: { 'reports/quotas/quotas-qc.md': `VERDICT: PASS\n\nQC ${run}\n` },
  })
  await page.goto(real.url)

  // One card per plan crew: an article named by its slug in the Build network region (ADR-0028 section 10).
  for (const slug of ['ratelimit-design', 'quotas', 'gateway']) await expect(crewLine(page, slug)).toBeVisible(LOAD)
  for (const slug of ['ratelimit-design', 'quotas', 'gateway']) {
    await expect(page.getByRole('region', { name: 'Build network', exact: true }).getByRole('article', { name: new RegExp(`\\b${slug}\\b`, 'i') })).toHaveCount(1)
  }
  // Crews sit in stage rows, each a list of crew cards (ADR-0028 section 10).
  await expect(page.getByRole('region', { name: 'Build network', exact: true }).getByRole('list').getByRole('article', { name: /\bquotas\b/i })).toBeVisible()

  // Stage, status, latest activity and QC verdict are words on the card (not color alone).
  const line = crewLine(page, 'quotas')
  await expect(line).toContainText(/stage 1/i)
  await expect(line).toContainText(/active/i) // ADR-0028 section 9: one status vocabulary
  await expect(line).toContainText(new RegExp(`${memberName}`, 'i'))
  await expect(line).toContainText(/QC PASS/)
  // A crew with no QC file does not claim a verdict.
  await expect(crewLine(page, 'gateway')).toContainText(/QC none/)
  await expect(crewLine(page, 'gateway')).not.toContainText(/PASS|FAIL/)

  // ADR-0028 section 10: every crew card lists its agents as cards, with no expand step.
  const m = line.getByRole('listitem').filter({ hasText: memberName })
  await expect(m).toBeVisible()
  for (const word of ['sonnet']) await expect(m).toContainText(word)

  // R-15: a new event changes the latest activity and the member's state within 2 s.
  real.appendEvent({ v: 1, ts: new Date().toISOString(), event: 'stall', crew: 'quotas', agent: memberName, kind: 'agent', minutes: 15 })
  await expect(line).toContainText(new RegExp(`${memberName}.*stalled 15 min|stalled 15 min.*${memberName}`, 'is'), WITHIN) // ADR-0028 section 10: no expand step
  await expect(member(page, 'quotas', memberName)).toContainText(/stalled/, WITHIN)
})

test('R-15, R-4: a QC file with VERDICT: FAIL written to reports/<crew>/<crew>-qc.md shows in the crew line within 2 s', async ({ page }) => {
  real = await startReal()
  await page.goto(real.url)
  await expect(crewLine(page, 'gateway')).toBeVisible(LOAD)
  await expect(crewLine(page, 'gateway')).not.toContainText(/FAIL/)
  real.writeQc('gateway', 'FAIL')
  await expect(crewLine(page, 'gateway')).toContainText(/FAIL/, WITHIN)
})

test('R-15, R-4: plan.json status and stage changes show in the crew line within 2 s without a reload', async ({ page }) => {
  real = await startReal()
  await page.goto(real.url)
  await expect(crewLine(page, 'gateway')).toContainText(/planned/i, LOAD)
  real.writePlan((p) => { p.crews.find((c: { slug: string }) => c.slug === 'gateway').status = 'merged' })
  await expect(crewLine(page, 'gateway')).toContainText(/done/i, WITHIN) // ADR-0028 section 9: merged shows as Done
})

test('R-5, R-15: decisions.md lines and a new ADR file show in the rail timeline within 2 s', async ({ page }) => {
  const run = rand()
  real = await startReal()
  await page.goto(real.url)
  await expect(crewLine(page, 'quotas')).toBeVisible(LOAD)
  // ADR-0028 section 3: no tab; the rail's "Decisions and ADRs" timeline is the one list of both.
  const decisions = adrTimeline(page)
  const adrs = adrTimeline(page)
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

test('R-6: the Architecture deliverable shows the architecture doc as markdown and mermaid blocks drawn', async ({ page }) => {
  const arch = readFileSync(join(root, 'docs', 'architecture.md'), 'utf8')
  const title = /^# (.+)$/m.exec(arch)![1]!
  real = await startReal({ trussFiles: { 'plan.md': `# Plan ${rand()}\n\nThe plan.\n` } })
  await page.goto(real.url)
  await expect(crewLine(page, 'quotas')).toBeVisible(LOAD)
  // ADR-0028 sections 4, 5, 10: no Design tab; Architecture is the first deliverable and opens in the preview.
  await openArchitecture(page)

  // The architecture doc, rendered as markdown: its title is a heading, no raw "# ".
  await expect(page.getByRole('heading', { name: rx(title) }).first()).toBeVisible(LOAD)
  await expect(page.getByText(`# ${title}`, { exact: true })).toHaveCount(0)

  // A mermaid block is drawn, in a focusable figure labelled "Diagram n of m"; the source is behind "Show source".
  const figure = page.getByRole('figure', { name: /^Diagram 1 of \d+$/ })
  await expect(figure).toBeVisible(LOAD)
  await expect(figure).toHaveAttribute('tabindex', '0')
  await expect(figure.getByText('Show source')).toBeVisible()
  await expect(page.getByText('mermaid diagram (source)')).toHaveCount(0)
})

test('R-6: an image a crew branch added shows in the design panel, loaded through /api/image', async ({ page }) => {
  const run = rand()
  const path = `docs/shots/built-${run}.png`
  real = await startReal({ images: [{ slug: 'quotas', path }] })
  const imageResponses: string[] = []
  page.on('response', (r) => { if (r.url().includes('/api/image')) imageResponses.push(`${r.status()} ${r.url()}`) })
  await page.goto(real.url)
  await expect(crewLine(page, 'quotas')).toBeVisible(LOAD)
  // ADR-0028 section 10: no Design tab; images are deliverables in main.

  // git runs every 5 s (Decision 4), so the image may take a few seconds to be listed.
  const img = deliverables(page).getByRole('img', { name: rx(`built-${run}`) }).first()
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
  for (const slug of slugs) await expect(page.getByRole('region', { name: 'Build network', exact: true }).getByRole('article', { name: new RegExp(`\\b${slug}\\b`, 'i') })).toHaveCount(1)

  // A crew with more than 6 agents shows the first 6 and a "Show n more agents" button (UX direction, Build network, Long).
  const last = slugs[11]!
  const names = members.get(last)!
  expect(names.length).toBeGreaterThanOrEqual(7)
  await crewLine(page, last).getByRole('button', { name: /^Show \d+ more agents$/ }).click()
  for (const n of names) await expect(member(page, last, n)).toBeVisible()

  // A change in the busy run still shows within 2 s.
  real.writeQc('lane-05', 'FAIL')
  await expect(crewLine(page, 'lane-05')).toContainText(/FAIL/, WITHIN)
  const decision = `busy-${run}-decision`
  real.appendDecision(`- 11:00 | ${decision} | because ${run} | checker: none | followed`)
  await expect(adrTimeline(page).getByRole('listitem').filter({ hasText: rx(decision) })).toBeVisible(WITHIN)
})
