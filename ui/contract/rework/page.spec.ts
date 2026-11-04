// The page contract of the rework (ADR-0028 sections 8, 9 and 10; the UX direction's checklist items 1 to 5 and 40
// to 49): placement and layout of the shell, the run status, the Run metrics section, tokens, accessibility and
// responsive widths. Written before rework-page builds it, so every case fails today at an assertion about the
// new layout (the tabs, the missing Run metrics section, the missing run status). Each case plants a fixture from
// fixtures/rework/<state>/ into the fake interface (ui/e2e/harness.ts, port 0) and reaches the page by role and
// accessible name only. Names this spec pins beyond ADR-0028: status "Run status" (the rail header's RunStatusBadge),
// log "Conversation with the PM", form "Message", regions "Build network", "Decisions and ADRs", a region whose
// name has "deliverables", and region "Run metrics" holding the h2 of the same name.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test, expect, type Locator, type Page, type Route } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { WIDTHS, THEMES, T, LOAD, openFixture, type Theme } from './support.ts'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const FORBIDDEN = /\b(limit|budget|ceiling)\b|of \$/i
const SEND = /^(Start run|Send to PM|Add as new goal|Send answer)$/

const network = (p: Page) => p.getByRole('region', { name: 'Build network', exact: true })
const timeline = (p: Page) => p.getByRole('region', { name: 'Decisions and ADRs', exact: true })
const deliverables = (p: Page) => p.getByRole('region', { name: /deliverables/i })
const metrics = (p: Page) => p.getByRole('region', { name: 'Run metrics', exact: true })
const composer = (p: Page) => p.getByRole('form', { name: 'Message', exact: true })
const thread = (p: Page) => p.getByRole('log', { name: 'Conversation with the PM', exact: true })
const runStatus = (p: Page) => p.getByRole('status', { name: 'Run status', exact: true })
const yourMove = (p: Page) => p.getByRole('region', { name: 'Your move', exact: true })

const inMain = (l: Locator) => l.evaluate((el) => el.closest('main') !== null)
const box = async (l: Locator) => {
  const b = await l.boundingBox()
  if (!b) throw new Error('no bounding box (not rendered)')
  return b
}
const noSideScroll = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

// One text line: every client rect of the element's contents shares one top.
const oneLine = (l: Locator) => l.evaluate((el) => {
  const r = document.createRange()
  r.selectNodeContents(el)
  return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size <= 1 && el.scrollWidth <= el.clientWidth + 1
})

async function hold(page: Page, held: Route[], on: { v: boolean }): Promise<void> {
  await page.route('**/api/events*', async (route) => { if (on.v) held.push(route); else await route.continue() })
}

