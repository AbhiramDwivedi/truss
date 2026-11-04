// The D2 floor behaviours that moves.spec.ts and states.spec.ts leave open (ADR-0023 sections 4 to 6): the stuck
// crew card and its three messages, the artifacts filters, preview and dialog, the stale live counter, the long
// slug in an accessible name, and reduced motion. Role and name queries only; every colour comes from tokens.json.
// Written before the client exists: each test opens on the `Dark theme` toggle and a token colour, which only D2 has.
import { test, expect, type Page } from '@playwright/test'
import { T, LOAD, scenario, openState, token, tokens, WIDTHS, type Theme } from './support.ts'

const PHONE = WIDTHS[0]![1]
const TABLET = WIDTHS[1]![1]
const DESKTOP = WIDTHS[2]![1]
const THEMES: Theme[] = ['light', 'dark']
const LONG_SLUG = 'crew-with-a-very-long-slug-that-must-truncate-but-keep-its-full-name-for-readers'

/** The D2 shell: the theme toggle reflects the theme, body is `bg`, and the one send button is the `move` surface. */
async function d2Shell(page: Page, theme: Theme, opts: { send?: boolean } = {}) {
  expect(tokens.colors.move, 'tokens.json holds move').toBeTruthy()
  await expect(page.getByRole('button', { name: 'Dark theme' })).toHaveAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false', LOAD)
  await expect(page.locator('body')).toHaveCSS('background-color', token('bg', theme), T)
  if (opts.send !== false) {
    const send = page.getByRole('form', { name: 'Message' }).getByRole('button', { name: /^(Start run|Send to PM|Add as new goal|Send answer)/ })
    await expect(send, 'the composer send is the move surface when no card is open').toHaveCSS('background-color', token('move', theme), T)
  }
}

/** The computed animation names of an element and everything under it, found by walking the tree (no selectors). */
async function animationNames(root: ReturnType<Page['getByRole']>, mode: 'self-and-descendants' | 'card-of-button'): Promise<string[]> {
  return root.evaluate((el, how) => {
    let top: Element = el
    if (how === 'card-of-button') {
      // the smallest ancestor that holds the "Stuck, silent" band as well as the button
      while (top.parentElement && !/Stuck, silent/.test(top.textContent ?? '')) top = top.parentElement
    }
    const out: string[] = [getComputedStyle(top).animationName]
    for (const d of Array.from(top.getElementsByTagName('*'))) out.push(getComputedStyle(d).animationName)
    return out
  }, mode)
}

