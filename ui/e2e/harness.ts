// Shared helpers for ui-web's Playwright specs (ADR-0011; frontend rules; Decisions 5, 6, 9).
// Two ways to run the real server, both on port 0, both on a fresh temp dir:
//   startReal      the real ui/server/main.ts on a copy of real Truss files (live-files.spec.ts).
//   startInterface the real createServer from ui/server/http/index.ts, with small implementations of the
//                  Decision 9 interfaces (StateSource, SessionControl). They are interface implementations,
//                  not a fake Claude session: answers go through the real createRegistry(). The Agent SDK is
//                  never mocked, and the plugin (hooks/, bin/, scripts/) is never imported.
// An HTTP proxy on port 0 sits between the page and the interface server, so a test can cut the browser's
// SSE connection while the same server instance keeps emitting deltas, or restart into a new instance.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { createServer } from '../server/http/index.ts'
import { createRegistry } from '../server/session/index.ts'
// The D2 colour check (tokens.json bg on body, move on the move surface) each spec file runs once.
export { expectD2Colours, d2Colour, type D2Theme } from '../contract/e2e/colours.ts'

const here = import.meta.dirname
export const uiDir = resolve(here, '..')
export const repoRoot = resolve(uiDir, '..')
export const root = join(repoRoot, 'plugins', 'truss')
export const WITHIN = { timeout: 2000 }

// ---- locators ------------------------------------------------------------------------------------------

export const rx = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
export const rand = () => randomBytes(4).toString('hex')

// ---- ADR-0018 shell, by role and accessible name --------------------------------------------------------
// Roles and names are fixed by ADR-0018 section 10; none of these reaches the page by class, tag or id.
export const yourMove = (page: Page): Locator => page.getByRole('region', { name: 'Your move', exact: true })
// ADR-0028 section 1: the textarea is "Your goal" before a run and "Message to the PM" during one.
export const goalBox = (page: Page): Locator => page.getByRole('textbox', { name: /^(Your goal|Message to the PM)$/ })
// ADR-0028 section 1: the send button says what will happen: "Start run", "Send to PM" or "Add as new goal".
export const sendButton = (page: Page): Locator => page.getByRole('button', { name: /^(Start run|Send to PM|Add as new goal)$/ })
// A crew card: an article named by its slug in the Build network region (ADR-0028 section 10; UX direction 6).
export const crewLine = (page: Page, slug: string): Locator =>
  page.getByRole('region', { name: 'Build network', exact: true }).getByRole('article', { name: new RegExp(`\\b${slug}\\b`, 'i') }).first()
// ADR-0028 section 3: the rail's "Decisions and ADRs" timeline is the one list of ADRs and decisions.
export const adrTimeline = (page: Page): Locator => page.getByRole('region', { name: 'Decisions and ADRs', exact: true })
// ADR-0028 section 10: deliverables are in main with no tab; "Architecture" is the first item and opens in the preview.
export const deliverables = (page: Page): Locator => page.getByRole('region', { name: /deliverables/i })
export async function openArchitecture(page: Page): Promise<void> {
  await deliverables(page).getByRole('button', { name: /^Architecture/ }).first().click()
}
export const sessionStatus = (page: Page): Locator => page.getByRole('status', { name: 'Session', exact: true })
export const runStatus = (page: Page): Locator => page.getByRole('list', { name: 'Run status', exact: true })
export const CARD = {
  question: /^Question from Claude: /,
  permission: /^Permission request: /,
  reply: /^(The PM replied|Approval needed)$/, // ADR-0028 section 2: replaces "Reply needed"
} as const
// A request card (an article) of one kind, optionally narrowed to the ones that hold `text`.
export function card(page: Page, kind: keyof typeof CARD, text?: RegExp | string): Locator {
  let l = page.getByRole('article', { name: CARD[kind] })
  if (text !== undefined) l = l.filter({ hasText: typeof text === 'string' ? rx(text) : text })
  return l
}

// ---- real files (startReal) ----------------------------------------------------------------------------

// A valid 1x1 PNG.
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

