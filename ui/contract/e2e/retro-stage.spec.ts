// Browser contract for the retro stage (ADR-0012 Decision 8; R-23). It starts the real
// ui/server/main.ts on a temp copy of real Truss files on port 0, writes <truss dir>/retro/state.json
// the way retro/cli.ts would, and asserts the Retro stage region shows running and then fixes
// applied, each within 2 s. Elements are found by role and accessible name; the per-run value
// is the step's detail text, so no fixed string can pass by accident.
import { test, expect } from '@playwright/test'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const here = import.meta.dirname
const uiDir = resolve(here, '..', '..')
const root = resolve(uiDir, '..')
const WITHIN = { timeout: 2000 }

let dir = ''
let trussDir = ''
let server: ChildProcess | undefined
let url = ''
let stderr = ''
const run = randomBytes(4).toString('hex')

const STEPS = ['extract', 'judges', 'triage', 'fixGoal', 'applied'] as const
type Step = { status: string; at: string | null; detail: string | null }

function writeRetro(over: Partial<Record<(typeof STEPS)[number], Step>>): void {
  const steps: Record<string, Step> = {}
  for (const k of STEPS) steps[k] = over[k] ?? { status: 'pending', at: null, detail: null }
  mkdirSync(join(trussDir, 'retro'), { recursive: true })
  writeFileSync(join(trussDir, 'retro', 'state.json'), JSON.stringify({ v: 1, updatedAt: new Date().toISOString(), steps }))
}
const stamp = () => new Date().toISOString()

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'truss-ui-retro-'))
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

test('R-23: the retro lane shows running and then fixes applied within 2 s without a reload', async ({ page }) => {
  await page.goto(url)
  // The work lanes are on the page first; the retro lane is not there while no retro state file exists.
  await expect(page.getByText(/quotas/i).first()).toBeVisible({ timeout: 10000 })
  const lane = page.getByRole('region', { name: 'Retro stage' })

  // 1. the retro starts: extract done with a per-run detail, judges running.
  const found = `${run} findings kept`
  writeRetro({ extract: { status: 'done', at: stamp(), detail: found }, judges: { status: 'running', at: stamp(), detail: null } })
  await expect(lane).toBeVisible(WITHIN)
  await expect(lane.getByRole('listitem', { name: 'Judges: running' })).toBeVisible(WITHIN)
  await expect(lane.getByRole('listitem', { name: 'Extract: done' })).toBeVisible(WITHIN)
  await expect(lane.getByRole('listitem', { name: 'Fixes applied: pending' })).toBeVisible(WITHIN)

  // 2. the fix goal is applied: every step done, the last with a per-run detail.
  const merged = `${run} crews merged`
  const t = stamp()
  writeRetro({
    extract: { status: 'done', at: t, detail: found },
    judges: { status: 'done', at: t, detail: null },
    triage: { status: 'done', at: t, detail: null },
    fixGoal: { status: 'done', at: t, detail: null },
    applied: { status: 'done', at: t, detail: merged },
  })
  await expect(lane.getByRole('listitem', { name: 'Fixes applied: done' })).toBeVisible(WITHIN)
  await expect(lane.getByRole('listitem', { name: 'Judges: done' })).toBeVisible(WITHIN)
  await expect(lane.getByRole('listitem', { name: 'Judges: running' })).toHaveCount(0)
  await expect(lane.getByText(merged)).toBeVisible(WITHIN)
})
