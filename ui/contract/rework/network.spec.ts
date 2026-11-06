// The build-network contract (ADR-0028 sections 6, 7, 9 and 10; UX checklist 23 to 33): the PM node, the wires, the
// crew cards with their agent cards, the one status vocabulary, long and partial content, and reduced motion.
// Written before rework-network builds it. Elements are reached by role and name; only the wires (`data-crew`) are
// found by attribute. Every case title starts with the requirement it pins.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { openFixture, hhmm, WIDTHS, T, LOAD } from './support.ts'
import { token } from '../redesign/support.ts'

const DESKTOP = WIDTHS.wide

const network = (page: Page) => page.getByRole('region', { name: 'Build network' })
const crewCard = (page: Page, slug: string) => network(page).getByRole('article', { name: new RegExp(`\\b${slug}\\b`) })

/** The computed paint of a wire: its own stroke, or the first descendant that has one. */
async function wirePaint(wire: Locator): Promise<{ stroke: string; width: number; animation: string }> {
  return wire.first().evaluate((el) => {
    let t: Element = el
    if (getComputedStyle(el).stroke === 'none') {
      const d = Array.from(el.getElementsByTagName('*')).find((x) => getComputedStyle(x).stroke !== 'none')
      if (d) t = d
    }
    const cs = getComputedStyle(t)
    return { stroke: cs.stroke, width: parseFloat(cs.strokeWidth), animation: cs.animationName }
  })
}

async function noSidewaysScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
}

