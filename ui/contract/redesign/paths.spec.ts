// The non-happy paths ADR-0023 section 4 rules as spec cases, not screenshot states: loading before the first
// snapshot, a send error, an expired token, the idle-foreman stuck crew, a type filter with no items, and the
// 80-character slug cut short in view. Role and name queries only; every colour comes from tokens.json.
// Written before the client exists: each test opens on the `Dark theme` toggle, which only D2 has.
import { test, expect, type Page, type Route } from '@playwright/test'
import { T, LOAD, scenario, openState, token, tokens, typeCounts, WIDTHS, type Theme } from './support.ts'

const PHONE = WIDTHS[0]![1]
const DESKTOP = WIDTHS[2]![1]
const SEND = /^(Start run|Send to PM|Add as new goal|Send answer)$/
const LONG_SLUG = 'crew-with-a-very-long-slug-that-must-truncate-but-keep-its-full-name-for-readers'

/** The D2 banner toggle, in the theme the context set: the first assertion of every test. */
async function d2(page: Page, theme: Theme): Promise<void> {
  expect(tokens.colors.surface, 'tokens.json holds surface').toBeTruthy()
  await expect(page.getByRole('banner').getByRole('button', { name: 'Dark theme' })).toHaveAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false', LOAD)
}

/** Console errors other than the browser's own line for a response the test failed on purpose. */
const unexpected = (lines: string[]) => lines.filter((l) => !/Failed to load resource/.test(l))

