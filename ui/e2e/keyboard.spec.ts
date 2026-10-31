// R-18: every action works by keyboard. Each test reaches a control only with Tab, Shift+Tab and arrow
// keys, and acts only with Enter, Space or typing: no click, no hover, no focus() call. Also: focus is
// always visible, every control has an accessible name, html has lang="en" (R-19).
// Servers bind port 0 (harness). Written before ui/web exists: every test fails now on the missing page.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { WITHIN, itemWith, rand, rx, spawnEvent, startInterface, startReal, type Iface, type Real } from './harness.ts'

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

const crewLine = (page: Page, slug: string) => page.getByRole('button', { name: new RegExp(`\\b${slug}\\b`, 'i') }).first()
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

const messageBox = (page: Page) => page.getByRole('textbox', { name: /message|goal/i }).first()
const sendButton = (page: Page) => page.getByRole('button', { name: /send/i }).first()
const status = (i: Iface, id: string) => i.requests().find((r) => r.id === id)

test('R-19: html has lang="en" and the page has a title', async ({ page }) => {
  iface = await startInterface()
  await page.goto(iface.url)
  await expect(page.locator('html')).toHaveAttribute('lang', 'en', LOAD)
  await expect(page).toHaveTitle(/\S/)
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
  const card = itemWith(page, question)
  await expect(card).toBeVisible(LOAD)

  // The recommended option is listed first and says so in words.
  const options = card.getByRole('radio').or(card.getByRole('checkbox')).or(card.getByRole('option')).or(card.getByRole('button', { name: new RegExp(run) }))
  await expect(options.first()).toHaveAccessibleName(/\(Recommended\)|recommended/i)

  const pick = options.filter({ hasText: new RegExp(`Files ${run}`) }).or(card.getByRole('radio', { name: new RegExp(`Files ${run}`) })).first()
  await use(page, pick)
  const submit = card.getByRole('button', { name: /submit|answer|send|reply|done|ok/i }).first()
  if (await submit.count()) await use(page, submit)
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
  const card = itemWith(page, question)
  await expect(card).toBeVisible(LOAD)
  const box = card.getByRole('textbox').first()
  await reach(page, box)
  await page.keyboard.type(`my own answer ${run}`)
  const submit = card.getByRole('button', { name: /submit|answer|send|reply|done|ok/i }).first()
  if (await submit.count()) await use(page, submit)
  else await page.keyboard.press('Enter')
  await expect.poll(() => status(iface!, id)?.status, WITHIN).toBe('answered')
  expect(JSON.stringify(status(iface!, id)?.answers)).toContain(`my own answer ${run}`)
})

test('R-18: approve and deny a permission card with the keyboard', async ({ page }) => {
  const run = rand()
  iface = await startInterface()
  await page.goto(iface.url)
  const a = iface.permission({ toolName: 'Bash', title: `Run build ${run}`, summary: `npm run build ${run}` })
  await expect(page.getByText(rx(`Run build ${run}`)).first()).toBeVisible(LOAD)
  await use(page, page.getByRole('button', { name: /approve|allow/i }).first())
  await expect.poll(() => status(iface!, a)?.decision, WITHIN).toBe('allow')

  const b = iface.permission({ toolName: 'Write', title: `Write file ${run}`, summary: `/tmp/x-${run}` })
  await expect(page.getByText(rx(`Write file ${run}`)).first()).toBeVisible(WITHIN)
  const deny = itemWith(page, `Write file ${run}`).getByRole('button', { name: /deny/i }).first()
  await use(page, deny)
  await expect.poll(() => status(iface!, b)?.decision, WITHIN).toBe('deny')
})

test('R-18: approve and deny a reply card with the keyboard', async ({ page }) => {
  const run = rand()
  iface = await startInterface()
  await page.goto(iface.url)
  const a = iface.reply({ text: `Plan ready ${run}. Approve?` })
  await expect(page.getByText(rx(`Plan ready ${run}`)).first()).toBeVisible(LOAD)
  await use(page, itemWith(page, `Plan ready ${run}`).getByRole('button', { name: /approve/i }).first())
  await expect.poll(() => status(iface!, a)?.decision, WITHIN).toBe('allow')

  const b = iface.reply({ text: `Push ready ${run}. Approve?` })
  await expect(page.getByText(rx(`Push ready ${run}`)).first()).toBeVisible(WITHIN)
  await use(page, itemWith(page, `Push ready ${run}`).getByRole('button', { name: /deny/i }).first())
  await expect.poll(() => status(iface!, b)?.decision, WITHIN).toBe('deny')
})

test('R-18: expand and collapse a crew line with Enter and Space, then open the decisions/ADRs and design panels', async ({ page }) => {
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

  await reach(page, line)
  await expect(line).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Enter')
  await expect(line).toHaveAttribute('aria-expanded', 'true')
  await expect(itemWith(page, member)).toBeVisible()
  await page.keyboard.press('Space')
  await expect(line).toHaveAttribute('aria-expanded', 'false')
  await expect(itemWith(page, member)).toBeHidden()

  // Shift+Tab goes back to the line before; Tab brings the focus forward again.
  const before = await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))
  await page.keyboard.press('Shift+Tab')
  expect(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))).not.toBe(before)
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80))).toBe(before)

  const panel = (name: RegExp) => page.getByRole('tab', { name }).or(page.getByRole('button', { name })).or(page.getByRole('link', { name })).first()
  await use(page, panel(/decisions|ADR/i))
  await expect(page.getByText(rx(`choose-${run}-store`)).first()).toBeVisible(WITHIN)
  await use(page, panel(/design/i))
  await expect(page.getByText(rx(`The plan for run ${run}.`)).first()).toBeVisible(LOAD)

  // Escape closes a panel that opens as a dialog, and focus returns to what opened it.
  if (await page.getByRole('dialog').count()) {
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY')
  }
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
  await crewLine(page, 'quotas').press('Enter')
  await walk(page)
})

test('R-18: every Tab stop of the card page has a visible focus style and an accessible name', async ({ page }) => {
  const run = rand()
  iface = await startInterface()
  await page.goto(iface.url)
  iface.question([{ question: `Which store ${run}?`, header: 'Store', options: [{ label: 'A (Recommended)' }, { label: 'B' }] }])
  iface.permission({ toolName: 'Bash', title: `Run ${run}`, summary: `echo ${run}` })
  iface.reply({ text: `Approve ${run}?` })
  await expect(page.getByText(rx(`Approve ${run}?`)).first()).toBeVisible(LOAD)
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
  const unnamed = await page.evaluate(() => {
    const sel = 'button,a[href],input:not([type=hidden]),select,textarea,summary,[role=button],[role=tab],[role=link],[role=checkbox],[role=radio],[role=switch],[role=textbox],[role=option],[tabindex]:not([tabindex="-1"])'
    const out: string[] = []
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (el.getClientRects().length === 0) continue
      const ids = el.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') ?? ''
      const labels = Array.from((el as HTMLInputElement).labels ?? []).map((l) => l.textContent ?? '').join(' ')
      const name = [el.getAttribute('aria-label'), ids, labels, el.getAttribute('title'), el.querySelector('img[alt]')?.getAttribute('alt'), el instanceof HTMLInputElement && /submit|button/.test(el.type) ? el.value : '', el.textContent].join(' ').trim()
      if (!name) out.push(el.outerHTML.slice(0, 100))
    }
    return out
  })
  expect(unnamed).toEqual([])
})
