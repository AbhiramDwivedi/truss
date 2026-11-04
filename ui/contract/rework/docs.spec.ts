// Contract for the ADR, deliverables and architecture-preview area (ADR-0028 sections 3, 4, 5, 10; R-37, R-38, R-39,
// R-46, R-47), written from the spec before rework-docs builds it. Elements are reached by role and name. Layout
// placement (tabs gone, column order) belongs to page.spec.ts and is not asserted here.
import { test, expect, type Browser, type Page } from '@playwright/test'
import { T, LOAD, WIDTHS, openFixture } from './support.ts'

const DESKTOP = WIDTHS.desktop
const PHONE = WIDTHS.phone
const timeline = (page: Page) => page.getByRole('region', { name: 'Decisions and ADRs' })
const deliverables = (page: Page) => page.getByRole('region', { name: 'Built artifacts and deliverables' })

/** Console and CSP lines other than mermaid's own inserted <style> (ADR-0028 consequences, section 5). */
const unexpected = (lines: string[]) => lines.filter((l) => !/Failed to load resource/.test(l) && !/style-src/.test(l))

async function openArchitecture(browser: Browser, width = DESKTOP, opts: { edit?: (s: any) => void; before?: (p: Page) => Promise<void> } = {}) {
  const o = await openFixture(browser, 'architecture', 'light', width, opts)
  await expect(deliverables(o.page)).toBeVisible(LOAD)
  await deliverables(o.page).getByRole('button', { name: /Architecture/ }).first().click()
  return o
}

