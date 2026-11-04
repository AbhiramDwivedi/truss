// R-18: every action works by keyboard. Each test reaches a control only with Tab, Shift+Tab and arrow
// keys, and acts only with Enter, Space or typing: no click, no hover, no focus() call. Also: focus is
// always visible, every control has an accessible name, html has lang="en" (R-19).
// Servers bind port 0 (harness). Written before ui/web exists: every test fails now on the missing page.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WITHIN, card as cardOf, goalBox, yourMove as yourMoveOf, sendButton, rand, rx, spawnEvent, startInterface, startReal, type Iface, type Real } from './harness.ts'

const LOAD = { timeout: 10000 }
const MAX_TABS = 150

let real: Real | undefined
let iface: Iface | undefined
test.afterEach(async () => {
  await real?.stop()
  await iface?.stop()
  real = undefined
  iface = undefined
})

// ADR-0028 section 10: a crew card is an article named by its slug; it is not a button any more.
const crewLine = (page: Page, slug: string) => page.getByRole('region', { name: 'Build network', exact: true }).getByRole('article', { name: new RegExp(`\\b${slug}\\b`, 'i') }).first()
const isFocused = (l: Locator) => l.evaluate((el) => el === document.activeElement)

// True when focus sits on a sibling of `l` in one arrow-key widget (radio group, tab list, listbox).
const inSameWidget = (l: Locator) => l.evaluate((el) => {
  const a = document.activeElement
  if (!a || a === el) return false
  const role = (x: Element) => x.getAttribute('role') || ((x as HTMLInputElement).type === 'radio' ? 'radio' : '')
  const r = role(el)
  if (!r || r !== role(a) || !['radio', 'tab', 'option', 'menuitemradio'].includes(r)) return false
  const group = (x: Element) => x.closest('[role=radiogroup],[role=tablist],[role=listbox],[role=menu],fieldset') ?? (x as HTMLInputElement).name
  return group(a) === group(el)
})

// Moves focus to `target` with the keyboard alone: Tab forward, and arrow keys inside a radio group or tab list.
async function reach(page: Page, target: Locator): Promise<void> {
  await expect(target.first()).toBeVisible(LOAD)
  const t = target.first()
  for (let i = 0; i < MAX_TABS; i++) {
    if (await isFocused(t)) return
    if (await inSameWidget(t)) {
      for (let k = 0; k < 12; k++) {
        await page.keyboard.press(k % 2 === 0 ? 'ArrowRight' : 'ArrowDown')
        if (await isFocused(t)) return
      }
    }
    await page.keyboard.press('Tab')
  }
  throw new Error(`keyboard could not reach ${target} in ${MAX_TABS} Tab presses`)
}

// Activates the focused control: Space for check boxes and radios, Enter for the rest.
async function act(page: Page, t: Locator): Promise<void> {
  const spaceKind = await t.first().evaluate((el) => {
    const role = el.getAttribute('role')
    const type = (el as HTMLInputElement).type
    return role === 'radio' || role === 'checkbox' || type === 'radio' || type === 'checkbox'
  })
  await page.keyboard.press(spaceKind ? 'Space' : 'Enter')
}
async function use(page: Page, t: Locator): Promise<void> {
  await reach(page, t)
  await act(page, t)
}

const messageBox = goalBox
const status = (i: Iface, id: string) => i.requests().find((r) => r.id === id)
const APPROVE = { name: 'Approve', exact: true } as const
const DENY = { name: 'Deny', exact: true } as const

test('R-19: html has lang="en" and the page has a title', async ({ page }) => {
  iface = await startInterface()
  await page.goto(iface.url)
  await expect.poll(() => page.evaluate(() => document.documentElement.lang), LOAD).toBe('en')
  await expect(page).toHaveTitle(/\S/)
  await expect(page).toHaveTitle('Truss', LOAD)
})

test('R-18: send a message with the keyboard only', async ({ page }) => {
  const run = rand()
  iface = await startInterface()
  await page.goto(iface.url)
  await reach(page, messageBox(page))
  await page.keyboard.type(`hello ${run}`)
  await use(page, sendButton(page))
  await expect.poll(() => iface!.calls.find((c) => c.kind === 'send' && c.text === `hello ${run}`)?.result, WITHIN).toEqual({ ok: true })
  await expect(page.getByText(rx(`hello ${run}`)).first()).toBeVisible(WITHIN)
})

test('R-18: answer a question card by choosing an option with arrow keys and Space, recommended first', async ({ page }) => {
  const run = rand()
  const question = `Which store ${run}?`
  iface = await startInterface()
  await page.goto(iface.url)
  const id = iface.question([{ question, header: 'Store', options: [{ label: `Postgres ${run}` }, { label: `SQLite ${run} (Recommended)` }, { label: `Files ${run}` }] }])
  const card = cardOf(page, 'question', question)
  await expect(card).toBeVisible(LOAD)

  // The recommended option is listed first and says so in words.
  const options = card.getByRole('radiogroup', { name: rx(question) }).getByRole('radio')
  await expect(options).toHaveCount(3)
  await expect(options.first()).toHaveAccessibleName(/\(Recommended\)/)

  await use(page, options.filter({ hasText: new RegExp(`Files ${run}`) }))
  await use(page, card.getByRole('button', { name: 'Submit answers', exact: true }))
  await expect.poll(() => status(iface!, id)?.status, WITHIN).toBe('answered')
  expect(JSON.stringify(status(iface!, id)?.answers)).toContain(`Files ${run}`)
  expect(JSON.stringify(status(iface!, id)?.answers)).not.toContain(`Postgres ${run}`)
})