export interface RealOpts {
  // Edits plan.json (parsed) before the server starts.
  plan?: (plan: any) => void
  // Event lines written to events.jsonl before the server starts.
  events?: Array<Record<string, unknown>>
  // Files written to the Truss dir before the server starts, by relative path.
  trussFiles?: Record<string, string | Buffer>
  // Images committed on crew branches before the server starts: branch `truss-<slug>`, repo-relative path.
  images?: Array<{ slug: string; path: string }>
}
export interface Real {
  url: string
  dir: string
  repo: string
  trussDir: string
  stderr(): string
  stop(): Promise<void>
  writePlan(edit: (plan: any) => void): void
  appendEvent(fields: Record<string, unknown>): void
  appendEvents(lines: Array<Record<string, unknown>>): void
  writeQc(crew: string, verdict: 'PASS' | 'FAIL', name?: string): void
  appendDecision(line: string): void
  writeAdr(file: string, title: string, status: string): void
  writeTrussFile(rel: string, content: string | Buffer): void
  commitImage(slug: string, path: string): void
}

export function spawnEvent(crew: string, agent: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const fields: Array<[string, unknown]> = [['v', 1], ['ts', new Date().toISOString()], ['event', 'spawn'], ['crew', crew], ['agent', agent], ['agentId', `a${rand()}`], ['type', 'kit:builder'], ['model', 'sonnet'], ['effort', 'medium'], ['by', crew]]
  return { ...Object.fromEntries(fields), ...extra }
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Truss UI test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' })
}

export async function startReal(opts: RealOpts = {}): Promise<Real> {
  const dir = mkdtempSync(join(tmpdir(), 'truss-ui-e2e-'))
  const repo = join(dir, 'repo')
  const trussDir = join(dir, 'truss-dir')
  mkdirSync(join(repo, 'docs', 'adr'), { recursive: true })
  mkdirSync(join(repo, '.claude'), { recursive: true })
  mkdirSync(trussDir, { recursive: true })
  // The real architecture doc and ADR, a config that names them, the real fixture and the real example plan.
  cpSync(join(root, 'docs', 'architecture.md'), join(repo, 'docs', 'architecture.md'))
  cpSync(join(root, 'docs', 'adr', '0001-design-phase.md'), join(repo, 'docs', 'adr', '0001-design-phase.md'))
  const cfg = Object.fromEntries([['architecture', 'docs/architecture.md'], ['adr', 'docs/adr'], ['merge', 'sequential'], ['target', 'main']])
  writeFileSync(join(repo, '.claude', 'truss.json'), JSON.stringify(cfg))
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'init'])
  cpSync(join(root, 'tests', 'fixtures', 'retro-040'), trussDir, { recursive: true })
  const plan = JSON.parse(readFileSync(join(root, 'docs', 'plan.example.json'), 'utf8'))
  opts.plan?.(plan)
  writeFileSync(join(trussDir, 'plan.json'), JSON.stringify(plan, null, 2))

  const real: Real = {
    url: '', dir, repo, trussDir,
    stderr: () => stderr,
    stop: async () => {
      const c = child
      if (c && c.exitCode === null) {
        await new Promise<void>((done) => { c.once('exit', () => done()); c.kill('SIGTERM'); setTimeout(() => { c.kill('SIGKILL'); done() }, 3000) })
      }
      rmSync(dir, { recursive: true, force: true })
    },
    writePlan(edit) {
      const p = JSON.parse(readFileSync(join(trussDir, 'plan.json'), 'utf8'))
      edit(p)
      writeFileSync(join(trussDir, 'plan.json'), JSON.stringify(p, null, 2))
    },
    appendEvent: (fields) => appendFileSync(join(trussDir, 'events.jsonl'), JSON.stringify(fields) + '\n'),
    appendEvents: (lines) => appendFileSync(join(trussDir, 'events.jsonl'), lines.map((l) => JSON.stringify(l) + '\n').join('')),
    writeQc(crew, verdict, name = `${crew}-qc.md`) {
      mkdirSync(join(trussDir, 'reports', crew), { recursive: true })
      writeFileSync(join(trussDir, 'reports', crew, name), `VERDICT: ${verdict}\n\nChecked by the e2e harness.\n`)
    },
    appendDecision: (line) => appendFileSync(join(trussDir, 'decisions.md'), line.endsWith('\n') ? line : line + '\n'),
    writeAdr(file, title, status) {
      writeFileSync(join(repo, 'docs', 'adr', file), `# ${title}\n\nStatus: ${status}\n`)
    },
    writeTrussFile(rel, content) {
      mkdirSync(dirname(join(trussDir, rel)), { recursive: true })
      writeFileSync(join(trussDir, rel), content)
    },
    commitImage(slug, path) {
      const branch = `truss-${slug}`
      let exists = true
      try { git(repo, ['rev-parse', '--verify', '-q', branch]) } catch { exists = false }
      git(repo, exists ? ['checkout', '-q', branch] : ['checkout', '-q', '-b', branch, 'main'])
      mkdirSync(dirname(join(repo, path)), { recursive: true })
      writeFileSync(join(repo, path), PNG)
      git(repo, ['add', path])
      git(repo, ['commit', '-q', '-m', `add ${path}`])
      git(repo, ['checkout', '-q', 'main'])
    },
  }
  for (const [rel, content] of Object.entries(opts.trussFiles ?? {})) real.writeTrussFile(rel, content)
  if (opts.events?.length) real.appendEvents(opts.events)
  for (const i of opts.images ?? []) real.commitImage(i.slug, i.path)

  let stderr = ''
  const args = [join(uiDir, 'server', 'main.ts'), '--repo', repo, '--plugin', root, '--truss-dir', trussDir, '--port', '0']
  const child: ChildProcess = spawn(process.execPath, args)
  child.stderr?.on('data', (d) => { stderr += String(d) })
  try {
    real.url = await new Promise<string>((ok, fail) => {
      let out = ''
      const t = setTimeout(() => fail(new Error(`no URL line within 15 s; stderr: ${stderr}`)), 15000)
      const re = /truss-ui listening on (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/
      child.stdout?.on('data', (d) => { out += String(d); const m = out.match(re); if (m) { clearTimeout(t); ok(m[1]!) } })
      child.on('exit', (c) => { clearTimeout(t); fail(new Error(`server exited ${c}; stderr: ${stderr}`)) })
    })
  } catch (e) {
    await real.stop()
    throw e
  }
  return real
}

