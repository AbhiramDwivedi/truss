// Helpers for the redesign specs (ADR-0023 sections 4 to 6, on top of ADR-0018 sections 10 and 11). The specs
// reach the page by role only; nothing here touches the DOM by selector. Every state is a fixture under
// fixtures/run/<state>/ planted into the fake interface of ui/e2e/harness.ts (startFixture), on port 0.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { startFixture, rand, FIXTURE_ANCHOR, type Iface } from '../../e2e/harness.ts'

const here = import.meta.dirname
export const fixtureDir = resolve(here, '..', 'fixtures', 'run')
export const screensDir = resolve(here, '../../screens/')
const adrFile = resolve(here, '..', '..', '..', 'plugins', 'truss', 'docs', 'adr', '0023-factory-floor-ui.md')

// The states and widths come from ADR-0023's two lines, so the specs and the ADR cannot drift apart.
const adr = readFileSync(adrFile, 'utf8')
export const STATES = (adr.match(/^Screenshot states: (.+)$/m)?.[1] ?? '').split(', ').filter(Boolean)
export const WIDTHS: Array<[string, number]> = (() => {
  const m = adr.match(/^Screenshot widths: phone (\d+) px, tablet (\d+) px, desktop (\d+) px$/m)
  if (!m) throw new Error('ADR-0023 has no "Screenshot widths:" line')
  return [['phone', +m[1]!], ['tablet', +m[2]!], ['desktop', +m[3]!]]
})()
export const THEMES = ['light', 'dark'] as const
export type Theme = (typeof THEMES)[number]
export const HEIGHT = 900
export const T = { timeout: 5000 }
export const LOAD = { timeout: 10000 }

// ---- the tokens ------------------------------------------------------------------------------------------

export interface Tokens { colors: Record<string, { light: string; dark: string }>; [k: string]: any }
export const tokens: Tokens = JSON.parse(readFileSync(resolve(here, 'tokens.json'), 'utf8'))

/** The CSS colour string a browser computes for a token hex: rgb(r, g, b). */
export function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}
export function token(name: string, theme: Theme): string { return rgb(tokens.colors[name]![theme]) }

// ---- the planted state -----------------------------------------------------------------------------------

export interface Scenario {
  /** The page URL (through the fake interface's proxy). */
  url: string
  /** The per-run value planted in the fixture copy. */
  run: string
  /** The crew slug that carries the per-run value (quota-api in the fixtures). */
  apiSlug: string
  /** The planted snapshot, times unshifted (the text the page shows). */
  fixture: any
  iface: Iface
  /** A fixture stamp as the server serves it: startFixture moves every time so the anchor is the start time. */
  shown(iso: string): string
  /** Changes one thing the server holds, pushed as a delta. */
  change(): void
  stop(): Promise<void>
}

/**
 * Plants a fixture. `name` is a state slug, or `<state>/<file>` (live-counter/stale). The fixture is copied to an
 * mkdtemp dir with a per-run value planted into the crew slug, the goal and the first transcript line; the fixture
 * itself is only read.
 */