test('R-18: answer a question card with free text typed by keyboard', async ({ page }) => {
  const run = rand()
  const question = `Which port ${run}?`
  iface = await startInterface()
  await page.goto(iface.url)
  const id = iface.question([{ question, header: 'Port', options: [{ label: `Auto ${run}` }, { label: `Fixed ${run}` }] }])
  const card = cardOf(page, 'question', question)
  await expect(card).toBeVisible(LOAD)
  const box = card.getByRole('textbox', { name: 'Your own answer', exact: true })
  await reach(page, box)
  await page.keyboard.type(`my own answer ${run}`)
  // ADR-0018: Enter in the text box submits the answers.
  await page.keyboard.press('Enter')
  await expect.poll(() => status(iface!, id)?.status, WITHIN).toBe('answered')
  expect(JSON.stringify(status(iface!, id)?.answers)).toContain(`my own answer ${run}`)
})

test('R-18: approve and deny a permission card with the keyboard', async ({ page }) => {
  const run = rand()
  iface = await startInterface()
  await page.goto(iface.url)
  const a = iface.permission({ toolName: 'Bash', title: `Run build ${run}`, summary: `npm run build ${run}` })
  await expect(cardOf(page, 'permission', `Run build ${run}`)).toBeVisible(LOAD)
  await use(page, cardOf(page, 'permission', `Run build ${run}`).getByRole('button', APPROVE))
  await expect.poll(() => status(iface!, a)?.decision, WITHIN).toBe('allow')

  const b = iface.permission({ toolName: 'Write', title: `Write file ${run}`, summary: `/tmp/x-${run}` })
  await expect(cardOf(page, 'permission', `Write file ${run}`)).toBeVisible(WITHIN)
  const deny = cardOf(page, 'permission', `Write file ${run}`).getByRole('button', DENY)
  await use(page, deny)
  await expect.poll(() => status(iface!, b)?.decision, WITHIN).toBe('deny')
})

// ADR-0028 section 2: Approve and Deny exist on a reply card only for an approval ask.
test('R-18: approve and deny a reply card with the keyboard', async ({ page }) => {
  const run = rand()
  iface = await startInterface()
  await page.goto(iface.url)
  const a = iface.reply({ text: `Plan ready ${run}. Approve?`, approvalAsk: true })
  await expect(cardOf(page, 'reply', `Plan ready ${run}`)).toBeVisible(LOAD)
  await use(page, cardOf(page, 'reply', `Plan ready ${run}`).getByRole('button', APPROVE))
  await expect.poll(() => status(iface!, a)?.decision, WITHIN).toBe('allow')

  const b = iface.reply({ text: `Push ready ${run}. Approve?`, approvalAsk: true })
  await expect(cardOf(page, 'reply', `Push ready ${run}`)).toBeVisible(WITHIN)
  await use(page, cardOf(page, 'reply', `Push ready ${run}`).getByRole('button', DENY))
  await expect.poll(() => status(iface!, b)?.decision, WITHIN).toBe('deny')
})

test('R-18: open and close an agent disclosure with Enter and Space, then reach the decisions/ADRs timeline and the architecture', async ({ page }) => {
  const run = rand()
  const member = `quotas-builder-${run}`
  real = await startReal({
    events: [spawnEvent('quotas', member)],
    trussFiles: { 'plan.md': `# Plan ${run}\n\nThe plan for run ${run}.\n` },
  })
  real.appendDecision(`- 10:00 | choose-${run}-store | because ${run} | checker: none | followed`)
  await page.goto(real.url)
  const line = crewLine(page, 'quotas')
  await expect(line).toBeVisible(LOAD)

  // ADR-0028 section 10 and UX direction 6: the crew card lists its agents as cards; each card has a disclosure button.
  const agent = line.getByRole('listitem').filter({ hasText: member })
  await expect(agent).toBeVisible()
  const disclosure = agent.getByRole('button', { expanded: false })
  await reach(page, disclosure)
  await page.keyboard.press('Enter')
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Space')
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false')

  // Shift+Tab goes back to the control before; Tab brings the focus forward again.
  const before = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))
  await page.keyboard.press('Shift+Tab')
  expect(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))).not.toBe(before)
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))).toBe(before)

  // ADR-0028 sections 3 and 10: there is no Run tablist. The timeline item and the Architecture deliverable are plain buttons.
  await expect(page.getByRole('tablist')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Decisions and ADRs', exact: true }).getByText(rx(`choose-${run}-store`)).first()).toBeVisible(WITHIN)
  await use(page, page.getByRole('region', { name: /deliverables/i }).getByRole('button', { name: /^Architecture/ }).first())
  await expect(page.getByRole('figure', { name: /^Diagram \d+ of \d+$/ }).first()).toBeVisible(LOAD)

  // There are no modals: nothing opens as a dialog, and focus stays on a control.
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY')
})

