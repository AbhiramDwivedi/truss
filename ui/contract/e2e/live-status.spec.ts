// Browser contract for the live page (ADR-0011; R-3, R-5, R-15). It starts the real
// ui/server/main.ts on a temp copy of real Truss files on port 0, changes the files, and
// asserts each change shows within 2 s. Elements are found by role and accessible name; the
// names carry per-run random values, so no fixed string can pass by accident.
import { test, expect, type Locator, type Page } from '@playwright/test'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const here = import.meta.dirname
const uiDir = resolve(here, '..', '..')
const root = resolve(uiDir, '..')
const WITHIN = { timeout: 2000 }

// Roles a crew line, member line, decision or ADR entry may have; the name carries the value.
const ROLES = ['listitem', 'row', 'article', 'group', 'region', 'button', 'link', 'heading', 'cell', 'treeitem', 'status', 'log'] as const
function byName(page: Page, name: RegExp): Locator {
  return ROLES.map((r) => page.getByRole(r, { name })).reduce((a, b) => a.or(b))
}
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

test('changes to the Truss files show on the page within 2 s without a reload', async ({ page }) => {
  await page.goto(url)
  // The plan from docs/plan.example.json is on the page: the quotas crew.
  await expect(byName(page, /quotas/i).first()).toBeVisible({ timeout: 10000 })
  expect(page.url()).not.toContain('token=') // the server redirects the token away (Decision 6)

  // 1. plan.json: quotas becomes running (R-3).
  const plan = JSON.parse(readFileSync(join(trussDir, 'plan.json'), 'utf8'))
  plan.crews.find((c: { slug: string }) => c.slug === 'quotas').status = 'running'
  writeFileSync(join(trussDir, 'plan.json'), JSON.stringify(plan, null, 2))
  await expect(byName(page, /quotas.*running|running.*quotas/i).first()).toBeVisible(WITHIN)

  // 2. events.jsonl: a spawn line naming a per-run member (R-3, R-4). The member line sits
  // inside the crew's expandable line, so open the crew line first when it is a button.
  const member = `quotas-builder-${run}`
  const fields = [['v', 1], ['ts', new Date().toISOString()], ['event', 'spawn'], ['crew', 'quotas'], ['agent', member], ['agentId', `a${run}`], ['type', 'kit:builder'], ['model', 'sonnet'], ['effort', 'medium'], ['by', 'quotas']]
  appendFileSync(join(trussDir, 'events.jsonl'), JSON.stringify(Object.fromEntries(fields)) + '\n')
  const toggle = page.getByRole('button', Object.assign({ name: /quotas/i }, { expanded: false })).first()
  if (await toggle.count()) await toggle.click()
  await expect(byName(page, rx(member)).first()).toBeVisible(WITHIN)

  // 3. decisions.md: a line with a per-run value (R-5).
  const decision = `choose-${run}-store`
  appendFileSync(join(trussDir, 'decisions.md'), `- 10:00 | ${decision} | because ${run} | checker: none | followed\n`)
  await expect(byName(page, rx(decision)).first()).toBeVisible(WITHIN)

  // 4. a new ADR file in the repo's ADR dir (R-5).
  const adrTitle = `Adopt ${run} queue`
  writeFileSync(join(dir, 'repo', 'docs', 'adr', `0099-${run}.md`), `# ADR-0099: ${adrTitle}\n\nStatus: accepted\n`)
  await expect(byName(page, rx(adrTitle)).first()).toBeVisible(WITHIN)
})