// ---- interface implementations (startInterface) --------------------------------------------------------

export const INSTANCE_RE = /^[0-9a-f]{16}$/

export interface Call {
  kind: 'send' | 'answer'
  at: number // Date.now() when the call reached the SessionControl
  id?: string // answer: the request id
  text?: string // send: the text
  body?: unknown // answer: the body as posted
  result: unknown
}
export interface SseRequest { at: number; lastEventId: string | null }

// A schema-valid state (ui/contract/state.schema.json, "state"): an idle session, nothing else yet.
export function baseState(over: Record<string, unknown> = {}): any {
  return {
    v: 1, repo: '/tmp/truss-ui-e2e-repo', trussDir: { path: null, exists: false },
    session: { status: 'idle', sessionId: null, model: null, claudeCodeVersion: null, permissionMode: null, plugin: null, usage: null, backgroundTasks: [], error: null },
    requests: [], transcript: [], run: null, decisions: [], adrs: [], design: null, notices: [],
    ...over,
  }
}

export interface QuestionSpec { question: string; header: string; multiSelect?: boolean; options: Array<{ label: string; description?: string }> }

function makeSource(initial: any, images = new Map<string, Buffer>()) {
  const instance = randomBytes(8).toString('hex')
  const state = structuredClone(initial)
  const log: any[] = []
  const subs = new Set<(d: any) => void>()
  const src = {
    instance, state, images,
    get seq() { return log.length },
    emit(set: Record<string, unknown> | null, appendTranscript?: any[]) {
      const d: any = { type: 'delta', seq: log.length + 1 }
      if (set) { d.set = structuredClone(set); for (const [k, v] of Object.entries(set)) state[k] = structuredClone(v) }
      if (appendTranscript?.length) { d.append = { transcript: structuredClone(appendTranscript) }; state.transcript = [...state.transcript, ...appendTranscript].slice(-500) }
      log.push(d)
      for (const f of [...subs]) f(d)
      return d
    },
    snapshot: () => ({ type: 'snapshot', instance, seq: log.length, state: structuredClone(state) }),
    since: (seq: number) => (Number.isInteger(seq) && seq >= 0 && seq <= log.length ? log.slice(seq) : null),
    subscribe(fn: (d: any) => void) { subs.add(fn); return () => { subs.delete(fn) } },
    async readImage(ref: string, path: string) { return images.get(`${ref}\0${path}`) ?? null },
  }
  return src
}