test.describe('paths', () => {
  test('loading: with the stream held and no snapshot, Session reads connecting, then the can\'t-reach copy and Retry', async ({ browser }) => {
    const s = await scenario('follow-up')
    const held: Route[] = []
    let hold = true
    const o = await openState(browser, s, 'light', DESKTOP, {
      before: async (page) => {
        await page.route('**/api/events*', async (route) => {
          if (!hold) return route.continue()
          held.push(route) // never answered: the stream stays open with no snapshot
        })
      },
    })
    try {
      const { page } = o
      await d2(page, 'light')
      const status = page.getByRole('status', { name: 'Session' })
      await expect(status, 'before the first snapshot the session is connecting').toHaveText('connecting', T)
      await expect(page.getByRole('article'), 'no card before the first snapshot').toHaveCount(0, T)
      // placeholder blocks, not a spinner: Your move and Crews hold their final heights, busy, before any data
      await expect(page.getByRole('progressbar'), 'no spinner before the first snapshot').toHaveCount(0, T)
      // ADR-0028 section 10: Your move renders only when the session waits on the client, so the placeholder is the network
      await expect(page.getByRole('region', { name: 'Your move' })).toHaveCount(0, T)
      for (const name of ['Build network']) {
        const region = page.getByRole('region', { name })
        await expect(region, `${name} is a placeholder before the first snapshot`).toBeVisible(T)
        await expect(region, `${name} is aria-busy until the snapshot lands`).toHaveAttribute('aria-busy', 'true', T)
        const h = (await region.boundingBox())?.height ?? 0
        expect(h, `${name} holds a non-zero height before the snapshot`).toBeGreaterThan(0)
      }
      // after 10 s with no snapshot
      await expect(status).toHaveText("Can't reach the Truss session. Is truss ui still running?", { timeout: 15000 })
      const retry = page.getByRole('button', { name: 'Retry' })
      await expect(retry).toBeVisible(T)
      hold = false
      await retry.click()
      await expect(page.getByRole('log', { name: 'Transcript' }), 'Retry opens the stream again').toContainText(s.fixture.transcript[0].text, LOAD)
      await expect(status).not.toHaveText(/connecting|Can't reach/, T)
      expect(unexpected(await o.problems())).toEqual([])
    } finally { await o.close(); await s.stop() }
  })

  test('send error: a 500 from POST /api/message shows the Not sent alert, keeps the text and gives the textbox focus', async ({ browser }) => {
    const s = await scenario('follow-up')
    const o = await openState(browser, s, 'light', DESKTOP)
    try {
      const { page } = o
      await d2(page, 'light')
      await page.route('**/api/message', (route) => route.request().method() === 'POST'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) })
        : route.continue())
      const form = page.getByRole('form', { name: 'Message' })
      const box = form.getByRole('textbox', { name: 'Message to the PM', exact: true })
      await box.fill(`a detail that must survive ${s.run}`)
      const posted = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/message', LOAD)
      await form.getByRole('button', { name: SEND }).click()
      expect((await posted).status()).toBe(500)
      const alert = form.getByRole('alert')
      await expect(alert).toHaveText('Not sent: boom. Your text is still here.', T)
      await expect(box, 'the textbox keeps its value').toHaveValue(`a detail that must survive ${s.run}`, T)
      await expect(box, 'focus goes back to the textbox').toBeFocused(T)
      await expect(box, 'the textbox is described by the alert').toHaveAccessibleDescription('Not sent: boom. Your text is still here.', T)
      expect(unexpected(await o.problems())).toEqual([])
    } finally { await o.close(); await s.stop() }
  })

  test('expired token: a 401 {"error":"token"} reads Session link expired, and the composer keeps its text, disabled', async ({ browser }) => {
    const s = await scenario('follow-up')
    const o = await openState(browser, s, 'dark', DESKTOP)
    try {
      const { page } = o
      await d2(page, 'dark')
      await page.route('**/api/message', (route) => route.request().method() === 'POST'
        ? route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'token' }) })
        : route.continue())
      const form = page.getByRole('form', { name: 'Message' })
      const box = form.getByRole('textbox', { name: 'Message to the PM', exact: true })
      await box.fill(`kept after the link expired ${s.run}`)
      await form.getByRole('button', { name: SEND }).click()
      await expect(page.getByRole('status', { name: 'Session' })).toHaveText('Session link expired. Open the link truss ui printed again.', T)
      await expect(box, 'the composer keeps its text').toHaveValue(`kept after the link expired ${s.run}`, T)
      await expect(box, 'the composer is disabled on a dead link').toBeDisabled(T)
      await expect(page.locator('body')).toHaveCSS('background-color', token('bg', 'dark'), T)
      expect(unexpected(await o.problems())).toEqual([])
    } finally { await o.close(); await s.stop() }
  })

  for (const theme of ['light', 'dark'] as Theme[]) {
    test(`stuck-crew idle-foreman (${theme}): stuck: foreman idle <n> min, and Start a successor foreman sends its message`, async ({ browser }) => {
      const s = await scenario('stuck-crew/idle-foreman')
      const o = await openState(browser, s, theme, DESKTOP)
      try {
        const { page } = o
        await d2(page, theme)
        const stuck = s.fixture.run.crews.find((c: any) => c.stuck)
        expect(stuck.stuck.kind).toBe('idle-foreman')
        // ADR-0028 sections 9 and 10: the crew is an article named by its slug, with the Stuck StatusBadge
        const crews = page.getByRole('region', { name: 'Build network' })
        const line = crews.getByRole('article', { name: new RegExp(`\\b${s.apiSlug}\\b`) })
        await expect(line).toHaveCount(1, LOAD)
        await expect(line.getByText('Stuck', { exact: true }).first()).toBeVisible(T)
        await expect(line.getByText(new RegExp(`foreman idle ${stuck.stuck.minutes} min`)).first()).toBeVisible(T)
        await expect(crews.getByText(/stuck: stalled/), 'an idle foreman is not worded as a stalled agent').toHaveCount(0, T)
        const successor = crews.getByRole('button', { name: 'Start a successor foreman' })
        await expect(successor).toBeVisible(T)
        await expect(successor, 'the primary button is filled fail').toHaveCSS('background-color', token('fail', theme), T)
        await expect(successor, 'its text is surface').toHaveCSS('color', token('surface', theme), T)
        await expect(crews.getByRole('button', { name: 'Restart builder' }), 'no Restart builder for an idle foreman').toHaveCount(0, T)
        for (const name of ['Re-plan crew', 'Ask Claude']) await expect(crews.getByRole('button', { name })).toBeVisible(T)
        const sends = () => s.iface.calls.filter((c) => c.kind === 'send') as any[]
        const before = sends().length
        await successor.click()
        await expect.poll(() => sends().length, T).toBe(before + 1)
        expect(sends()[before].text).toBe(`Crew ${s.apiSlug} is stuck: ${stuck.stuck.detail}. Start a successor foreman for it.`)
        expect(await o.problems()).toEqual([])
      } finally { await o.close(); await s.stop() }
    })
  }

  test('stuck-crew, a stalled tester: the primary reads Restart tester, from the stalled agent\'s role, and sends its message', async ({ browser }) => {
    const s = await scenario('stuck-crew', {
      edit: (f, apiSlug) => {
        const crew = f.run.crews.find((c: any) => c.stuck)
        crew.stuck.detail = `${apiSlug}-tester stalled 15 min`
        for (const m of crew.members) if (m.state === 'stalled') m.name = `${apiSlug}-tester`
      },
    })
    const o = await openState(browser, s, 'light', DESKTOP)
    try {
      const { page } = o
      await d2(page, 'light')
      const stuck = s.fixture.run.crews.find((c: any) => c.stuck)
      expect(stuck.stuck.detail, 'the planted detail is quota-api-tester stalled 15 min').toBe(`${s.apiSlug}-tester stalled 15 min`)
      const crews = page.getByRole('region', { name: 'Build network' })
      const line = crews.getByRole('article', { name: new RegExp(`\\b${s.apiSlug}\\b`) })
      await expect(line).toHaveCount(1, LOAD)
      const primary = crews.getByRole('button', { name: 'Restart tester', exact: true })
      await expect(primary, 'the label follows the last hyphen segment of the stalled agent').toBeVisible(T)
      await expect(primary).toHaveCSS('background-color', token('fail', 'light'), T)
      await expect(crews.getByRole('button', { name: 'Restart builder' }), 'no hard-coded Restart builder').toHaveCount(0, T)
      const sends = () => s.iface.calls.filter((c) => c.kind === 'send') as any[]
      const before = sends().length
      await primary.click()
      await expect.poll(() => sends().length, T).toBe(before + 1)
      expect(sends()[before].text).toBe(`Crew ${s.apiSlug} is stuck: ${stuck.stuck.detail}. Restart its tester.`)
      expect(await o.problems()).toEqual([])
    } finally { await o.close(); await s.stop() }
  })

  test('live-counter: Run metrics derives its values in the client, with no live stamp and no rate', async ({ browser }) => {
    const s = await scenario('live-counter')
    const o = await openState(browser, s, 'light', DESKTOP)
    try {
      const { page } = o
      await d2(page, 'light')
      // ADR-0028 section 8 (R-43): five values, the tokens in a per-model table, nothing stamped "as of"
      const metrics = page.getByRole('region', { name: 'Run metrics' })
      await expect(metrics).toBeVisible(LOAD)
      for (const re of [/cost/i, /run time/i, /agents started/i, /crews done/i]) await expect(metrics.getByRole('term').filter({ hasText: re })).toHaveCount(1, T)
      await expect(metrics.getByRole('table').getByRole('columnheader')).toHaveCount(5, T)
      await expect(metrics.getByText(/as of \d\d:\d\d/)).toHaveCount(0, T)
      await expect(metrics.getByText('/min')).toHaveCount(0, T)
      await expect(metrics.getByText(/limit|budget|ceiling|of \$/i)).toHaveCount(0, T)
      expect(await o.problems()).toEqual([])
    } finally { await o.close(); await s.stop() }
  })

  test('artifacts, zero results: a type filter with no items reads No images yet., and Show all types resets it', async ({ browser }) => {
    const s = await scenario('artifacts/no-images')
    const o = await openState(browser, s, 'light', DESKTOP)
    try {
      const { page } = o
      await d2(page, 'light')
      const filter = page.getByRole('group', { name: 'Filter by type' })
      await expect(filter).toBeVisible(LOAD)
      for (const name of ['All', 'Docs', 'Code', 'Plan', 'Images']) await expect(filter.getByRole('button', { name: new RegExp(`^${name}\\b`) })).toHaveCount(1, T)
      const counts = typeCounts(s.fixture)
      expect(counts.Images, 'no-images.json has no images').toBe(0)
      for (const [name, n] of Object.entries(counts)) {
        await expect(filter.getByRole('button', { name: new RegExp(`^${name}\\b`) }), `the ${name} chip counts ${n}`).toHaveAccessibleName(new RegExp(`^${name}\\b.*\\b${n}\\b`), T)
      }
      const images = filter.getByRole('button', { name: /^Images\b/ })
      await expect(images, 'the Images chip counts 0').toHaveAccessibleName(/\b0\b/, T)
      const list = page.getByRole('list', { name: 'Deliverables' })
      await expect(list.getByRole('listitem').first()).toBeVisible(T)
      await images.click()
      await expect(images).toHaveAttribute('aria-pressed', 'true', T)
      await expect(page.getByText('No images yet.', { exact: true })).toBeVisible(T)
      const reset = page.getByRole('button', { name: 'Show all types' })
      await expect(reset).toBeVisible(T)
      await reset.click()
      await expect(filter.getByRole('button', { name: /^All\b/ }), 'Show all types presses All again').toHaveAttribute('aria-pressed', 'true', T)
      await expect(images).toHaveAttribute('aria-pressed', 'false', T)
      await expect(page.getByText('No images yet.', { exact: true })).toHaveCount(0, T)
      await expect(list.getByRole('listitem').first(), 'the items are back').toBeVisible(T)
      expect(await o.problems()).toEqual([])
    } finally { await o.close(); await s.stop() }
  })

  test('stuck-crew, long slug at phone width: the 80-character slug is cut short with an ellipsis, on one line', async ({ browser }) => {
    const s = await scenario('stuck-crew')
    const o = await openState(browser, s, 'light', PHONE)
    try {
      const { page } = o
      await d2(page, 'light')
      expect(LONG_SLUG.length).toBe(80)
      const button = page.getByRole('region', { name: 'Build network' }).getByRole('article', { name: new RegExp(LONG_SLUG) })
      await expect(button, 'the full slug is in the accessible name').toHaveAccessibleName(new RegExp(LONG_SLUG), LOAD)
      const text = button.getByText(LONG_SLUG, { exact: true }).first()
      await expect(text).toBeVisible(T)
      await expect(text, 'the slug truncates with an ellipsis').toHaveCSS('text-overflow', 'ellipsis', T)
      const m = await text.evaluate((el) => {
        const st = getComputedStyle(el)
        const lh = st.lineHeight === 'normal' ? 1.2 * parseFloat(st.fontSize) : parseFloat(st.lineHeight)
        return { scroll: el.scrollWidth, client: el.clientWidth, height: el.getBoundingClientRect().height, lh }
      })
      expect(m.scroll, `the slug is cut short in view: scrollWidth ${m.scroll} > clientWidth ${m.client}`).toBeGreaterThan(m.client)
      expect(m.height, 'the slug stays on one line').toBeLessThanOrEqual(2 * m.lh)
      const fit = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth])
      expect(fit[0], 'the long slug never widens the phone page').toBeLessThanOrEqual(fit[1]!)
      expect(await o.problems()).toEqual([])
    } finally { await o.close(); await s.stop() }
  })
})
