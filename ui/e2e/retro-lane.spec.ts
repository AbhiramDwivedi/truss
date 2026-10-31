// The retro-stage lane in the real UI (ADR-0012 Decision 8; R-23), beyond what
// ui/contract/e2e/retro-stage.spec.ts pins (running, then fixes applied). Each test starts the real
// server on a temp copy of real Truss files (startReal, port 0), writes <truss dir>/retro/state.json the
// way retro/cli.ts would, and finds everything by role and accessible name. Per-run values are step
// details, so no fixed string can pass by accident. Written before ui/web has a retro lane: it fails on
// the missing region named Retro stage.
import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WITHIN, rand, startReal, type Real } from './harness.ts'

const LOAD = { timeout: 10000 }
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const STEPS = ['extract', 'judges', 'triage', 'fixGoal', 'applied'] as const
// The labels the lane gives its steps: the contract pins Extract, Judges and Fixes applied.
const LABEL: Record<(typeof STEPS)[number], string> = { extract: 'Extract', judges: 'Judges', triage: 'Triage', fixGoal: 'Fix goal', applied: 'Fixes applied' }
type Step = { status: string; at: string | null; detail: string | null }

let real: Real | undefined
test.afterEach(async () => {
  await real?.stop()
  real = undefined
})

const stamp = () => new Date().toISOString()
function writeRetro(r: Real, over: Partial<Record<(typeof STEPS)[number], Step>>): void {
  const steps: Record<string, Step> = {}
  for (const k of STEPS) steps[k] = over[k] ?? { status: 'pending', at: null, detail: null }
  mkdirSync(join(r.trussDir, 'retro'), { recursive: true })
  writeFileSync(join(r.trussDir, 'retro', 'state.json'), JSON.stringify({ v: 1, updatedAt: stamp(), steps }))
}

const lane = (page: Page) => page.getByRole('region', { name: 'Retro stage' })
const crews = (page: Page) => page.getByRole('region', { name: /crews/i })

test('R-23: with no retro/state.json the page shows the crew lanes and no region named Retro stage', async ({ page }) => {
  real = await startReal()
  await page.goto(real.url)
  await expect(page.getByText(/quotas/i).first()).toBeVisible(LOAD)
  await expect(page.getByRole('button', { name: /\bgateway\b/i }).first()).toBeVisible(LOAD)
  await expect(lane(page)).toHaveCount(0)
  // The kept side: the lane appears when the file does, so the absence above was not a missing feature.
  writeRetro(real, { extract: { status: 'running', at: stamp(), detail: null } })
  await expect(lane(page)).toBeVisible(WITHIN)
  // And it goes when the file does.
  rmSync(join(real.trussDir, 'retro', 'state.json'))
  await expect(lane(page)).toHaveCount(0, WITHIN)
})

test('R-23: the steps are list items named <Step>: <status>, and a failed and a skipped step each show within 2 s', async ({ page }) => {
  const run = rand()
  real = await startReal()
  await page.goto(real.url)
  await expect(page.getByText(/quotas/i).first()).toBeVisible(LOAD)
  const t = stamp()
  writeRetro(real, {
    extract: { status: 'done', at: t, detail: `${run} extracted` },
    judges: { status: 'failed', at: t, detail: `${run} judge failed` },
    triage: { status: 'skipped', at: t, detail: null },
    fixGoal: { status: 'skipped', at: t, detail: null },
    applied: { status: 'skipped', at: t, detail: null },
  })
  await expect(lane(page)).toBeVisible(WITHIN)
  const l = lane(page)
  await expect(l.getByRole('listitem', { name: `${LABEL.judges}: failed` })).toBeVisible(WITHIN)
  await expect(l.getByRole('listitem', { name: `${LABEL.triage}: skipped` })).toBeVisible(WITHIN)
  await expect(l.getByRole('listitem', { name: `${LABEL.extract}: done` })).toBeVisible(WITHIN)
  await expect(l.getByRole('listitem', { name: `${LABEL.fixGoal}: skipped` })).toBeVisible(WITHIN)
  await expect(l.getByRole('listitem', { name: `${LABEL.applied}: skipped` })).toBeVisible(WITHIN)
  await expect(l.getByRole('listitem')).toHaveCount(5)
  await expect(l.getByText(`${run} judge failed`)).toBeVisible(WITHIN)

  // Every step name changes with its status, within 2 s: a lane that ignores the file's values fails here.
  const t2 = stamp()
  writeRetro(real, {
    extract: { status: 'done', at: t2, detail: null },
    judges: { status: 'done', at: t2, detail: null },
    triage: { status: 'done', at: t2, detail: null },
    fixGoal: { status: 'failed', at: t2, detail: `${run} goal failed` },
    applied: { status: 'pending', at: null, detail: null },
  })
  await expect(l.getByRole('listitem', { name: `${LABEL.fixGoal}: failed` })).toBeVisible(WITHIN)
  await expect(l.getByRole('listitem', { name: `${LABEL.judges}: done` })).toBeVisible(WITHIN)
  await expect(l.getByRole('listitem', { name: `${LABEL.applied}: pending` })).toBeVisible(WITHIN)
  await expect(l.getByRole('listitem', { name: `${LABEL.judges}: failed` })).toHaveCount(0)
  await expect(l.getByRole('listitem', { name: `${LABEL.triage}: skipped` })).toHaveCount(0)
})