test.describe('page', () => {
  test('R-36: F3 at 1440 px: the rail holds header, Target repository, thread, composer, Decisions and ADRs; main holds the network, deliverables, metrics; no tabs', async ({ browser }) => {
    const o = await openFixture(browser, 'live', 'light', WIDTHS.wide)
    try {
      const { page } = o
      await expect(network(page)).toBeVisible(LOAD)
      await expect(page.getByRole('tab'), 'no Crews, Decisions or Design tabs').toHaveCount(0, T)
      await expect(page.getByRole('tablist')).toHaveCount(0, T)
      const rail = [runStatus(page), page.getByText('Target repository', { exact: true }), thread(page), composer(page), timeline(page)]
      let y = -1
      for (const l of rail) {
        await expect(l).toBeVisible(T)
        expect(await inMain(l), 'a rail item is outside main').toBe(false)
        const b = await box(l)
        expect(b.x + b.width, 'the rail is 400 px wide').toBeLessThanOrEqual(401)
        expect(b.y, 'rail order: header, repository, thread, composer, decisions').toBeGreaterThan(y)
        y = b.y
      }
      const heads = [network(page), deliverables(page), metrics(page)]
      let my = -1
      for (const l of heads) {
        await expect(l).toBeVisible(T)
        expect(await inMain(l), 'a work area is inside main').toBe(true)
        const b = await box(l)
        expect(b.x, 'main sits beside the rail').toBeGreaterThanOrEqual(399)
        expect(b.y, 'main order: network, deliverables, run metrics').toBeGreaterThan(my)
        my = b.y
      }
      expect(await inMain(timeline(page)), 'ADRs are listed in the rail only').toBe(false)
      expect(await noSideScroll(page)).toBe(true)
      expect(await o.problems()).toEqual([])
    } finally { await o.stop() }
  })

  test('R-36: F3 at 768 px: one column, in order run status, Your move, conversation, network, deliverables, metrics, Decisions and ADRs', async ({ browser }) => {
    const o = await openFixture(browser, 'reply-open', 'light', WIDTHS.tablet)
    try {
      const { page } = o
      await expect(yourMove(page)).toBeVisible(LOAD)
      const order = [runStatus(page), yourMove(page), thread(page), composer(page), network(page), deliverables(page), metrics(page), timeline(page)]
      const ys: number[] = []
      for (const l of order) { await expect(l).toBeVisible(T); ys.push((await box(l)).y) }
      expect(ys, 'the visual order is the specified order').toEqual([...ys].sort((a, b) => a - b))
      // below 1024 px the DOM order is the visual order (no `order` that breaks the tab sequence)
      const handles = await Promise.all(order.map((l) => l.elementHandle()))
      const domOk = await page.evaluate((els) => els.every((e, i) => i === 0 || !!(els[i - 1]!.compareDocumentPosition(e!) & Node.DOCUMENT_POSITION_FOLLOWING)), handles)
      expect(domOk, 'the DOM order matches the visual order').toBe(true)
      const b = await box(thread(page))
      expect(b.height, 'the thread is capped at 50vh').toBeLessThanOrEqual(450 + 1)
      expect(await noSideScroll(page)).toBe(true)
    } finally { await o.stop() }
  })

  test('R-36: 12 crews at 1440 px sit 3 to a stage row and at 768 px 2 to a row, with no sideways scroll at 1440, 768 and 360 px', async ({ browser }) => {
    for (const [width, perRow] of [[WIDTHS.wide, 3], [WIDTHS.tablet, 2], [WIDTHS.phone, 1]] as const) {
      const o = await openFixture(browser, 'real-12', 'light', width)
      try {
        const { page } = o
        await expect(network(page).getByRole('article').first()).toBeVisible(LOAD)
        const cards = await network(page).getByRole('article').evaluateAll((els) => els
          .filter((e) => e.parentElement?.closest('[role="article"], article') === null)
          .map((e) => Math.round(e.getBoundingClientRect().top)))
        const counts = new Map<number, number>()
        for (const t of cards) counts.set(t, (counts.get(t) ?? 0) + 1)
        expect(Math.max(...counts.values()), `crews per row at ${width}px`).toBe(perRow)
        expect(await noSideScroll(page), `no sideways scroll at ${width}px`).toBe(true)
      } finally { await o.stop() }
    }
  })

  test('R-45: F9: the thread is a log in the rail above the composer, the four newest messages show without scrolling the page', async ({ browser }) => {
    const o = await openFixture(browser, 'thread', 'light', WIDTHS.wide)
    try {
      const { page } = o
      const log = thread(page)
      await expect(log).toBeVisible(LOAD)
      expect(await inMain(log)).toBe(false)
      await expect(log).toHaveAttribute('aria-live', 'polite', T)
      const lb = await box(log)
      const cb = await box(composer(page))
      expect(lb.y + lb.height, 'the thread sits above the composer').toBeLessThanOrEqual(cb.y + 1)
      const scrollY = await page.evaluate(() => window.scrollY)
      expect(scrollY).toBe(0)
      const msgs = log.getByRole('article')
      const n = await msgs.count()
      expect(n, 'the thread renders at most 50 messages first').toBeLessThanOrEqual(50)
      for (let i = n - 4; i < n; i++) {
        const b = await box(msgs.nth(i))
        expect(b.y + b.height, `newest message ${i} is in the viewport`).toBeLessThanOrEqual(900)
        expect(b.y).toBeGreaterThanOrEqual(0)
      }
    } finally { await o.stop() }
  })

  test('R-45: the four newest thread messages are in view on load', async ({ browser }) => {
    const o = await openFixture(browser, 'thread', 'light', WIDTHS.desktop)
    try {
      const log = thread(o.page)
      await expect(log).toBeVisible(LOAD)
      for (const text of [
        'Add CSV export to the reports page.',
        'On it. I will plan two crews and start the first now.',
        'Also make it respect the date filter.',
        'Noted: the export will use the same date filter as the page.',
      ]) await expect(log.getByText(text)).toBeInViewport(T)
    } finally { await o.stop() }
  })

  test('R-46: loading: with the stream held, placeholders hold their final sizes, no spinner, nothing moves when the state arrives', async ({ browser }) => {
    const held: Route[] = []
    const on = { v: true }
    const o = await openFixture(browser, 'no-run', 'light', WIDTHS.wide, { before: (p) => hold(p, held, on) })
    try {
      const { page } = o
      await expect(page.getByRole('progressbar'), 'no spinner').toHaveCount(0, T)
      await expect(network(page)).toBeVisible(T)
      await expect(network(page)).toHaveAttribute('aria-busy', 'true', T)
      const before = { net: await box(network(page)), form: await box(composer(page)) }
      expect(before.form.height, 'the composer is at full size while loading').toBeGreaterThan(100)
      on.v = false
      for (const r of held) await r.continue().catch(() => {})
      await expect(network(page)).not.toHaveAttribute('aria-busy', 'true', LOAD)
      await expect(page.getByRole('button', { name: 'Start run' })).toBeVisible(LOAD)
      const after = { net: await box(network(page)), form: await box(composer(page)) }
      expect(Math.abs(after.net.y - before.net.y), 'the network does not move').toBeLessThanOrEqual(2)
      expect(Math.abs(after.form.y - before.form.y), 'the composer does not move').toBeLessThanOrEqual(2)
      expect(Math.abs(after.form.height - before.form.height), 'the composer keeps its size').toBeLessThanOrEqual(2)
    } finally { await o.stop() }
  })

  test('R-46: a stuck connection: "Still connecting to the session…" at 5 s, then the Banner with Reload at 20 s, and send is disabled as "Not connected"', async ({ browser }) => {
    test.setTimeout(60000)
    const held: Route[] = []
    const o = await openFixture(browser, 'no-run', 'light', WIDTHS.wide, { before: (p) => hold(p, held, { v: true }) })
    try {
      const { page } = o
      await expect(page.getByText('Still connecting to the session…')).toHaveCount(0)
      await expect(page.getByText('Still connecting to the session…')).toBeVisible({ timeout: 9000 })
      await expect(page.getByText("Can't reach the truss UI server. Check it is still running, then reload.")).toHaveCount(0)
      await expect(page.getByText("Can't reach the truss UI server. Check it is still running, then reload.")).toBeVisible({ timeout: 20000 })
      await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible(T)
      const send = composer(page).getByRole('button', { name: SEND })
      await expect(send).toBeDisabled(T)
      await expect(page.getByText('Not connected').first()).toBeVisible(T)
    } finally { await o.stop() }
  })

  test('R-44: the run status in the rail header reads Not started (F1), Working (F3), Waiting on you (F5, F6) and Finished, each a word plus an icon', async ({ browser }) => {
    const cases: Array<[string, string]> = [['no-run', 'Not started'], ['live', 'Working'], ['reply-open', 'Waiting on you'], ['approval-ask', 'Waiting on you'], ['finished', 'Finished']]
    for (const [state, word] of cases) {
      const o = await openFixture(browser, state, 'light', WIDTHS.wide)
      try {
        const st = runStatus(o.page)
        await expect(st, `${state}: run status`).toBeVisible(LOAD)
        await expect(st).toContainText(word, T)
        expect(await st.locator('svg, [role="img"], img').count(), `${state}: the run status has an icon`).toBeGreaterThan(0)
        expect(await inMain(st)).toBe(false)
      } finally { await o.stop() }
    }
  })

  test('R-44: a crew status change is announced in one polite live region: "Crew <slug> is now <status>"', async ({ browser }) => {
    const o = await openFixture(browser, 'live', 'light', WIDTHS.wide)
    try {
      const { page } = o
      await expect(network(page)).toBeVisible(LOAD)
      const run = structuredClone((o.planted.fixture as any).run)
      run.crews.find((c: any) => c.slug === 'rework-network').stuck = { kind: 'stalled', since: new Date(Date.now() - 600000).toISOString(), minutes: 10, detail: 'rework-network stalled 10 min' }
      o.planted.iface.emit({ run })
      const live = page.locator('[aria-live="polite"], [role="status"]').filter({ hasText: /Crew rework-network is now stuck/i })
      await expect(live, 'exactly one live region carries the announcement').toHaveCount(1, LOAD)
      const polite = await live.evaluate((el) => el.getAttribute('aria-live') === 'polite' || el.getAttribute('role') === 'status')
      expect(polite).toBe(true)
    } finally { await o.stop() }
  })

  test('R-43: the cost and run time summary in the rail header links to #run-metrics', async ({ browser }) => {
    const o = await openFixture(browser, 'live', 'light', WIDTHS.wide)
    try {
      const { page } = o
      const link = page.getByRole('link', { name: /\$23\.48/ })
      await expect(link).toBeVisible(LOAD)
      expect(await inMain(link)).toBe(false)
      await expect(link).toHaveAttribute('href', '#run-metrics', T)
      await expect(link).toContainText(/\d+m/)
      await link.click()
      await expect(page.getByRole('heading', { level: 2, name: 'Run metrics' })).toBeInViewport(T)
    } finally { await o.stop() }
  })

  test('R-43: F1: the summary reads "$0.00 · 0m" and every metric tile shows "—" with "No usage yet" at the size of F3\'s tiles', async ({ browser }) => {
    const empty = await openFixture(browser, 'no-run', 'light', WIDTHS.wide)
    let emptyBox: { width: number; height: number }
    try {
      const { page } = empty
      await expect(page.getByRole('link', { name: '$0.00 · 0m' })).toBeVisible(LOAD)
      const m = metrics(page)
      await expect(m.getByRole('heading', { level: 2, name: 'Run metrics' })).toBeVisible(T)
      await expect(m.getByText('No usage yet').first()).toBeVisible(T)
      expect(await m.getByText('—', { exact: true }).count(), 'cost, run time, agents and crews tiles show a dash').toBeGreaterThanOrEqual(4)
      emptyBox = await box(m.getByRole('term').first().locator('..'))
    } finally { await empty.stop() }
    const live = await openFixture(browser, 'live', 'light', WIDTHS.wide)
    try {
      const b = await box(metrics(live.page).getByRole('term').first().locator('..'))
      expect(b.width, 'tile width is final').toBeCloseTo(emptyBox.width, 0)
      expect(b.height, 'tile height is final').toBeCloseTo(emptyBox.height, 0)
    } finally { await live.stop() }
  })

  test('R-43: F3: one Run metrics section with cost, a tokens-per-model table, run time, agents started and crews done, and no limit, budget, ceiling or "of $"', async ({ browser }) => {
    const o = await openFixture(browser, 'live', 'light', WIDTHS.wide)
    try {
      const { page } = o
      await expect(page.getByRole('heading', { level: 2, name: 'Run metrics' })).toHaveCount(1, LOAD)
      const m = metrics(page)
      expect(await inMain(m)).toBe(true)
      await expect(m).toHaveAttribute('id', 'run-metrics', T)
      await expect(m.getByText('$23.48')).toBeVisible(T)
      const table = m.getByRole('table')
      await expect(table).toBeVisible(T)
      for (const h of ['Model', 'In', 'Out', 'Cache read', 'Cache write']) await expect(table.getByRole('columnheader', { name: h, exact: true })).toBeVisible(T)
      expect(await table.getByRole('row').count(), 'a header row and one row per model').toBeGreaterThanOrEqual(2)
      await expect(m.getByText('Run time', { exact: true })).toBeVisible(T)
      await expect(m.getByText('Agents started', { exact: true })).toBeVisible(T)
      await expect(m.getByText('Crews done', { exact: true })).toBeVisible(T)
      await expect(m.getByText('1 of 5', { exact: true }), 'crews done reads "n of m"').toBeVisible(T)
      const text = (await m.innerText()) + '\n' + (await page.getByRole('link', { name: /\$23\.48/ }).innerText())
      expect(text).not.toMatch(FORBIDDEN)
    } finally { await o.stop() }
  })

  test('R-43: F8 at 1024 px: "$12,345.67" and the 9-digit token counts fit on one line without overflow', async ({ browser }) => {
    const o = await openFixture(browser, 'long', 'light', WIDTHS.narrow)
    try {
      const { page } = o
      const m = metrics(page)
      const cost = m.getByText('$12,345.67')
      await expect(cost).toBeVisible(LOAD)
      expect(await oneLine(cost), 'the cost does not wrap').toBe(true)
      for (const n of ['123456789', '234567890', '987654321', '345678901']) {
        const cell = m.getByRole('cell', { name: new RegExp(n.replace(/(\d)(?=(\d{3})+$)/g, '$1,?')) })
        await expect(cell, `${n} shows`).toBeVisible(T)
        expect(await oneLine(cell), `${n} fits`).toBe(true)
      }
      expect(await noSideScroll(page)).toBe(true)
    } finally { await o.stop() }
  })

  test('R-46: the diff adds no raw hex or off-scale pixel values under ui/app/views, and crew headers carry no per-crew colours', async () => {
    const repo = resolve(import.meta.dirname, '..', '..', '..')
    const views = join(repo, 'ui', 'app', 'views')
    const files: string[] = []
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(tsx?|css)$/.test(f) && !/\.test\.ts$/.test(f)) files.push(p) } }
    walk(views)
    const hex = /(?<![\w&-])#[0-9a-fA-F]{3,8}\b/
    const rainbow = /\b(bg|text|border|ring|from|to)-(emerald|purple|violet|indigo|sky|teal|amber|rose|pink|cyan|fuchsia|lime|orange|blue|green|red)-\d/
    const bad: string[] = []
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/href=|^\s*(\/\/|\*)/.test(line)) return
        if (hex.test(line)) bad.push(`${f}:${i + 1} raw hex: ${line.trim()}`)
        if (rainbow.test(line)) bad.push(`${f}:${i + 1} per-crew colour: ${line.trim()}`)
      })
    }
    // added lines against the rework's base: px values must sit on the 4 px scale or be a size named in the direction
    const ALLOWED = new Set([0, 1, 2, 3, 4, 8, 12, 16, 24, 32, 48, 112, 160, 224, 256, 400, 560, 768, 1024, 1200])
    const diff = execFileSync('git', ['diff', '-U0', 'a5990b7', '--', 'ui/app/views'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    let file = ''
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ ')) { file = line.slice(6); continue }
      if (!line.startsWith('+') || /\.test\.ts$/.test(file)) continue
      if (/^\+\s*(--[\w-]+\s*:|\/\/)/.test(line)) continue // a named variable at the top of the area's CSS
      for (const m of line.matchAll(/(\d+(?:\.\d+)?)px/g)) if (!ALLOWED.has(Number(m[1]))) bad.push(`${file}: off-scale ${m[0]}: ${line.slice(1).trim()}`)
    }
    expect(bad, bad.join('\n')).toEqual([])
    const crewFiles = files.filter((f) => /views\/crews\//.test(f))
    expect(crewFiles.length, 'the crews area exists').toBeGreaterThan(0)
    expect(existsSync(join(views, 'status', 'StatusBadge.tsx')), 'views/status holds the shared StatusBadge').toBe(true)
  })

  for (const state of ['no-run', 'live', 'reply-open', 'approval-ask', 'architecture', 'thread']) {
    test(`R-46: axe reports no WCAG 2.2 AA violations on ${state} in light and dark`, async ({ browser }) => {
      for (const theme of THEMES) {
        const o = await openFixture(browser, state, theme as Theme, WIDTHS.desktop)
        try {
          const { page } = o
          await expect(network(page)).toBeVisible(LOAD)
          await expect(metrics(page)).toBeVisible(T)
          const res = await new AxeBuilder({ page }).withTags(TAGS).analyze()
          const lines = res.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).slice(0, 4).join('\n    ')}`)
          expect(res.violations, `axe violations in ${state} (${theme}):\n${lines.join('\n')}`).toEqual([])
        } finally { await o.stop() }
      }
    })
  }

  test('R-46: F3: every interactive element shows a visible focus ring, and the tab order is skip link, header, composer, thread, timeline, Your move, network, deliverables, metrics', async ({ browser }) => {
    const o = await openFixture(browser, 'live', 'light', WIDTHS.wide)
    try {
      const { page } = o
      await expect(network(page)).toBeVisible(LOAD)
      const seen: Array<{ zone: number; ring: boolean; label: string }> = []
      for (let i = 0; i < 200; i++) {
        await page.keyboard.press('Tab')
        const s = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null
          if (!el || el === document.body) return null
          const cs = getComputedStyle(el)
          const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || (cs.boxShadow !== 'none' && cs.boxShadow !== '')
          const head = (n: Element | null) => n?.querySelector('h2, h3')?.textContent ?? n?.getAttribute('aria-label') ?? ''
          const sec = el.closest('section, [role="region"]')
          const h = head(sec)
          let zone = -1
          if (el.closest('a[href^="#"]') && !el.closest('main') && /skip/i.test(el.textContent ?? '')) zone = 0
          else if (el.closest('main')) zone = /your move/i.test(h) ? 5 : /build network/i.test(h) ? 6 : /deliverable|built artifacts/i.test(h) ? 7 : /run metrics/i.test(h) ? 8 : -1
          else if (el.closest('form')) zone = 2
          else if (el.closest('[role="log"]')) zone = 3
          else if (/decisions and adrs/i.test(h) || /decisions and adrs/i.test(sec?.getAttribute('aria-label') ?? '')) zone = 4
          else zone = 1
          return { zone, ring, label: `${el.tagName.toLowerCase()} ${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}` }
        })
        if (!s) break
        seen.push(s)
      }
      expect(seen.length, 'the page has focusable controls').toBeGreaterThan(10)
      expect(seen.filter((s) => !s.ring).map((s) => s.label), 'every focused control shows a focus ring').toEqual([])
      const zones = seen.map((s) => s.zone).filter((z) => z >= 0)
      expect(zones, 'tab order follows the specified area order').toEqual([...zones].sort((a, b) => a - b))
      expect(zones, 'the composer is reached').toContain(2)
      expect(zones, 'the network (agent disclosures) is reached').toContain(6)
    } finally { await o.stop() }
  })

  test('R-46: targets are at least 44x44 px under pointer: coarse (send, reply, filter chips, agent disclosures) and at least 24x24 px otherwise', async ({ browser }) => {
    for (const coarse of [true, false]) {
      const min = coarse ? 44 : 24
      for (const state of ['live', 'reply-open']) {
        const o = await openFixture(browser, state, 'light', WIDTHS.desktop, { coarse })
        try {
          const { page } = o
          await expect(network(page)).toBeVisible(LOAD)
          const targets = [
            composer(page).getByRole('button', { name: SEND }),
            timeline(page).getByRole('button'),
            network(page).locator('button[aria-expanded]'),
            yourMove(page).getByRole('button'),
          ]
          let checked = 0
          for (const t of targets) {
            const n = await t.count()
            for (let i = 0; i < n; i++) {
              const l = t.nth(i)
              if (!(await l.isVisible())) continue
              const b = await box(l)
              checked++
              expect(b.width, `${state} coarse=${coarse}: width of ${(await l.innerText()).slice(0, 30)}`).toBeGreaterThanOrEqual(min - 0.5)
              expect(b.height, `${state} coarse=${coarse}: height of ${(await l.innerText()).slice(0, 30)}`).toBeGreaterThanOrEqual(min - 0.5)
            }
          }
          expect(checked, 'controls were measured').toBeGreaterThan(0)
        } finally { await o.stop() }
      }
    }
  })

  test('R-46: at 720 px (200% zoom), F5 and F3 have no horizontal page scroll and the labels stay readable', async ({ browser }) => {
    for (const state of ['reply-open', 'live']) {
      const o = await openFixture(browser, state, 'light', WIDTHS.zoom200)
      try {
        const { page } = o
        await expect(network(page)).toBeVisible(LOAD)
        await expect(metrics(page)).toBeVisible(T)
        expect(await noSideScroll(page), `${state}: no horizontal page scroll`).toBe(true)
        const clipped = await page.evaluate(() => [...document.querySelectorAll('button, [role="tab"], h2, label')]
          .filter((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right > window.innerWidth + 1)
          .map((el) => (el.textContent ?? '').trim().slice(0, 30)))
        expect(clipped, `${state}: nothing runs past the right edge`).toEqual([])
      } finally { await o.stop() }
    }
  })
})