// `edit` changes the planted copy (after the per-run value is in), never the fixture file.
export async function scenario(name: string, opts: { now?: number; edit?: (fixture: any, apiSlug: string) => void } = {}): Promise<Scenario> {
  const [state, file = 'state'] = name.split('/')
  const run = `${rand()}${randomBytes(2).toString('hex')}`
  const apiSlug = `quota-api-${run}`
  const raw = readFileSync(join(fixtureDir, state!, `${file}.json`), 'utf8').replaceAll('quota-api', apiSlug)
  const fixture = JSON.parse(raw)
  const tag = randomUUID().slice(0, 8)
  if (fixture.run?.goal) {
    for (const g of fixture.run.goals ?? []) if (g.goal === fixture.run.goal) g.goal = `${g.goal} ${tag}-${run}`
    fixture.run.goal = `${fixture.run.goal} ${tag}-${run}`
  }
  const first = (fixture.transcript ?? []).find((e: any) => e.role === 'user')
  if (first) first.text = `${first.text} ${tag}-${run}`
  // ADR-0028 section 2: the server sets approvalAsk on a reply request. The approval fixture's turn is a plan
  // approval ask, so the planted copy says so; the fixture file itself is not touched.
  if (state === 'approval') for (const r of fixture.requests ?? []) if (r.kind === 'reply') r.approvalAsk = true
  opts.edit?.(fixture, apiSlug)
  const dir = mkdtempSync(join(tmpdir(), 'truss-redesign-'))
  mkdirSync(join(dir, state!), { recursive: true })
  writeFileSync(join(dir, state!, `${file}.json`), JSON.stringify(fixture, null, 2))
  const now = opts.now ?? Date.now()
  const iface = await startFixture(relative(fixtureDir, join(dir, state!, file)), { now })
  const shift = now - Date.parse(FIXTURE_ANCHOR)
  const change = () => {
    if (state === 'crews-running') {
      iface.emit({ run: { ...fixture.run, crews: fixture.run.crews.map((c: any) => (c.slug === apiSlug ? { ...c, status: 'merged' } : c)) } })
    } else if (state === 'retro') {
      const at = new Date().toISOString()
      const step = (status: string, detail: string | null) => ({ status, at, detail })
      iface.emit({ retro: { ...fixture.retro, steps: { ...fixture.retro.steps, judges: step('done', null), triage: step('running', `triaging ${run}`) } } })
    } else if (state === 'decisions') {
      iface.emit({ decisions: [...fixture.decisions, { n: 99, run: fixture.decisions[0]?.run ?? '', text: `12:00 | decision marker ${run} | the redesign spec | none | followed` }] })
    } else {
      iface.emit(null, [{ n: 100, role: 'user', text: `hello ${run}`, ts: new Date().toISOString(), id: `msg-${run}`, intent: null }])
    }
  }
  return {
    url: iface.url, run, apiSlug, fixture, iface, change,
    shown: (iso: string) => new Date(Date.parse(iso) + shift).toISOString(),
    stop: async () => { await iface.stop(); rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) },
  }
}

/** The deliverable count per type filter chip, as ADR-0023 section 4 (artifacts) derives it from the state. */
export function typeCounts(f: any): Record<'All' | 'Docs' | 'Code' | 'Plan' | 'Images', number> {
  const Plan = f.design?.planMd != null ? 1 : 0
  // ADR-0028 section 3 (R-37): ADRs are listed in the rail timeline only, so Deliverables hold no ADR item.
  const Docs = f.design?.architecture != null ? 1 : 0
  const Code = (f.run?.crews ?? []).filter((c: any) => c.status === 'merged').length
  const Images = (f.design?.images ?? []).length
  return { All: Plan + Docs + Code + Images, Docs, Code, Plan, Images }
}

/**
 * The composer textbox name (ADR-0028 section 1): "Your goal" while no goal is sent (the empty state), else
 * "Message to the PM". The send button follows: "Start run" with no plan, else "Send to PM".
 */
export const boxName = (state: string): string => (state === 'empty' ? 'Your goal' : 'Message to the PM')

/** Every context runs in this time zone, so a clock time the page shows can be built from the fixture. */
export const TZ = 'UTC'

/** `<day HH:MM>` for an RFC 3339 stamp in TZ: the short English weekday and the 24-hour time (ADR-0023, live-counter). */
export function dayTime(iso: string): string {
  const d = new Date(iso)
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: TZ }).format(d)
  return `${day} ${hhmm(iso)}`
}
/** `HH:MM` for an RFC 3339 stamp in TZ. */
export function hhmm(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

// ---- opening a page --------------------------------------------------------------------------------------

export interface Opened { page: Page; context: BrowserContext; problems: () => Promise<string[]>; close(): Promise<void> }

/** Opens the scenario's page in a context of its own: the colour scheme is the theme, the width is CSS px at scale 1. */
// `before` runs on the new page before it loads, to route a request (a held stream, a failed POST).
export async function openState(browser: Browser, s: Scenario, theme: Theme, width: number, opts: { before?: (page: Page) => Promise<void> } = {}): Promise<Opened> {
  const context = await browser.newContext({ colorScheme: theme, viewport: { width, height: HEIGHT }, deviceScaleFactor: 1, timezoneId: TZ, locale: 'en-US' })
  const page = await context.newPage()
  const problems = await watch(page)
  if (opts.before) await opts.before(page)
  await page.goto(s.url)
  return { page, context, problems, close: () => context.close() }
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
