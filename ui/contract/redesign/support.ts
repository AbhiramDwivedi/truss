// Helpers for the redesign specs (ADR-0018 sections 10 and 11). The specs reach the page by role only;
// nothing here touches the DOM by selector. Every server is the real one (ui/e2e/harness.ts), on port 0.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { startInterface, startReal, rand, type Iface, type Real } from '../../e2e/harness.ts'

const here = import.meta.dirname
export const fixtureDir = resolve(here, '..', 'fixtures', 'run')
export const screensDir = resolve(here, '..', '..', 'screens')
const adrFile = resolve(here, '..', '..', '..', 'plugins', 'truss', 'docs', 'adr', '0018-ui-redesign.md')

// The states and widths come from the ADR's two lines, so the specs and the ADR cannot drift apart.
const adr = readFileSync(adrFile, 'utf8')
export const STATES = (adr.match(/^Screenshot states: (.+)$/m)?.[1] ?? '').split(', ').filter(Boolean)
export const WIDTHS: Array<[string, number]> = (() => {
  const m = adr.match(/^Screenshot widths: phone (\d+) px, tablet (\d+) px, desktop (\d+) px$/m)
  if (!m) throw new Error('ADR-0018 has no "Screenshot widths:" line')
  return [['phone', +m[1]!], ['tablet', +m[2]!], ['desktop', +m[3]!]]
})()
export const THEMES = ['light', 'dark'] as const
export const T = { timeout: 5000 }
export const LOAD = { timeout: 10000 }

// ---- the fixture copy ------------------------------------------------------------------------------------

export interface Copy { dir: string; run: string; webSlug: string; sessionSlug: string; serverSlug: string; files: Record<string, Buffer> }

function walk(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(dir, join(rel, e.name)) : [join(rel, e.name)]))
}

// A private copy of fixtures/run in an mkdtemp dir, with a per-run value planted: the goal's suffix and the
// planned crew's slug. Event times shift so the newest is now, so no running member reads as stalled.
// The fixture itself is never written.
export function copyFixture(): Copy {
  const dir = mkdtempSync(join(tmpdir(), 'truss-redesign-'))
  cpSync(fixtureDir, dir, { recursive: true })
  const run = `${rand()}${randomBytes(2).toString('hex')}`
  const webSlug = `ui-web-${run}`
  const plan = readFileSync(join(dir, 'plan.json'), 'utf8').replaceAll('ui-web', webSlug)
  const p = JSON.parse(plan)
  p.goal = `${p.goal} ${randomUUID().slice(0, 8)}-${run}`
  writeFileSync(join(dir, 'plan.json'), JSON.stringify(p, null, 2))
  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  const newest = Math.max(...lines.map((e) => Date.parse(e.ts)))
  const now = Date.now()
  for (const e of lines) e.ts = new Date(now - (newest - Date.parse(e.ts))).toISOString()
  writeFileSync(join(dir, 'events.jsonl'), lines.map((e) => JSON.stringify(e)).join('\n') + '\n')
  return { dir, run, webSlug, sessionSlug: 'ui-session', serverSlug: 'ui-server', files: {} }
}

// Writes a file into the copy (before the server starts).
export function putInCopy(c: Copy, rel: string, text: string): void {
  mkdirSync(join(c.dir, rel, '..'), { recursive: true })
  writeFileSync(join(c.dir, rel), text)
}

export async function startOnCopy(c: Copy): Promise<Real> {
  const trussFiles: Record<string, string | Buffer> = {}
  for (const rel of walk(c.dir)) trussFiles[rel] = readFileSync(join(c.dir, rel))
  return startReal({ trussFiles })
}

export function dropCopy(c: Copy): void { rmSync(c.dir, { recursive: true, force: true }) }

// ---- scenarios -------------------------------------------------------------------------------------------

export interface Scenario {
  url: string
  run: string
  copy: Copy
  real?: Real
  iface?: Iface
  /** Changes one thing the server reads (a file, or for the interface states a pushed delta). */
  change(): void
  stop(): Promise<void>
}

