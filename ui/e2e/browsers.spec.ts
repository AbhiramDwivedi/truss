// R-48: current and previous major versions of desktop Chrome at 1024 px and up. Chrome only: Firefox and Safari
// are not targets. The checks run in chromium at widths 1024 and 1440. Edge is not a target either, so the
// "(also Edge)" describe label is dropped. ui/playwright.config.ts is not ours, and Playwright refuses
// test.use({ browserName }) inside a describe, so each test launches its own browser from the chromium
// launcher and opens its own page at the width. Status and verdict are asserted as visible text, so color alone
// cannot pass. Pinned to ADR-0018's roles and names: crew lines are found by role in the Crews region.
import { test, expect, chromium, type Page } from '@playwright/test'
import { crewLine, expectD2Colours, rand, spawnEvent, startReal, type Real } from './harness.ts'

const LOAD = { timeout: 10000 }
const WIDTHS = [1024, 1440]
const BROWSERS = [['chromium', chromium]] as const

let real: Real | undefined
test.afterEach(async () => {
  await real?.stop()
  real = undefined
})


for (const [browserName, launcher] of BROWSERS) {
  test.describe(`${browserName}`, () => {
    for (const width of WIDTHS) {
      test(`R-48: at ${width} px the page loads, has no horizontal scrollbar, and shows each crew status and verdict as text`, async () => {
        const run = rand()
        const member = `quotas-builder-${run}`
        const browser = await launcher.launch()
        const page = await browser.newPage({ viewport: { width, height: 800 } })
        try {
        real = await startReal({
          plan: (p) => {
            const byslug = (s: string) => p.crews.find((c: { slug: string }) => c.slug === s)
            byslug('ratelimit-design').status = 'merged'
            byslug('quotas').status = 'running'
            byslug('gateway').status = 'planned'
          },
          events: [spawnEvent('quotas', member)],
          trussFiles: { 'reports/ratelimit-design/ratelimit-design-qc.md': 'VERDICT: PASS\n\nOk.\n', 'reports/quotas/quotas-qc.md': 'VERDICT: FAIL\n\nNot ok.\n' },
        })
        await page.goto(real.url)
        await expect(page.getByRole('banner').getByRole('heading', { level: 1, name: 'Truss', exact: true })).toBeVisible(LOAD)
        expect(await page.evaluate(() => document.documentElement.lang), 'the page language').toBe('en')

        // Status and verdict are words in the visible text of each crew line, not only in a color or icon.
        const cases: Array<[string, RegExp, RegExp]> = [
          ['ratelimit-design', /done/i, /QC PASS/], // ADR-0028 section 9: merged shows as Done, running as Active
          ['quotas', /active/i, /QC FAIL/],
          ['gateway', /planned/i, /QC none/],
        ]
        for (const [slug, status, verdict] of cases) {
          const line = crewLine(page, slug)
          await expect(line).toBeVisible(LOAD)
          await expect(line).toContainText(status)
          await expect(line).toContainText(verdict)
          if (slug === 'gateway') await expect(line).not.toContainText(/PASS|FAIL/)
        }

        // The layout fits the width: nothing makes the page wider than the window, and the crew lines sit inside it.
        const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, body: document.body.scrollWidth, inner: window.innerWidth }))
        expect(m.client, 'viewport width').toBe(width)
        expect(m.scroll, `scrollWidth ${m.scroll} vs clientWidth ${m.client}`).toBeLessThanOrEqual(m.client)
        expect(m.body, 'body scrollWidth').toBeLessThanOrEqual(m.client)
        for (const [slug] of cases) {
          const box = await crewLine(page, slug).boundingBox()
          expect(box, `${slug} line box`).not.toBeNull()
          expect(box!.x).toBeGreaterThanOrEqual(0)
          expect(box!.x + box!.width, `${slug} line right edge`).toBeLessThanOrEqual(width)
        }

        // ADR-0028 section 10: the crew card lists its agents as cards, with no expand step, and they fit the page width.
        await expect(crewLine(page, 'quotas').getByRole('listitem').filter({ hasText: member })).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        } finally {
          await browser.close()
        }
      })
    }

    // ADR-0023 checklist item 22: each engine paints the tokens.json colours, in both themes.
    test(`D2 colours: in ${browserName} the body is tokens.json bg and the move surface is move, light and dark`, async () => {
      const browser = await launcher.launch()
      try {
        real = await startReal()
        for (const theme of ['light', 'dark'] as const) {
          const page = await browser.newPage({ colorScheme: theme, viewport: { width: 1440, height: 800 } })
          await page.goto(real.url)
          await expect(page.getByRole('banner').getByRole('heading', { level: 1, name: 'Truss', exact: true })).toBeVisible(LOAD)
          await expectD2Colours(page, theme)
          await page.close()
        }
      } finally {
        await browser.close()
      }
    })
  })
}