test.describe('R-37 ADRs live in one place', () => {
  test('R-37: the timeline lists the ADRs, and Deliverables holds no ADR item (F3)', async ({ browser }) => {
    const o = await openFixture(browser, 'live', 'light', DESKTOP)
    try {
      const { page } = o
      await expect(timeline(page)).toBeVisible(LOAD)
      for (const a of o.planted.fixture.adrs) {
        const plain = a.title.replace(/^ADR-\d+\s*[:\-–—]\s*/i, '')
        await expect(timeline(page).getByText(plain).first(), `the timeline lists ${a.title}`).toBeVisible(T)
        await expect(deliverables(page).getByText(plain), `Deliverables holds no item for ${a.title}`).toHaveCount(0, T)
        await expect(deliverables(page).getByText(a.file), `Deliverables holds no path ${a.file}`).toHaveCount(0, T)
      }
    } finally { await o.stop() }
  })

  test('R-37: the timeline is also the only ADR list at 12 crews (F4)', async ({ browser }) => {
    const o = await openFixture(browser, 'real-12', 'light', DESKTOP)
    try {
      const { page } = o
      await expect(timeline(page)).toBeVisible(LOAD)
      const first = o.planted.fixture.adrs[0]
      test.skip(!first, 'the fixture has no ADR')
      const plain = first.title.replace(/^ADR-\d+\s*[:\-–—]\s*/i, '')
      await expect(timeline(page).getByText(plain).first()).toBeVisible(T)
      await expect(deliverables(page).getByText(plain)).toHaveCount(0, T)
    } finally { await o.stop() }
  })

  test('R-37: with no ADRs or decisions the timeline says so and offers no action (F1)', async ({ browser }) => {
    const o = await openFixture(browser, 'no-run', 'light', DESKTOP)
    try {
      const { page } = o
      await expect(timeline(page).getByText(/No ADRs or decisions yet\. They appear here as the design engineer records them\./)).toBeVisible(LOAD)
      await expect(timeline(page).getByRole('button'), 'the empty timeline has no action').toHaveCount(0, T)
    } finally { await o.stop() }
  })

  test('R-37: a status filter with no match shows "No items match this filter." and Show all restores the list', async ({ browser }) => {
    const o = await openFixture(browser, 'architecture', 'light', DESKTOP, {
      edit: (s) => { s.adrs = [{ file: '0001-one.md', title: 'ADR-0001: Keep one list', status: 'accepted, 2026-10-20', number: 1, date: '2026-10-20', decidedBy: 'the client', links: [], summary: 'One list.' }] },
    })
    try {
      const { page } = o
      await expect(timeline(page).getByText('Keep one list').first()).toBeVisible(LOAD)
      await timeline(page).getByRole('button', { name: /Rejected/i }).first().click()
      await expect(timeline(page).getByText('No items match this filter.')).toBeVisible(T)
      await timeline(page).getByRole('button', { name: 'Show all' }).click()
      await expect(timeline(page).getByText('Keep one list').first()).toBeVisible(T)
      await expect(timeline(page).getByText('No items match this filter.')).toHaveCount(0, T)
    } finally { await o.stop() }
  })

  test('R-37: a 200-character ADR title clamps to 2 lines and the full title shows on hover and focus (F8)', async ({ browser }) => {
    const o = await openFixture(browser, 'long', 'light', DESKTOP)
    try {
      const { page } = o
      const full: string = o.planted.fixture.adrs[0].title
      expect(full.length).toBe(200)
      const plain = full.replace(/^ADR-\d+\s*[:\-–—]\s*/i, '')
      const item = timeline(page).getByText(plain.slice(0, 40)).first()
      await expect(item).toBeVisible(LOAD)
      const lines = await item.evaluate((el) => {
        const cs = getComputedStyle(el)
        const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4
        return Math.round(el.getBoundingClientRect().height / lh)
      })
      expect(lines, 'the title takes at most two lines').toBeLessThanOrEqual(2)
      // the full title is reachable: the title attribute on the item or its focusable ancestor
      const titled = timeline(page).locator(`[title="${full}"], [title="${plain}"]`).first()
      await expect(titled, 'the full title is in a title attribute').toHaveCount(1, T)
      // focus: the timeline item that opens this ADR takes focus and is named by the full title
      const opener = timeline(page).getByRole('button', { name: new RegExp(plain.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first()
      await opener.focus()
      await expect(opener, 'the ADR item takes focus').toBeFocused(T)
      await expect(opener, 'the full title is announced on focus').toHaveAccessibleName(new RegExp(plain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth), 'no horizontal page scroll').toBe(true)
    } finally { await o.stop() }
  })

  test('R-37: with nothing built, Deliverables says so (F1)', async ({ browser }) => {
    const o = await openFixture(browser, 'no-run', 'light', DESKTOP)
    try {
      await expect(deliverables(o.page).getByText('Nothing built yet. Deliverables appear as crews finish.')).toBeVisible(LOAD)
    } finally { await o.stop() }
  })

  test('R-37: a type filter with no match shows "No deliverables of this type." and Show all (F3)', async ({ browser }) => {
    const o = await openFixture(browser, 'live', 'light', DESKTOP)
    try {
      const { page } = o
      await expect(deliverables(page)).toBeVisible(LOAD)
      await deliverables(page).getByRole('button', { name: /^Images/ }).click()
      await expect(deliverables(page).getByText('No deliverables of this type.')).toBeVisible(T)
      await deliverables(page).getByRole('button', { name: 'Show all' }).click()
      await expect(deliverables(page).getByText('No deliverables of this type.')).toHaveCount(0, T)
    } finally { await o.stop() }
  })
})

test.describe('R-38 mermaid diagrams', () => {
  test('R-38: Architecture is the first deliverable', async ({ browser }) => {
    const o = await openFixture(browser, 'architecture', 'light', DESKTOP)
    try {
      const items = deliverables(o.page).getByRole('button', { name: /Architecture/ })
      await expect(items.first()).toBeVisible(LOAD)
      await expect(items, 'one architecture item, never a list of versions').toHaveCount(1, T)
    } finally { await o.stop() }
  })

  test('R-38: the valid block is an SVG with role img in a focusable figure labelled "Diagram 1 of 2", with Show source (F7)', async ({ browser }) => {
    const o = await openArchitecture(browser)
    try {
      const { page } = o
      const fig = page.getByRole('figure', { name: 'Diagram 1 of 2' })
      await expect(fig).toBeVisible(LOAD)
      await expect(fig).toHaveAttribute('tabindex', '0')
      const svg = fig.getByRole('img', { name: /^Diagram: / })
      await expect(svg).toBeVisible(T)
      expect(await svg.evaluate((el) => el.tagName.toLowerCase()), 'the img is the svg').toBe('svg')
      await fig.focus()
      await expect(fig).toBeFocused()
      await page.getByRole('button', { name: 'Show source' }).first().click()
      await expect(page.getByText('Client --> PM').first(), 'the source is the text alternative').toBeVisible(T)
      expect(unexpected(await o.problems())).toEqual([])
    } finally { await o.stop() }
  })

  test('R-38: the block that fails to parse shows its source in a pre under "This diagram couldn\'t be drawn: <error line>" (F7)', async ({ browser }) => {
    const o = await openArchitecture(browser)
    try {
      const { page } = o
      const note = page.getByText(/^This diagram couldn't be drawn: .+/)
      await expect(note).toBeVisible(LOAD)
      expect((await note.innerText()).trim().split('\n').length, 'the note is one line (the first line of the error)').toBe(1)
      const pre = page.locator('pre', { hasText: 'PM ==>> [' })
      await expect(pre).toBeVisible(T)
      await expect(page.getByRole('figure', { name: 'Diagram 2 of 2' }), 'the failed block is not a drawn figure').toHaveCount(0, T)
    } finally { await o.stop() }
  })

  test('R-38: each block holds a 160 px "Drawing diagram…" placeholder and the figure takes its place without a jump', async ({ browser }) => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const o = await openArchitecture(browser, DESKTOP, {
      before: async (page) => { await page.route(/mermaid/i, async (route) => { await gate; await route.continue() }) },
    })
    try {
      const { page } = o
      const ph = page.getByText('Drawing diagram…')
      await expect(ph).toHaveCount(2, LOAD)
      const first = ph.first()
      const box = (await first.boundingBox())!
      expect(Math.round(box.height), 'the placeholder block is 160 px').toBe(160)
      const heading = page.getByRole('heading', { name: 'Modules' })
      const before = (await heading.boundingBox())!.y
      release()
      await expect(page.getByRole('figure', { name: 'Diagram 1 of 2' })).toBeVisible(LOAD)
      await expect(page.getByText('Drawing diagram…')).toHaveCount(0, T)
      const after = (await heading.boundingBox())!.y
      expect(Math.abs(after - before), 'content below the diagrams moves by under 40 px when they are drawn').toBeLessThan(40)
    } finally { release(); await o.stop() }
  })

  test('R-38: if the mermaid chunk fails to load, every block shows its source with the fallback line', async ({ browser }) => {
    const o = await openArchitecture(browser, DESKTOP, {
      before: async (page) => { await page.route(/mermaid/i, (route) => route.abort()) },
    })
    try {
      const { page } = o
      await expect(page.getByText("Diagrams couldn't load, so their source is shown.").first()).toBeVisible(LOAD)
      await expect(page.locator('pre', { hasText: 'Client --> PM' })).toBeVisible(T)
      await expect(page.locator('pre', { hasText: 'PM ==>> [' })).toBeVisible(T)
    } finally { await o.stop() }
  })

  test('R-38: at 360 px a wide diagram scrolls inside its figure, not the page', async ({ browser }) => {
    const wide = 'flowchart LR\n' + Array.from({ length: 24 }, (_, i) => `  N${i}[Step number ${i}] --> N${i + 1}[Step number ${i + 1}]`).join('\n')
    const o = await openArchitecture(browser, PHONE, {
      edit: (s) => { s.design.architecture.markdown = `# Architecture\n\n## Overview\n\n\`\`\`mermaid\n${wide}\n\`\`\`\n` },
    })
    try {
      const { page } = o
      const fig = page.getByRole('figure', { name: 'Diagram 1 of 1' })
      await expect(fig).toBeVisible(LOAD)
      const m = await fig.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX }))
      expect(m.sw, 'the diagram is wider than the figure').toBeGreaterThan(m.cw)
      expect(['auto', 'scroll']).toContain(m.ox)
      expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth), 'no horizontal page scroll').toBe(true)
    } finally { await o.stop() }
  })
})