test.describe('floor', () => {
  for (const theme of THEMES) {
    test(`stuck-crew (${theme}): the fail band, Why / How long / Next, Restart builder and the long slug`, async ({ browser }) => {
      const s = await scenario('stuck-crew')
      const o = await openState(browser, s, theme, DESKTOP)
      try {
        const { page } = o
        await d2Shell(page, theme)
        const stuck = s.fixture.run.crews.find((c: any) => c.stuck)
        expect(stuck.slug).toBe(s.apiSlug)
        // ADR-0028 section 10: the StuckCard sits inside the crew's card (an article named by its slug)
        const crews = page.getByRole('region', { name: 'Build network' })
        const line = crews.getByRole('article', { name: new RegExp(`\\b${s.apiSlug}\\b`) })
        await expect(line).toHaveCount(1, LOAD)
        await expect(line.getByText('Stuck', { exact: true }).first()).toBeVisible(T)
        await expect(page.getByText(`Stuck, silent ${stuck.stuck.minutes}m`)).toBeVisible(T)
        for (const term of ['Why', 'How long', 'Next']) await expect(page.getByRole('term').filter({ hasText: new RegExp(`^${term}$`) })).toHaveCount(1, T)
        const restart = crews.getByRole('button', { name: 'Restart builder' })
        await expect(restart).toBeInViewport(T)
        // the stuck primary button is `surface` text on a `fail` fill, in both themes (4.70 light, 6.63 dark)
        await expect(restart, 'Restart builder is filled fail').toHaveCSS('background-color', token('fail', theme), T)
        await expect(restart, 'Restart builder text is surface, not a raw hex').toHaveCSS('color', token('surface', theme), T)
        const long = crews.getByRole('article', { name: new RegExp(LONG_SLUG) })
        expect(LONG_SLUG.length).toBe(80)
        await expect(long, 'the full 80-character slug is in the accessible name').toHaveAccessibleName(new RegExp(LONG_SLUG), T)
        expect(await o.problems()).toEqual([])
      } finally { await o.close(); await s.stop() }
    })
  }

  test('stuck-crew: Restart builder, Re-plan crew and Ask Claude each POST an ordinary message to /api/message', async ({ browser }) => {
    const s = await scenario('stuck-crew')
    const o = await openState(browser, s, 'light', DESKTOP)
    try {
      const { page } = o
      await d2Shell(page, 'light')
      const crews = page.getByRole('region', { name: 'Build network' })
      const line = crews.getByRole('article', { name: new RegExp(`\\b${s.apiSlug}\\b`) })
      await expect(line).toHaveCount(1, LOAD)
      const sends = () => s.iface.calls.filter((c) => c.kind === 'send') as any[]
      for (const label of ['Restart builder', 'Re-plan crew', 'Ask Claude']) {
        const before = sends().length
        const button = crews.getByRole('button', { name: label })
        const posted = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/message', LOAD)
        await button.click()
        const req = await posted
        expect(req.postData() ?? '', `${label} posts a message naming the crew`).toContain(s.apiSlug)
        await expect.poll(() => sends().length, T).toBe(before + 1)
        expect(sends()[before].text, `${label} send names the crew`).toContain(s.apiSlug)
      }
      expect(sends().at(-1).text).toContain(`Crew ${s.apiSlug} is stuck`)
      expect(sends().at(-1).text).toContain('What is happening, and what do you suggest?')
      expect(await o.problems()).toEqual([])
    } finally { await o.close(); await s.stop() }
  })

  for (const [name, width] of [['phone', PHONE], ['tablet', TABLET]] as const) {
    test(`artifacts (${name}): the Deliverable dialog traps focus, Escape closes it and focus returns to the item`, async ({ browser }) => {
      const s = await scenario('artifacts')
      const o = await openState(browser, s, 'dark', width)
      try {
        const { page } = o
        await d2Shell(page, 'dark')
        const list = page.getByRole('list', { name: 'Deliverables' })
        await expect(list).toBeVisible(LOAD)
        const item = list.getByRole('button').first()
        await item.focus()
        await item.click()
        const dialog = page.getByRole('dialog', { name: 'Deliverable' })
        await expect(dialog).toBeVisible(T)
        await expect(dialog).toHaveAttribute('aria-modal', 'true', T)
        await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible(T)
        await expect.poll(() => dialog.evaluate((el) => el.contains(document.activeElement)), T).toBe(true)
        await page.keyboard.press('Tab')
        expect(await dialog.evaluate((el) => el.contains(document.activeElement)), 'Tab stays inside the dialog').toBe(true)
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0, T)
        await expect(item, 'focus returns to the item').toBeFocused(T)
        expect(await o.problems()).toEqual([])
      } finally { await o.close(); await s.stop() }
    })
  }

  for (const theme of THEMES) {
    test(`artifacts (${theme}, desktop): type and group filters, the preview aside, the pending item and the long title`, async ({ browser }) => {
      const s = await scenario('artifacts')
      const o = await openState(browser, s, theme, DESKTOP)
      try {
        const { page } = o
        await d2Shell(page, theme)
        const filter = page.getByRole('group', { name: 'Filter by type' })
        await expect(filter).toBeVisible(LOAD)
        const chips = filter.getByRole('button')
        expect(await chips.count()).toBeGreaterThanOrEqual(2)
        const first = chips.first()
        const before = await first.getAttribute('aria-pressed')
        await first.click()
        await expect(first).not.toHaveAttribute('aria-pressed', before ?? '', T)
        await expect(page.getByRole('group', { name: 'Group by' })).toBeVisible(T)
        await expect(page.getByRole('list', { name: 'Deliverables' }).getByText(/^Arrives when .+ merges\. Nothing to open yet\.$/).first()).toBeVisible(T)
        await expect(page.getByRole('dialog')).toHaveCount(0, T)
        await expect(page.getByRole('complementary', { name: /^Preview: / })).toBeVisible(T)
        const crews = page.getByRole('region', { name: 'Build network' })
        expect(LONG_SLUG.length).toBe(80)
        await expect(crews.getByRole('article', { name: new RegExp(LONG_SLUG) })).toHaveAccessibleName(new RegExp(LONG_SLUG), T)
        expect(await o.problems()).toEqual([])
      } finally { await o.close(); await s.stop() }
    })

    test(`live-counter (${theme}): Run metrics holds cost, tokens table, run time, agents started and crews done n of m, and no limit`, async ({ browser }) => {
      const s = await scenario('live-counter/stale')
      const o = await openState(browser, s, theme, DESKTOP)
      try {
        const { page } = o
        await d2Shell(page, theme)
        // ADR-0028 section 8 (R-43): Run metrics replaces Live metrics; values are derived in the client, so no stamp
        const metrics = page.getByRole('region', { name: 'Run metrics' })
        await expect(metrics).toBeVisible(LOAD)
        await expect(metrics.getByRole('term').filter({ hasText: /cost/i })).toHaveCount(1, T)
        await expect(metrics.getByRole('term').filter({ hasText: /run time/i })).toHaveCount(1, T)
        await expect(metrics.getByRole('term').filter({ hasText: /agents started/i })).toHaveCount(1, T)
        await expect(metrics.getByRole('term').filter({ hasText: /crews done/i })).toHaveCount(1, T)
        await expect(metrics.getByText(/\d+ of \d+/).first(), 'crews done reads n of m').toBeVisible(T)
        await expect(metrics.getByText(/limit|budget|ceiling|of \$/i), 'no limit, budget, ceiling or "of $X"').toHaveCount(0, T)
        await expect(metrics.getByText('not updating')).toHaveCount(0, T)
        expect(await o.problems()).toEqual([])
      } finally { await o.close(); await s.stop() }
    })
  }

  test('live-counter: Run metrics is the one metrics region and Live metrics is gone', async ({ browser }) => {
    const s = await scenario('live-counter')
    const o = await openState(browser, s, 'light', DESKTOP)
    try {
      const { page } = o
      await d2Shell(page, 'light')
      await expect(page.getByRole('region', { name: 'Run metrics' })).toBeVisible(LOAD)
      await expect(page.getByRole('region', { name: 'Live metrics' })).toHaveCount(0, T)
      await expect(page.locator('#run-metrics'), 'the rail header summary links to #run-metrics').toHaveCount(1, T)
      expect(await o.problems()).toEqual([])
    } finally { await o.close(); await s.stop() }
  })

  for (const theme of THEMES) {
    test(`reduced motion (${theme}): stuck-glow and ping compute animation-name none, and run without it`, async ({ browser }) => {
      const s = await scenario('stuck-crew')
      const o = await openState(browser, s, theme, DESKTOP)
      try {
        const { page } = o
        await d2Shell(page, theme)
        const crews = page.getByRole('region', { name: 'Build network' })
        await expect(crews.getByRole('article', { name: new RegExp(`\\b${s.apiSlug}\\b`) })).toHaveCount(1, LOAD)
        const ask = crews.getByRole('button', { name: 'Ask Claude' })
        await expect(ask).toBeVisible(T)
        const moving = await animationNames(ask, 'card-of-button')
        expect(moving.some((n) => n !== 'none'), 'without reduce, the stuck card animates (stuck-glow)').toBe(true)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await expect.poll(async () => (await animationNames(ask, 'card-of-button')).every((n) => n === 'none'), T).toBe(true)
        const all = await page.getByRole('banner').evaluate((el) => Array.from(el.ownerDocument.getElementsByTagName('*')).map((d) => getComputedStyle(d).animationName))
        expect(all.every((n) => n === 'none'), 'under reduce, no element on the page animates').toBe(true)
        expect(await o.problems()).toEqual([])
      } finally { await o.close(); await s.stop() }
    })
  }

  test('reduced motion: the running crew wire and the session ping stop under reduce', async ({ browser }) => {
    const s = await scenario('crews-running')
    const o = await openState(browser, s, 'light', DESKTOP)
    try {
      const { page } = o
      await d2Shell(page, 'light')
      const crews = page.getByRole('region', { name: 'Build network' })
      const running = crews.getByRole('article', { name: new RegExp(`\\b${s.apiSlug}\\b`) })
      await expect(running).toBeVisible(LOAD)
      const page0 = await page.getByRole('banner').evaluate((el) => Array.from(el.ownerDocument.getElementsByTagName('*')).map((d) => getComputedStyle(d).animationName))
      expect(page0.some((n) => n !== 'none'), 'without reduce, running work moves (dash or ping)').toBe(true)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await expect.poll(async () => (await animationNames(running, 'self-and-descendants')).every((n) => n === 'none'), T).toBe(true)
      const all = await page.getByRole('banner').evaluate((el) => Array.from(el.ownerDocument.getElementsByTagName('*')).map((d) => getComputedStyle(d).animationName))
      expect(all.every((n) => n === 'none'), 'under reduce, no element on the page animates').toBe(true)
      expect(await o.problems()).toEqual([])
    } finally { await o.close(); await s.stop() }
  })
})