test('R-23: a per-run detail on a running step is visible inside the lane, and goes when the step moves on', async ({ page }) => {
  const run = rand()
  real = await startReal()
  await page.goto(real.url)
  await expect(page.getByText(/quotas/i).first()).toBeVisible(LOAD)
  const detail = `${run} judges at work, 2 of 3 back`
  writeRetro(real, {
    extract: { status: 'done', at: stamp(), detail: `${run} items extracted` },
    judges: { status: 'running', at: stamp(), detail },
  })
  const l = lane(page)
  await expect(l.getByRole('listitem', { name: `${LABEL.judges}: running` })).toBeVisible(WITHIN)
  await expect(l.getByText(detail)).toBeVisible(WITHIN)
  await expect(l.getByText(`${run} items extracted`)).toBeVisible(WITHIN)
  // The detail belongs to the lane only.
  await expect(page.getByText(detail)).toHaveCount(1)

  const next = `${run} triage sorting`
  writeRetro(real, {
    extract: { status: 'done', at: stamp(), detail: `${run} items extracted` },
    judges: { status: 'done', at: stamp(), detail: null },
    triage: { status: 'running', at: stamp(), detail: next },
  })
  await expect(l.getByText(next)).toBeVisible(WITHIN)
  await expect(l.getByText(detail)).toHaveCount(0, WITHIN)
})

test('R-23: the retro lane comes after the Crews region in document order', async ({ page }) => {
  real = await startReal()
  await page.goto(real.url)
  await expect(page.getByText(/quotas/i).first()).toBeVisible(LOAD)
  writeRetro(real, { extract: { status: 'running', at: stamp(), detail: null } })
  await expect(lane(page)).toBeVisible(WITHIN)
  await expect(crews(page)).toBeVisible(WITHIN)
  const c = await crews(page).elementHandle()
  const r = await lane(page).elementHandle()
  expect(c, 'the Crews region').not.toBeNull()
  expect(r, 'the Retro stage region').not.toBeNull()
  // DOCUMENT_POSITION_FOLLOWING (4): the lane follows the crews, and neither holds the other.
  const pos = await c!.evaluate((a, b) => a.compareDocumentPosition(b as Node), r!)
  expect(pos & 4, `compareDocumentPosition ${pos}`).toBe(4)
  expect(pos & 8, 'the lane is not inside the Crews region').toBe(0)
  expect(pos & 16, 'the lane is not inside the Crews region').toBe(0)
})

test('R-23: axe finds no violations with the retro lane showing', async ({ page }) => {
  const run = rand()
  real = await startReal()
  await page.goto(real.url)
  await expect(page.getByText(/quotas/i).first()).toBeVisible(LOAD)
  const t = stamp()
  writeRetro(real, {
    extract: { status: 'done', at: t, detail: `${run} kept` },
    judges: { status: 'failed', at: t, detail: `${run} failed` },
    triage: { status: 'running', at: t, detail: `${run} running` },
    fixGoal: { status: 'skipped', at: t, detail: null },
    applied: { status: 'pending', at: null, detail: null },
  })
  await expect(lane(page)).toBeVisible(WITHIN)
  await expect(lane(page).getByText(`${run} running`)).toBeVisible(WITHIN)
  const res = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  const lines = res.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).slice(0, 5).join('\n    ')}`)
  expect(res.violations, `axe violations with the retro lane showing:\n${lines.join('\n')}`).toEqual([])
})