// Every stop in the Tab order of a busy page: visible focus, and an accessible name.
async function walk(page: Page): Promise<void> {
  const problems: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < MAX_TABS; i++) {
    await page.keyboard.press('Tab')
    const r = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body) return null
      const cs = getComputedStyle(el)
      const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && cs.outlineColor !== 'transparent'
      const shadow = cs.boxShadow !== 'none' && cs.boxShadow !== ''
      const labelled = el.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') ?? ''
      const labels = Array.from((el as HTMLInputElement).labels ?? []).map((l) => l.textContent ?? '').join(' ')
      const name = [el.getAttribute('aria-label'), labelled, labels, el.getAttribute('alt'), el.getAttribute('title'), el instanceof HTMLInputElement && /submit|button/.test(el.type) ? el.value : '', el.textContent].join(' ').trim()
      const key = el.tagName + '|' + (el.id || name.slice(0, 40) || el.outerHTML.slice(0, 60))
      return { key, desc: `${el.tagName.toLowerCase()} "${name.slice(0, 40)}"`, visibleFocus: outline || shadow, name: name.length > 0 }
    })
    if (!r) break
    if (seen.has(r.key)) break
    seen.add(r.key)
    if (!r.visibleFocus) problems.push(`no visible focus style on ${r.desc}`)
    if (!r.name) problems.push(`no accessible name on ${r.desc}`)
  }
  expect(seen.size, 'Tab stops found').toBeGreaterThanOrEqual(3)
  expect(problems).toEqual([])
}

test('R-18: every Tab stop of the live page has a visible focus style and an accessible name', async ({ page }) => {
  const run = rand()
  real = await startReal({ events: [spawnEvent('quotas', `quotas-builder-${run}`)] })
  await page.goto(real.url)
  await expect(crewLine(page, 'quotas')).toBeVisible(LOAD)
  await walk(page) // ADR-0028 section 10: no expand step on crew cards
})

test('R-18: every Tab stop of the card page has a visible focus style and an accessible name', async ({ page }) => {
  const run = rand()
  iface = await startInterface()
  await page.goto(iface.url)
  iface.question([{ question: `Which store ${run}?`, header: 'Store', options: [{ label: 'A (Recommended)' }, { label: 'B' }] }])
  iface.permission({ toolName: 'Bash', title: `Run ${run}`, summary: `echo ${run}` })
  iface.reply({ text: `Approve ${run}?` })
  await expect(page.getByText(rx(`Approve ${run}?`)).first()).toBeVisible(LOAD)
  // ADR-0018: the skip link is the first Tab stop.
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to Your move', exact: true })).toBeFocused()
  // D2 focus inside Your move (ADR-0023 section 3): Tab from the skip link reaches the first option radio,
  // and its outline is the move-fg hex, not brand (brand on move is 1.3:1 in light).
  const tokens = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'contract', 'redesign', 'tokens.json'), 'utf8'))
  const rgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})` }
  const firstRadio = yourMoveOf(page).getByRole('radio').first()
  await reach(page, firstRadio)
  await expect(firstRadio).toBeFocused()
  await expect(firstRadio).toHaveCSS('outline-color', rgb(tokens.colors['move-fg'].light))
  expect(rgb(tokens.colors['move-fg'].light)).not.toBe(rgb(tokens.colors.brand.light))
  await walk(page)
})

test('R-18: every control on the page has an accessible name', async ({ page }) => {
  const run = rand()
  iface = await startInterface()
  await page.goto(iface.url)
  iface.question([{ question: `Which store ${run}?`, header: 'Store', options: [{ label: 'A (Recommended)' }, { label: 'B' }] }])
  iface.permission({ toolName: 'Bash', title: `Run ${run}`, summary: `echo ${run}` })
  iface.reply({ text: `Approve ${run}?` })
  await expect(page.getByText(rx(`Approve ${run}?`)).first()).toBeVisible(LOAD)
  // Every control role, by role query; each one must carry a non-empty accessible name.
  const roles = ['button', 'link', 'textbox', 'radio', 'checkbox', 'tab', 'switch', 'combobox', 'option'] as const
  const unnamed: string[] = []
  let controls = 0
  for (const role of roles) {
    for (const el of await page.getByRole(role).all()) {
      controls++
      try {
        await expect(el).toHaveAccessibleName(/\S/, { timeout: 1000 })
      } catch {
        unnamed.push(`${role} with no accessible name`)
      }
    }
  }
  expect(controls, 'controls found by role').toBeGreaterThan(0)
  expect(unnamed).toEqual([])
})
