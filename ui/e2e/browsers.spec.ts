// R-17: current desktop browsers at 1024 px and up. The same checks run in chromium, firefox and webkit
// (Safari's engine) at widths 1024 and 1440. Edge is Chromium: it has no engine of its own to test, so the
// chromium run stands for Edge too. ui/playwright.config.ts is not ours, and Playwright refuses
// test.use({ browserName }) inside a describe, so each test launches its own browser from the chromium,
// firefox or webkit launcher and opens its own page at the width. Status and verdict are asserted as visible text, so color alone
// cannot pass. Written before ui/web exists: every test fails now on the missing page.
import { test, expect, chromium, firefox, webkit, type Page } from '@playwright/test'
import { rand, spawnEvent, startReal, type Real } from './harness.ts'

const LOAD = { timeout: 10000 }
const WIDTHS = [1024, 1440]
const BROWSERS = [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]] as const

let real: Real | undefined
test.afterEach(async () => {
  await real?.stop()
  real = undefined
})

const crewLine = (page: Page, slug: string) => page.getByRole('button', { name: new RegExp(`\\b${slug}\\b`, 'i') }).first()

for (const [browserName, launcher] of BROWSERS) {
  test.describe(`${browserName}${browserName === 'chromium' ? ' (also Edge)' : ''}`, () => {
    for (const width of WIDTHS) {
      test(`R-17: at ${width} px the page loads, has no horizontal scrollbar, and shows each crew status and verdict as text`, async () => {
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
        await expect(page.locator('html')).toHaveAttribute('lang', 'en', LOAD)

        // Status and verdict are words in the visible text of each crew line, not only in a color or icon.
        const cases: Array<[string, RegExp, RegExp | null]> = [
          ['ratelimit-design', /merged/i, /PASS/],
          ['quotas', /running/i, /FAIL/],
          ['gateway', /planned/i, null],
        ]
        for (const [slug, status, verdict] of cases) {
          const line = crewLine(page, slug)
          await expect(line).toBeVisible(LOAD)
          await expect(line).toContainText(status)
          if (verdict) await expect(line).toContainText(verdict)
          else await expect(line).not.toContainText(/PASS|FAIL/)
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

        // Opening a line adds a member line without widening the page.
        await crewLine(page, 'quotas').click()
        await expect(page.getByText(member).first()).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        } finally {
          await browser.close()
        }
      })
    }
  })
}