export interface Iface {
  /** The page URL (through the proxy). No token needed: the proxy presents the current server's cookie. */
  url: string
  /** The current instance id (changes at restart). */
  readonly instance: string
  /** Every SessionControl call, in arrival order. */
  calls: Call[]
  /** Every SSE connection the page opened, with the Last-Event-ID it sent. */
  sseRequests: SseRequest[]
  /** Pushes a numbered delta: replaces each key of `set` whole and/or appends transcript entries. */
  emit(set: Record<string, unknown> | null, appendTranscript?: any[]): void
  readonly seq: number
  /** Replaces session fields (header: model, usage, status ...). */
  setSession(patch: Record<string, unknown>): void
  /** Opens a question card (recommended first when the caller orders it so). Returns the request id. */
  question(qs: QuestionSpec[]): string
  /** Opens an approval card for a tool call. Returns the request id. */
  permission(o: { toolName: string; title: string; summary: string; input?: Record<string, unknown>; decisionReason?: string | null; blockedPath?: string | null }): string
  /** Opens a "reply needed" card. Returns the request id. */
  reply(o: { text: string; isError?: boolean; backgroundTasks?: number; approvalAsk?: boolean }): string
  /** The registry's view of the requests (what the page should show). */
  requests(): any[]
  /** Makes the next send() fail with 'ended', as after the session ended. */
  endSession(): void
  /** Serves bytes for GET /api/image?ref=&path= (the pair must also be in design.images). */
  setImage(ref: string, path: string, bytes: Buffer): void
  /** Destroys every socket between the page and the server, now. The server instance keeps running. */
  cut(): void
  /** While true, new connections from the page are destroyed on arrival (an outage). */
  refuse(on: boolean): void
  /** Closes the server and starts a new instance on the same state: new instance id, seq back at 0, new token. */
  restart(): Promise<void>
  stop(): Promise<void>
}

