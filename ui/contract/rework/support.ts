// Helpers for the rework specs (ADR-0028 section 11). The specs reach the page by role only; nothing here touches
// the DOM by selector. Every state is a fixture under fixtures/rework/<state>/state.json planted into the fake
// interface of ui/e2e/harness.ts (startInterface), on port 0. The fixture's times move so that its anchor is `now`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { startInterface, shiftTimes, FIXTURE_ANCHOR, type Iface } from '../../e2e/harness.ts'

const here = import.meta.dirname
export const reworkFixtureDir = resolve(here, '..', 'fixtures', 'rework')
export const adrFile = resolve(here, '..', '..', '..', 'plugins', 'truss', 'docs', 'adr', '0028-ui-rework.md')

// The states come from ADR-0028's "Rework fixture states:" line, so the specs and the ADR cannot drift apart.
export const STATES: string[] = (readFileSync(adrFile, 'utf8').match(/^Rework fixture states: (.+)$/m)?.[1] ?? '').split(', ').filter(Boolean)
export const THEMES = ['light', 'dark'] as const
export type Theme = (typeof THEMES)[number]
/** The widths ADR-0028 and the UX direction test at (section 7), CSS px. */
export const WIDTHS = { phone: 360, zoom200: 720, tablet: 768, narrow: 1024, desktop: 1280, wide: 1440 } as const
export const HEIGHT = 900
export const TZ = 'UTC'
export const T = { timeout: 5000 }
export const LOAD = { timeout: 10000 }

/** The whole planted state of a fixture, times unshifted (the file as it is on disk). */
export function readState(name: string): any {
  if (!STATES.includes(name)) throw new Error(`${name} is not in ADR-0028's "Rework fixture states:" line`)
  return JSON.parse(readFileSync(join(reworkFixtureDir, name, 'state.json'), 'utf8'))
}

export interface Planted {
  /** The page URL (through the fake interface's proxy). */
  url: string
  /** The fixture as planted, times unshifted. */
  fixture: any
  iface: Iface
  /** A fixture stamp as the page shows it: every time moves so the anchor is the start time. */
  shown(iso: string): string
  stop(): Promise<void>
}

/**
 * Plants a rework fixture by name. `edit` changes the copy before it is planted (never the file on disk); `now`
 * is the instant the fixture's anchor is moved to (default: the real now).
 */
export async function plant(name: string, opts: { now?: number; edit?: (state: any) => void } = {}): Promise<Planted> {
  const fixture = readState(name)
  const copy = structuredClone(fixture)
  opts.edit?.(copy)
  const now = opts.now ?? Date.now()
  const shift = now - Date.parse(FIXTURE_ANCHOR)
  const { session, requests, ...rest } = shiftTimes(copy, shift)
  const iface = await startInterface({ state: rest })
  iface.setSession(session)
  // open requests go through the registry, oldest first, so the page can answer them (as harness startFixture does)
  for (const r of requests as any[]) {
    if (r.status !== 'open') continue
    if (r.kind === 'question') iface.question(r.questions)
    else if (r.kind === 'permission') iface.permission({ toolName: r.toolName, title: r.title, summary: r.summary, input: r.input, decisionReason: r.decisionReason, blockedPath: r.blockedPath })
    else iface.reply({ text: r.text, isError: r.isError, backgroundTasks: r.backgroundTasks, approvalAsk: r.approvalAsk })
  }
  return {
    url: iface.url, fixture, iface,
    shown: (iso: string) => new Date(Date.parse(iso) + shift).toISOString(),
    stop: () => iface.stop(),
  }
}

export interface Opened { page: Page; context: BrowserContext; problems: () => Promise<string[]>; close(): Promise<void> }

/** Opens the page in a context of its own: the colour scheme is the theme, the width is CSS px at scale 1. */
// `before` runs on the new page before it loads, to route a request (a held stream, a failed POST).
export async function openState(browser: Browser, p: Planted, theme: Theme, width: number, opts: { before?: (page: Page) => Promise<void>; reducedMotion?: boolean; coarse?: boolean } = {}): Promise<Opened> {
  const context = await browser.newContext({
    colorScheme: theme, viewport: { width, height: HEIGHT }, deviceScaleFactor: 1, timezoneId: TZ, locale: 'en-US',
    reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference', hasTouch: opts.coarse === true, isMobile: opts.coarse === true,
  })
  const page = await context.newPage()
  const problems = await watch(page)
  if (opts.before) await opts.before(page)
  await page.goto(p.url)
  return { page, context, problems, close: () => context.close() }
}

/** Plants `name`, opens it at `width` and `theme`, and returns both with one stop(). */
export async function openFixture(browser: Browser, name: string, theme: Theme, width: number, opts: { now?: number; edit?: (state: any) => void; before?: (page: Page) => Promise<void>; reducedMotion?: boolean; coarse?: boolean } = {}): Promise<Opened & { planted: Planted; stop(): Promise<void> }> {
  const planted = await plant(name, { now: opts.now, edit: opts.edit })
  const opened = await openState(browser, planted, theme, width, opts)
  return { ...opened, planted, stop: async () => { await opened.close(); await planted.stop() } }
}

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

/** `HH:MM` for an RFC 3339 stamp in TZ (the time a card shows). */
export function hhmm(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** A scratch dir for a spec that needs one; remove it with rm(). */
export function scratch(prefix = 'truss-rework-'): { dir: string; write(rel: string, text: string): string; rm(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return {
    dir,
    write(rel, text) { const f = join(dir, rel); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, text); return f },
    rm() { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) },
  }
}

// ADR-0028 §179: drop the CSP reports mermaid's render logs. Mermaid's SVG, its DOMPurify and d3, and MermaidBlock's re-parse emit them;
// the CSP sets no style-src, so the console line names default-src and the securitypolicyviolation lines name style-src-elem/attr.
export const unexpected = (lines: string[]) => lines.filter((l) => !/Failed to load resource/.test(l) && !/Applying inline style violates the following Content Security Policy directive/.test(l) && !/^csp: style-src-(elem|attr) inline$/.test(l))