export async function scenario(state: string): Promise<Scenario> {
  const copy = copyFixture()
  const { run } = copy
  const done = async () => { dropCopy(copy) }
  if (state === 'empty') {
    const iface = await startInterface({ state: { notices: [{ id: 'no-truss-dir', text: `No Truss directory yet ${run}` }] } })
    return { url: iface.url, run, copy, iface, change: () => iface.emit(null, [{ n: 1, role: 'user', text: `hello ${run}`, ts: new Date().toISOString() }]), stop: async () => { await iface.stop(); await done() } }
  }
  if (state === 'pending-question') {
    const iface = await startInterface()
    iface.question([{ header: `Store ${run}`, question: `Which store should hold the quotas ${run}?`, options: [{ label: 'Postgres' }, { label: 'SQLite (Recommended)' }] }])
    return { url: iface.url, run, copy, iface, change: () => iface.emit(null, [{ n: 1, role: 'user', text: `hello ${run}`, ts: new Date().toISOString() }]), stop: async () => { await iface.stop(); await done() } }
  }
  if (state === 'pending-approval') {
    const iface = await startInterface()
    iface.reply({ text: `The plan is ready ${run}` })
    iface.permission({ toolName: 'Bash', title: `Run the checks ${run}`, summary: 'npm --prefix ui test' })
    return { url: iface.url, run, copy, iface, change: () => iface.emit(null, [{ n: 1, role: 'user', text: `hello ${run}`, ts: new Date().toISOString() }]), stop: async () => { await iface.stop(); await done() } }
  }
  if (state === 'blocked-crew') putInCopy(copy, join('reports', copy.serverSlug, `${copy.serverSlug}-qc.md`), 'VERDICT: FAIL\n\nChecked by the redesign spec.\n')
  if (state === 'retro') {
    const step = (status: string, detail: string | null) => ({ status, at: new Date().toISOString(), detail })
    const pend = { status: 'pending', at: null, detail: null }
    putInCopy(copy, join('retro', 'state.json'), JSON.stringify({ v: 1, updatedAt: new Date().toISOString(), steps: { extract: step('done', null), judges: step('running', `judging ${run}`), triage: pend, fixGoal: pend, applied: pend } }))
  }
  const real = await startOnCopy(copy)
  const stop = async () => { await real.stop(); await done() }
  const change = () => {
    if (state === 'crews-running') real.writePlan((p) => { p.crews.find((c: any) => c.slug === copy.webSlug).status = 'merged' })
    else if (state === 'blocked-crew') real.writeQc(copy.sessionSlug, 'FAIL')
    else if (state === 'retro') {
      const pend = { status: 'pending', at: null, detail: null }
      real.writeTrussFile(join('retro', 'state.json'), JSON.stringify({ v: 1, updatedAt: new Date().toISOString(), steps: { extract: { status: 'done', at: null, detail: null }, judges: { status: 'done', at: null, detail: null }, triage: { status: 'running', at: new Date().toISOString(), detail: `triaging ${run}` }, fixGoal: pend, applied: pend } }))
    } else if (state === 'decisions') real.appendDecision(`- 12:00 | decision marker ${run} | the redesign spec | none | followed`)
  }
  return { url: real.url, run, copy, real, change, stop }
}

// ---- watching the page -----------------------------------------------------------------------------------

// Collects console errors, page errors and CSP violations. The spec asserts the list is empty at the end.
export async function watch(page: Page): Promise<() => Promise<string[]>> {
  const seen: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') seen.push(`console: ${m.text()}`) })
  page.on('pageerror', (e) => { seen.push(`pageerror: ${String(e)}`) })
  await page.addInitScript(() => {
    ;(window as any).__csp = []
    document.addEventListener('securitypolicyviolation', (e) => { (window as any).__csp.push(`${e.violatedDirective} ${e.blockedURI}`) })
  })
  return async () => {
    const csp = await page.evaluate(() => (window as any).__csp as string[]).catch(() => [] as string[])
    return [...seen, ...csp.map((c) => `csp: ${c}`)]
  }
}