test.describe('R-39 only the latest architecture', () => {
  test('R-39: sections titled Change log or History, and their content, are not shown (F7)', async ({ browser }) => {
    const o = await openArchitecture(browser)
    try {
      const { page } = o
      await expect(page.getByRole('heading', { name: 'Modules' }), 'other sections stay').toBeVisible(LOAD)
      await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible(T)
      await expect(page.getByRole('heading', { name: /change ?log/i })).toHaveCount(0, T)
      await expect(page.getByRole('heading', { name: /history/i })).toHaveCount(0, T)
      await expect(page.getByText(/Zebra/)).toHaveCount(0, T)
      await expect(page.getByText(/Quokka/)).toHaveCount(0, T)
    } finally { await o.stop() }
  })

  test('R-39: a "Versions" heading drops its section up to the next heading of the same or higher level, and no more', async ({ browser }) => {
    const o = await openArchitecture(browser, DESKTOP, {
      edit: (s) => { s.design.architecture.markdown = '# Architecture\n\n## Versions\n\nVersionsBody text.\n\n### Detail\n\nNestedBody text.\n\n## Kept\n\nKeptBody text.\n' },
    })
    try {
      const { page } = o
      await expect(page.getByRole('heading', { name: 'Kept' })).toBeVisible(LOAD)
      await expect(page.getByText('KeptBody text.')).toBeVisible(T)
      await expect(page.getByRole('heading', { name: 'Versions' })).toHaveCount(0, T)
      await expect(page.getByText('VersionsBody text.')).toHaveCount(0, T)
      await expect(page.getByText('NestedBody text.'), 'a deeper heading under the dropped one goes with it').toHaveCount(0, T)
    } finally { await o.stop() }
  })
})