export async function startInterface(opts: { state?: Record<string, unknown>; webDir?: string } = {}): Promise<Iface> {
  const webDir = opts.webDir ?? join(uiDir, 'web')
  let src = makeSource(baseState(opts.state))
  const registry = createRegistry(() => iface.emit({ requests: registry.list() }))
  const calls: Call[] = []
  const sseRequests: SseRequest[] = []
  let ended = false
  // New entries continue after any transcript the initial state carries (a planted fixture).
  let nTranscript = Math.max(0, ...((opts.state?.transcript as Array<{ n: number }> | undefined) ?? []).map((e) => e.n))

  // The StateSource handed to createServer delegates to the current instance, so restart() can swap it.
  const state = {
    snapshot: () => src.snapshot(),
    since: (seq: number) => src.since(seq),
    subscribe: (fn: (d: any) => void) => src.subscribe(fn),
    readImage: (ref: string, path: string) => src.readImage(ref, path),
  }
  const session = {
    send(text: string) {
      let result: any
      if (typeof text !== 'string' || text.trim() === '') result = { ok: false, error: 'text' }
      else if (ended) result = { ok: false, error: 'ended' }
      else {
        const open = registry.list().find((r) => r.kind === 'reply' && r.status === 'open')
        if (open) registry.answer(open.id, { decision: 'message', message: text })
        iface.emit(null, [{ n: ++nTranscript, role: 'user', text, ts: new Date().toISOString() }])
        result = { ok: true }
      }
      calls.push({ kind: 'send', at: Date.now(), text, result })
      return result
    },
    answer(id: string, body: unknown) {
      const result = registry.answer(id, body)
      calls.push({ kind: 'answer', at: Date.now(), id, body, result })
      return result
    },
  }

  let upstream = createServer({ state, session, webDir })
  let up = await upstream.listen(0)

  // The proxy: the page talks to it, it talks to the server with the server's own Host, Origin and cookie.
  const socks = new Set<Socket>()
  let refusing = false
  const proxy = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
    const mine = `http://127.0.0.1:${up.port}`
    if (req.url?.startsWith('/api/events')) {
      const le = req.headers['last-event-id']
      sseRequests.push({ at: Date.now(), lastEventId: typeof le === 'string' ? le : null })
    }
    const headers = { ...req.headers, host: `127.0.0.1:${up.port}`, cookie: `truss-ui-${up.port}=${up.token}` }
    if (headers.origin) headers.origin = mine
    const out = http.request({ host: '127.0.0.1', port: up.port, method: req.method, path: req.url, headers, agent: false }, (ures) => {
      const h = { ...ures.headers }
      if (typeof h.location === 'string') h.location = h.location.replace(mine, base)
      res.writeHead(ures.statusCode ?? 502, h)
      res.flushHeaders()
      ures.pipe(res)
      ures.on('error', () => res.destroy())
    })
    out.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end() } else res.destroy() })
    res.on('close', () => out.destroy())
    req.pipe(out)
  })
  proxy.on('connection', (s) => {
    if (refusing) return void s.destroy()
    socks.add(s)
    s.on('close', () => socks.delete(s))
  })
  await new Promise<void>((ok) => proxy.listen(0, '127.0.0.1', ok))
  const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/`

  const iface: Iface = {
    url, calls, sseRequests,
    get instance() { return src.instance },
    get seq() { return src.seq },
    emit: (set, appendTranscript) => { src.emit(set, appendTranscript) },
    setSession: (patch) => { src.emit({ session: { ...src.state.session, ...patch } }) },
    question(qs) {
      const questions = qs.map((q) => ({
        question: q.question, header: q.header, multiSelect: q.multiSelect === true,
        options: q.options.map((o) => ({ label: o.label, description: o.description ?? '', recommended: o.label.endsWith(' (Recommended)') })),
      }))
      return registry.open({ kind: 'question', questions, answers: null }).id
    },
    permission: (o) => registry.open({ kind: 'permission', toolName: o.toolName, title: o.title, summary: o.summary, input: o.input ?? {}, decisionReason: o.decisionReason ?? null, blockedPath: o.blockedPath ?? null, decision: null, message: null }).id,
    reply: (o) => registry.open({ kind: 'reply', text: o.text, isError: o.isError === true, backgroundTasks: o.backgroundTasks ?? 0, decision: null, message: null, ...(o.approvalAsk === undefined ? {} : { approvalAsk: o.approvalAsk }) } as Parameters<typeof registry.open>[0]).id, // approvalAsk: ADR-0028 section 2
    requests: () => registry.list(),
    endSession() { ended = true },
    setImage(ref, path, bytes) { src.images.set(`${ref}\0${path}`, bytes) },
    cut() { for (const s of [...socks]) s.destroy() },
    refuse(on) { refusing = on },
    async restart() {
      const old = upstream
      const prev = src
      src = makeSource(prev.state, prev.images)
      upstream = createServer({ state, session, webDir })
      const next = await upstream.listen(0)
      up = next
      await old.close()
      iface.cut()
    },
    async stop() {
      iface.cut()
      await upstream.close()
      await new Promise<void>((ok) => { proxy.close(() => ok()); proxy.closeAllConnections() })
    },
  }
  return iface
}

// ---- planted fixtures (ADR-0023 section 6) ----------------------------------------------------------------

/** The instant every time in ui/contract/fixtures/run/<state>/*.json is relative to. */
export const FIXTURE_ANCHOR = '2026-11-02T12:00:00.000Z'
export const fixturesDir = join(uiDir, 'contract', 'fixtures', 'run')
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/

/** A copy of `v` with every RFC 3339 UTC string moved by `shift` ms. */
export function shiftTimes<T>(v: T, shift: number): T {
  if (typeof v === 'string') return (TIME.test(v) ? new Date(Date.parse(v) + shift).toISOString() : v) as T
  if (Array.isArray(v)) return v.map((x) => shiftTimes(x, shift)) as T
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shiftTimes(x, shift)])) as T
  return v
}

/**
 * Starts the fake interface on a fixture. `name` is a state slug (reads <state>/state.json) or `<state>/<file>`
 * (such as live-counter/stale). The fixture's times move so that its anchor is `now`. Session fields go through
 * setSession; open requests go through question(), permission() and reply(), oldest first, so the page can answer
 * them. The fixture file is only read.
 */
export async function startFixture(name: string, opts: { now?: number; webDir?: string } = {}): Promise<Iface> {
  const file = join(fixturesDir, name.includes('/') ? `${name}.json` : join(name, 'state.json'))
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const st: any = shiftTimes(raw, (opts.now ?? Date.now()) - Date.parse(FIXTURE_ANCHOR))
  const { session, requests, ...rest } = st
  const iface = await startInterface({ state: rest, webDir: opts.webDir })
  iface.setSession(session)
  for (const r of requests as any[]) {
    if (r.status !== 'open') continue
    if (r.kind === 'question') iface.question(r.questions)
    else if (r.kind === 'permission') iface.permission({ toolName: r.toolName, title: r.title, summary: r.summary, input: r.input, decisionReason: r.decisionReason, blockedPath: r.blockedPath })
    else iface.reply({ text: r.text, isError: r.isError, backgroundTasks: r.backgroundTasks, approvalAsk: r.approvalAsk })
  }
  return iface
}

// Removes a temp dir; for specs that make their own.
export function removeDir(p: string): void { rmSync(p, { recursive: true, force: true }) }
export function tempDir(prefix: string): string { return mkdtempSync(join(tmpdir(), prefix)) }
