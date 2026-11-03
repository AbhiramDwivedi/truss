// Browser contract for the live page (ADR-0011; R-3, R-5, R-15). It starts the real
// ui/server/main.ts on a temp copy of real Truss files on port 0, changes the files, and
// asserts each change shows within 2 s. Elements are found by role and accessible name; the
// names carry per-run random values, so no fixed string can pass by accident.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { expectD2Colours } from './colours.ts'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const here = import.meta.dirname
const uiDir = resolve(here, '..', '..')
const root = join(resolve(uiDir, '..'), 'plugins', 'truss')
const WITHIN = { timeout: 2000 }

// A crew line: the one button per crew in its stage group of the Crews region (ADR-0018 section 10).
const crewLine = (page: Page, slug: string): Locator =>
  page.getByRole('region', { name: 'Crews', exact: true }).getByRole('group', { name: /^Stage \d+$/ }).getByRole('listitem')
    .getByRole('button', { name: new RegExp(`\\b${slug}\\b`, 'i') }).first()
const rx = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

let dir = ''
let trussDir = ''
let server: ChildProcess | undefined
let url = ''
let stderr = ''
const run = randomBytes(4).toString('hex')

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'truss-ui-live-'))
  const repo = join(dir, 'repo')
  trussDir = join(dir, 'truss-dir')
  mkdirSync(join(repo, 'docs', 'adr'), { recursive: true })
  mkdirSync(join(repo, '.claude'), { recursive: true })
  mkdirSync(trussDir, { recursive: true })
  cpSync(join(root, 'docs', 'architecture.md'), join(repo, 'docs', 'architecture.md'))
  cpSync(join(root, 'docs', 'adr', '0001-design-phase.md'), join(repo, 'docs', 'adr', '0001-design-phase.md'))
  const cfg = Object.fromEntries([['architecture', 'docs/architecture.md'], ['adr', 'docs/adr'], ['merge', 'sequential'], ['target', 'main']])
  writeFileSync(join(repo, '.claude', 'truss.json'), JSON.stringify(cfg))
  execFileSync('git', ['init', '-q', repo])
  cpSync(join(root, 'tests', 'fixtures', 'retro-040'), trussDir, { recursive: true })
  cpSync(join(root, 'docs', 'plan.example.json'), join(trussDir, 'plan.json'))
  const args = [join(uiDir, 'server', 'main.ts'), '--repo', repo, '--plugin', root, '--truss-dir', trussDir, '--port', '0']
  const child = spawn(process.execPath, args)
  server = child
  child.stderr.on('data', (d) => { stderr += String(d) })
  url = await new Promise<string>((ok, fail) => {
    let out = ''
    const t = setTimeout(() => fail(new Error(`no URL line within 15 s; stderr: ${stderr}`)), 15000)
    const re = /truss-ui listening on (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/
    child.stdout.on('data', (d) => { out += String(d); const m = out.match(re); if (m) { clearTimeout(t); ok(m[1]) } })
    child.on('exit', (c) => { clearTimeout(t); fail(new Error(`server exited ${c}; stderr: ${stderr}`)) })
  })
})

test.afterAll(() => {
  server?.kill('SIGTERM')
  if (dir) rmSync(dir, { recursive: true })
})

// ADR-0023 checklist item 22: the live page paints the tokens.json colours.
test('D2 colours: the live page paints body with tokens.json bg and the move surface with move', async ({ page }) => {
  await page.goto(url)
  await expect(crewLine(page, 'quotas')).toBeVisible({ timeout: 10000 })
  await expectD2Colours(page, 'light')
})

test('changes to the Truss files show on the page within 2 s without a reload', async ({ page }) => {
  await page.goto(url)
  // The plan from docs/plan.example.json is on the page: the quotas crew.
  await expect(crewLine(page, 'quotas')).toBeVisible({ timeout: 10000 })
  expect(page.url()).not.toContain('token=') // the server redirects the token away (Decision 6)

  // 1. plan.json: quotas becomes running (R-3).
  const plan = JSON.parse(readFileSync(join(trussDir, 'plan.json'), 'utf8'))
  plan.crews.find((c: { slug: string }) => c.slug === 'quotas').status = 'running'
  writeFileSync(join(trussDir, 'plan.json'), JSON.stringify(plan, null, 2))
  await expect(crewLine(page, 'quotas')).toHaveAccessibleName(/running/i, WITHIN)

  // 2. events.jsonl: a spawn line naming a per-run member (R-3, R-4). The member line sits
  // inside the crew's expandable line, so open the crew line first when it is a button.
  const member = `quotas-builder-${run}`
  const fields = [['v', 1], ['ts', new Date().toISOString()], ['event', 'spawn'], ['crew', 'quotas'], ['agent', member], ['agentId', `a${run}`], ['type', 'kit:builder'], ['model', 'sonnet'], ['effort', 'medium'], ['by', 'quotas']]
  appendFileSync(join(trussDir, 'events.jsonl'), JSON.stringify(Object.fromEntries(fields)) + '\n')
  const line = crewLine(page, 'quotas')
  await expect(line).toHaveAccessibleName(new RegExp(`${member} spawned`, 'i'), WITHIN)
  if ((await line.getAttribute('aria-expanded')) !== 'true') await line.click()
  await expect(line).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('list', { name: 'quotas members', exact: true }).getByRole('listitem').filter({ hasText: rx(member) })).toBeVisible(WITHIN)

  // The decisions and ADRs tab holds the next two (R-5).
  const tab = page.getByRole('tab', { name: 'Decisions and ADRs', exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  const decisions = page.getByRole('tabpanel', { name: 'Decisions and ADRs', exact: true }).getByRole('region', { name: 'Decisions', exact: true })
  const adrs = page.getByRole('tabpanel', { name: 'Decisions and ADRs', exact: true }).getByRole('region', { name: 'ADRs', exact: true })

  // 3. decisions.md: a line with a per-run value (R-5).
  const decision = `choose-${run}-store`
  appendFileSync(join(trussDir, 'decisions.md'), `- 10:00 | ${decision} | because ${run} | checker: none | followed\n`)
  await expect(decisions.getByRole('listitem').filter({ hasText: rx(decision) })).toBeVisible(WITHIN)

  // 4. a new ADR file in the repo's ADR dir (R-5).
  const adrTitle = `Adopt ${run} queue`
  writeFileSync(join(dir, 'repo', 'docs', 'adr', `0099-${run}.md`), `# ADR-0099: ${adrTitle}\n\nStatus: accepted\n`)
  await expect(adrs.getByRole('listitem').filter({ hasText: rx(adrTitle) })).toBeVisible(WITHIN)
})