test.describe('R-47 the reply turn in the timeline', () => {
  test('R-47: a reply that is not an approval ask is worded "The PM replied", with no Approve or Deny (F5)', async ({ browser }) => {
    const o = await openFixture(browser, 'reply-open', 'light', DESKTOP)
    try {
      const { page } = o
      await expect(timeline(page).getByText('The PM replied').first()).toBeVisible(LOAD)
      await expect(timeline(page).getByText('Reply needed')).toHaveCount(0, T)
      await expect(timeline(page).getByRole('button', { name: /^(Approve|Deny)/ })).toHaveCount(0, T)
    } finally { await o.stop() }
  })

  test('R-47: an approval ask is worded "Approval needed" in the timeline (F6)', async ({ browser }) => {
    const o = await openFixture(browser, 'approval-ask', 'light', DESKTOP)
    try {
      const { page } = o
      await expect(timeline(page).getByText('Approval needed').first()).toBeVisible(LOAD)
      await expect(timeline(page).getByText('Reply needed')).toHaveCount(0, T)
    } finally { await o.stop() }
  })
})

test.describe('R-46 wording', () => {
  test('R-46: the rail list and the deliverables section carry the sentence-case names of ADR-0028', async ({ browser }) => {
    const o = await openFixture(browser, 'live', 'light', DESKTOP)
    try {
      const { page } = o
      await expect(page.getByRole('heading', { name: 'Decisions and ADRs' })).toBeVisible(LOAD)
      await expect(page.getByRole('heading', { name: 'Built artifacts and deliverables' })).toBeVisible(T)
      await expect(page.getByRole('heading', { name: /Decisions And ADRs|Built Artifacts/ })).toHaveCount(0, T)
    } finally { await o.stop() }
  })
})