test.describe('network', () => {
  test('R-36: no plan (F1) shows the PM node waiting for a goal and a dashed placeholder, never "No plan yet."', async ({ browser }) => {
    const o = await openFixture(browser, 'no-run', 'light', DESKTOP)
    try {
      const net = network(o.page)
      await expect(net).toBeVisible(LOAD)
      await expect(net.getByText('Waiting for your goal')).toBeVisible(T)
      await expect(net.getByText('Planned', { exact: true }).first(), 'the PM node status is Planned').toBeVisible(T)
      const ph = net.getByText('Crews appear here once the PM has a plan.')
      await expect(ph).toBeVisible(T)
      const dashed = await ph.evaluate((el) => {
        for (let n: Element | null = el; n; n = n.parentElement) if (getComputedStyle(n).borderTopStyle === 'dashed') return true
        return false
      })
      expect(dashed, 'the placeholder card has a dashed border').toBe(true)
      await expect(o.page.getByText('No plan yet.')).toHaveCount(0)
      await expect(net.locator('[data-crew]'), 'no wires without crews').toHaveCount(0)
    } finally { await o.stop() }
  })

  test('R-36: planning (F2) shows the PM node as "Planning the run" with status Active', async ({ browser }) => {
    const o = await openFixture(browser, 'planning', 'light', DESKTOP)
    try {
      const net = network(o.page)
      await expect(net.getByText('Planning the run')).toBeVisible(LOAD)
      await expect(net.getByText('Active', { exact: true }).first()).toBeVisible(T)
      await expect(net.getByText('Waiting for your goal')).toHaveCount(0)
      await expect(o.page.getByText('No plan yet.')).toHaveCount(0)
    } finally { await o.stop() }
  })

  test('R-36: live (F3) is a region "Build network" with a list per stage and an article per crew named by its slug', async ({ browser }) => {
    const o = await openFixture(browser, 'live', 'light', DESKTOP)
    try {
      const net = network(o.page)
      await expect(net).toBeVisible(LOAD)
      const crews = o.planted.fixture.run.crews as any[]
      const stages = new Set(crews.map((c) => c.stage))
      await expect(net.getByRole('list').filter({ has: o.page.getByRole('article') }), 'one list per stage').toHaveCount(stages.size, T)
      for (const c of crews) await expect(crewCard(o.page, c.slug)).toHaveCount(1, T)
      await expect(net.getByRole('article')).toHaveCount(crews.length, T)
    } finally { await o.stop() }
  })

  test('R-36: real-12 (F4) renders all 12 crews, folds crews with more than 6 agents, and never scrolls sideways at 1440, 768 and 360', async ({ browser }) => {
    for (const width of [WIDTHS.wide, WIDTHS.tablet, WIDTHS.phone]) {
      const o = await openFixture(browser, 'real-12', 'light', width)
      try {
        const net = network(o.page)
        await expect(net).toBeVisible(LOAD)
        await expect(net.getByRole('article')).toHaveCount(12, T)
        // real-12 crews have 7 generic members: they fold into a collapsed "N check runs" row (fewer than 7 named members, so no "Show n more agents").
        const runs = net.getByRole('button', { name: /^\d+ check runs?$/ })
        expect(await runs.count(), `crews with generic members fold them into a "N check runs" row at ${width}`).toBeGreaterThan(0)
        await expect(runs.first(), `check runs start collapsed at ${width}`).toHaveAttribute('aria-expanded', 'false')
        expect(await noSidewaysScroll(o.page), `no horizontal page scroll at ${width}`).toBe(true)
      } finally { await o.stop() }
    }
  })

  test('R-36: a crew whose events can not be read (partial) says so, and the other crews still render', async ({ browser }) => {
    const o = await openFixture(browser, 'partial', 'light', DESKTOP)
    try {
      const crews = o.planted.fixture.run.crews as any[]
      const bad = crews.find((c) => c.eventsUnread > 0)
      expect(bad, 'the fixture has a partial crew').toBeTruthy()
      await expect(crewCard(o.page, bad.slug).getByText("Couldn't read this crew's events")).toBeVisible(LOAD)
      for (const c of crews) await expect(crewCard(o.page, c.slug)).toHaveCount(1, T)
      await expect(network(o.page).getByText("Couldn't read this crew's events")).toHaveCount(1, T)
    } finally { await o.stop() }
  })

  test('R-40: live (F3) has one wire per crew card, and the crew with a fresh hand-off has a brand 3 px wire and "From PM <time>: <summary>" in its header', async ({ browser }) => {
    const o = await openFixture(browser, 'live', 'light', DESKTOP)
    try {
      const net = network(o.page)
      await expect(net).toBeVisible(LOAD)
      const crews = o.planted.fixture.run.crews as any[]
      // the newest flow entry is 5 s old when the page opens, so this is checked first
      const recent = o.planted.fixture.session.flow.at(-1)
      const wire = net.locator(`[data-crew="${recent.to}"]`)
      await expect(wire.first()).toBeAttached(T)
      const paint = await wirePaint(wire)
      expect(paint.stroke, 'a wire carrying a recent hand-off is brand').toBe(token('brand', 'light'))
      expect(paint.width, 'and 3 px').toBe(3)
      const head = `From PM ${hhmm(o.planted.shown(recent.at))}: ${recent.summary}`
      await expect(crewCard(o.page, recent.to).getByText(head)).toBeVisible(T)
      await expect(net.locator('[data-crew]'), 'one wire per crew card').toHaveCount(crews.length, T)
      for (const c of crews) await expect(net.locator(`[data-crew="${c.slug}"]`), c.slug).toHaveCount(1)
    } finally { await o.stop() }
  })

  test('R-40: wires to active crews animate, and wires to done or planned crews do not', async ({ browser }) => {
    const o = await openFixture(browser, 'live', 'light', DESKTOP)
    try {
      const net = network(o.page)
      await expect(net).toBeVisible(LOAD)
      await expect(net.locator('[data-crew="rework-network"]').first()).toBeAttached(T)
      expect((await wirePaint(net.locator('[data-crew="rework-network"]'))).animation, 'active wire moves').not.toBe('none')
      expect((await wirePaint(net.locator('[data-crew="rework-server"]'))).animation, 'merged crew wire is still').toBe('none')
      expect((await wirePaint(net.locator('[data-crew="rework-page"]'))).animation, 'planned crew wire is still').toBe('none')
    } finally { await o.stop() }
  })

  test('R-40: under reduced motion nothing in the network animates and the live wire is solid brand', async ({ browser }) => {
    const o = await openFixture(browser, 'live', 'light', DESKTOP, { reducedMotion: true })
    try {
      const net = network(o.page)
      await expect(net).toBeVisible(LOAD)
      await expect(net.locator('[data-crew="rework-network"]').first()).toBeAttached(T)
      const names = await net.evaluate((el) => [el, ...Array.from(el.getElementsByTagName('*'))].map((e) => getComputedStyle(e).animationName).filter((n) => n !== 'none'))
      expect(names, 'every loop stops').toEqual([])
      const paint = await wirePaint(net.locator('[data-crew="rework-network"]'))
      expect(paint.stroke).toBe(token('brand', 'light'))
      expect(paint.animation).toBe('none')
    } finally { await o.stop() }
  })

  test('R-44: live (F3) crews show one distinct word and an icon each: Active, Done, Waiting on you, Stuck, Planned', async ({ browser }) => {
    const o = await openFixture(browser, 'live', 'light', DESKTOP)
    try {
      await expect(network(o.page)).toBeVisible(LOAD)
      const want: Record<string, string> = {
        'rework-network': 'Active', 'rework-server': 'Done', 'rework-chat': 'Waiting on you', 'rework-docs': 'Stuck', 'rework-page': 'Planned',
      }
      for (const [slug, word] of Object.entries(want)) {
        const card = crewCard(o.page, slug)
        const badge = card.getByText(word, { exact: true }).first()
        await expect(badge, `${slug} shows ${word}`).toBeVisible(T)
        const icon = badge.locator("xpath=ancestor-or-self::*[.//*[local-name()='svg']][1]").locator('svg').first()
        await expect(icon, `${slug} shows an icon beside ${word}`).toBeVisible(T)
        for (const other of Object.values(want).filter((w) => w !== word)) {
          await expect(card.getByText(other, { exact: true }), `${slug} does not also say ${other}`).toHaveCount(0)
        }
      }
    } finally { await o.stop() }
  })

  test('R-42: live (F3) agent cards show role, name, model chip, purpose, task or last activity, and the three steps with no percentage', async ({ browser }) => {
    const o = await openFixture(browser, 'live', 'light', DESKTOP)
    try {
      await expect(network(o.page)).toBeVisible(LOAD)
      const card = crewCard(o.page, 'rework-network')
      const crew = (o.planted.fixture.run.crews as any[]).find((c) => c.slug === 'rework-network')
      for (const m of [crew.foreman, ...crew.members]) await expect(card.getByText(m.name, { exact: true }).first(), m.name).toBeVisible(T)
      // roles come from the agent type
      await expect(card.getByText('Foreman', { exact: true }).first()).toBeVisible(T)
      await expect(card.getByText(/^(Builder|General purpose)$/i).first()).toBeVisible(T)
      await expect(card.getByText('QC engineer', { exact: true }).first()).toBeVisible(T)
      // one-line purposes from agents/*.md
      await expect(card.getByText('Leads one truss crew.')).toBeVisible(T)
      await expect(card.getByText('Builds the code a foreman task names, in the crew worktree.')).toBeVisible(T)
      await expect(card.getByText(/^Rules on one truss crew's work/)).toBeVisible(T)
      // the task, or the fallback
      await expect(card.getByText('Splitting the network goal into builder tasks.')).toBeVisible(T)
      await expect(card.getByText('Building AgentCard and Wire in views/crews.')).toBeVisible(T)
      // model chips
      await expect(card.getByText(/opus/i).first()).toBeVisible(T)
      await expect(card.getByText(/sonnet/i).first()).toBeVisible(T)
      // the three steps, once per agent card, and no percentage
      for (const step of ['Spawned', 'Working', 'Reported']) expect(await card.getByText(step, { exact: true }).count(), step).toBeGreaterThanOrEqual(3)
      expect(await card.innerText(), 'no percentage').not.toMatch(/\d\s*%/)
    } finally { await o.stop() }
  })

  test('R-42: an agent with no task and no activity shows "No activity yet", and no card has an empty line', async ({ browser }) => {
    const o = await openFixture(browser, 'live', 'light', DESKTOP, {
      edit: (s) => {
        const qc = s.run.crews.find((c: any) => c.slug === 'rework-network').members.find((m: any) => m.type === 'truss:qc-engineer')
        qc.task = null; qc.detail = null
      },
    })
    try {
      await expect(network(o.page)).toBeVisible(LOAD)
      await expect(crewCard(o.page, 'rework-network').getByText('No activity yet')).toHaveCount(1, T)
      const text = await network(o.page).innerText()
      expect(text, 'no blank lines inside agent cards').not.toMatch(/\n\s*\n\s*\n\s*\n/)
    } finally { await o.stop() }
  })

  test('R-42: long (F8) clamps a 300-character task to one line, and the card disclosure shows all of it', async ({ browser }) => {
    const o = await openFixture(browser, 'long', 'light', DESKTOP)
    try {
      await expect(network(o.page)).toBeVisible(LOAD)
      const crew = (o.planted.fixture.run.crews as any[])[0]
      const task: string = crew.members.find((m: any) => (m.task ?? '').length >= 300).task
      const card = crewCard(o.page, crew.slug)
      const line = card.getByText(task.slice(0, 40)).first()
      await expect(line).toBeVisible(T)
      const lines = await line.evaluate((el) => {
        const cs = getComputedStyle(el)
        return Math.round(el.getBoundingClientRect().height / (parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2))
      })
      expect(lines, 'the task is clamped to one line').toBeLessThanOrEqual(1)
      const toggle = card.getByRole('button', { expanded: false }).filter({ hasNot: o.page.getByText(/^Show \d+ more/) }).first()
      await toggle.click()
      await expect(card.getByRole('button', { expanded: true }).first()).toBeVisible(T)
      await expect(card.getByText(task, { exact: true })).toBeVisible(T)
      expect(await noSidewaysScroll(o.page)).toBe(true)
    } finally { await o.stop() }
  })

  test('R-46: long (F8) truncates a 60-character slug with an ellipsis, and keeps the full slug as its title', async ({ browser }) => {
    const o = await openFixture(browser, 'long', 'light', DESKTOP)
    try {
      await expect(network(o.page)).toBeVisible(LOAD)
      const slug: string = (o.planted.fixture.run.crews as any[])[0].slug
      expect(slug.length).toBe(60)
      const label = network(o.page).getByTitle(slug).first()
      await expect(label, 'the full slug is the title').toBeVisible(T)
      const css = await label.evaluate((el) => ({ o: getComputedStyle(el).textOverflow, ov: getComputedStyle(el).overflow, cut: el.scrollWidth > el.clientWidth }))
      expect(css.o, 'text-overflow: ellipsis').toBe('ellipsis')
      expect(css.ov).not.toBe('visible')
      await label.focus()
      await expect(label, 'the element carrying the full slug takes focus (native control or tabindex=0)').toBeFocused(T)
      await expect(label, 'the full slug is announced on focus').toHaveAccessibleName(new RegExp(slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      expect(await noSidewaysScroll(o.page), 'no horizontal page scroll').toBe(true)
    } finally { await o.stop() }
  })

  test('R-46: the PM node is badged "PM", not "Director", and labels are sentence case', async ({ browser }) => {
    const o = await openFixture(browser, 'live', 'light', DESKTOP)
    try {
      const net = network(o.page)
      await expect(net).toBeVisible(LOAD)
      await expect(net.getByText('PM', { exact: true }).first()).toBeVisible(T)
      await expect(o.page.getByText(/Director/)).toHaveCount(0)
    } finally { await o.stop() }
  })
})
