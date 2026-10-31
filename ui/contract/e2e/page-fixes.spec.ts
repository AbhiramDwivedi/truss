// Browser contract for the page fixes of ADR-0014 (Decision 3, "The page", and Seams 5). Seven tests, each
// failing on a ui/web that lacks the fix. Self-contained: it starts createServer and createRegistry the way
// ui/e2e/harness.ts startInterface does, on port 0, and imports nothing from ui/e2e/. State is schema-valid
// (ui/contract/state.schema.json); no schema change is assumed, so the working status is derived from the
// `waiting` status plus backgroundTasks.length. Elements are found by role and accessible name; texts carry
// per-run random values.
import { test, expect, type Page } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { createServer } from '../../server/http/index.ts'
import { createRegistry } from '../../server/session/index.ts'

const uiDir = resolve(import.meta.dirname, '..', '..')
const WITHIN = { timeout: 3000 }
const rand = () => randomBytes(4).toString('hex')

function baseState(over: Record<string, unknown> = {}): any {
  return {
    v: 1, repo: '/tmp/truss-page-fixes-repo', trussDir: { path: null, exists: false },
    session: { status: 'idle', sessionId: null, model: null, claudeCodeVersion: null, permissionMode: null, plugin: null, usage: null, backgroundTasks: [], error: null },
    requests: [], transcript: [], run: null, decisions: [], adrs: [], design: null, notices: [],
    ...over,
  }
}
const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ taskId: `t-${rand()}-${i}`, description: `crew ${rand()}`, subagentType: null }))

interface Rig {
  url: string
  calls: Array<{ kind: 'send' | 'answer'; text?: string; id?: string }>
  emit(set: Record<string, unknown> | null, appendTranscript?: any[]): void
  setSession(patch: Record<string, unknown>): void
  question(q: { question: string; header: string; options: string[] }): string
  permission(summary: string): string
  reply(text: string, backgroundTasks?: number): string
  answer(id: string, body: unknown): void
  stop(): Promise<void>
}

async function start(initial: Record<string, unknown> = {}): Promise<Rig> {
  const state: any = structuredClone(baseState(initial))
  const log: any[] = []
  const subs = new Set<(d: any) => void>()
  const calls: Rig['calls'] = []
  let nTranscript = 0
  const emit: Rig['emit'] = (set, append) => {
    const d: any = { type: 'delta', seq: log.length + 1 }
    if (set) { d.set = structuredClone(set); for (const [k, v] of Object.entries(set)) state[k] = structuredClone(v) }
    if (append?.length) { d.append = { transcript: structuredClone(append) }; state.transcript = [...state.transcript, ...append] }
    log.push(d)
    for (const f of [...subs]) f(d)
  }
  const registry = createRegistry(() => emit({ requests: registry.list() }))
  const instance = randomBytes(8).toString('hex')
  const source = {
    snapshot: () => ({ type: 'snapshot', instance, seq: log.length, state: structuredClone(state) }),
    since: (seq: number) => (Number.isInteger(seq) && seq >= 0 && seq <= log.length ? log.slice(seq) : null),
    subscribe: (fn: (d: any) => void) => { subs.add(fn); return () => { subs.delete(fn) } },
    readImage: async () => null,
  }
  const session = {
    send(text: string) {
      if (typeof text !== 'string' || text.trim() === '') return { ok: false as const, error: 'text' as const }
      const open = registry.list().find((r: any) => r.kind === 'reply' && r.status === 'open')
      if (open) registry.answer(open.id, { decision: 'message', message: text })
      emit(null, [{ n: ++nTranscript, role: 'user', text, ts: new Date().toISOString() }])
      calls.push({ kind: 'send', text })
      return { ok: true as const }
    },
    answer(id: string, body: unknown) {
      const result = registry.answer(id, body)
      calls.push({ kind: 'answer', id })
      return result
    },
  }
  const server = createServer({ state: source, session, webDir: resolve(uiDir, 'web') })
  const up = await server.listen(0)
  return {
    url: up.url, calls, emit,
    setSession: (patch) => emit({ session: { ...state.session, ...patch } }),
    question: (q) => registry.open({
      kind: 'question', answers: null,
      questions: [{ question: q.question, header: q.header, multiSelect: false, options: q.options.map((label) => ({ label, description: '', recommended: false })) }],
    }).id,
    permission: (summary) => registry.open({ kind: 'permission', toolName: 'Bash', title: 'Bash', summary, input: {}, decisionReason: null, blockedPath: null, decision: null, message: null }).id,
    reply: (text, backgroundTasks = 0) => registry.open({ kind: 'reply', text, isError: false, backgroundTasks, decision: null, message: null }).id,
    answer: (id, body) => { registry.answer(id, body) },
    stop: () => server.close(),
  }
}

async function withRig(initial: Record<string, unknown>, body: (rig: Rig) => Promise<void>) {
  const rig = await start(initial)
  try { await body(rig) } finally { await rig.stop() }
}

async function open(page: Page, rig: Rig) {
  await page.goto(rig.url)
  await expect(page.getByRole('heading', { level: 1, name: 'Truss' })).toBeVisible(WITHIN)
}

test('R-18: after a keyboard answer to a question card, focus is on the next actionable element, never BODY', async ({ page }) => {
  await withRig({ session: baseState().session }, async (rig) => {
    const q1 = `Which lane ${rand()}?`
    const keep = `keep-${rand()}`
    rig.question({ question: q1, header: 'Lane', options: [keep, `other-${rand()}`] })
    rig.permission(`echo ${rand()}`)
    await open(page, rig)
    const radio = page.getByRole('radio', { name: keep })
    await expect(radio).toBeVisible(WITHIN)
    await radio.focus()
    await page.keyboard.press('Space')
    await expect(radio).toBeChecked()
    await page.getByRole('button', { name: 'Submit answers' }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('article', { name: /Question from Claude/ }).getByText('Answered.')).toBeVisible(WITHIN)
    const active = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null
      if (!a) return { tag: 'NONE', ok: false }
      const r = a.getBoundingClientRect()
      const actionable = ['INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'A'].includes(a.tagName) && !(a as HTMLInputElement).disabled
      return { tag: a.tagName, ok: actionable && r.width > 0 && r.height > 0 }
    })
    expect(active.tag, 'focus fell to the page body after the answer').not.toBe('BODY')
    expect(active.ok, `focus is on a visible, enabled, actionable element (got ${active.tag})`).toBe(true)
  })
})

test('the header reads "working (N background tasks)" while waiting with N background tasks', async ({ page }) => {
  const n = 2 + (parseInt(rand().slice(0, 2), 16) % 7)
  await withRig({ session: { ...baseState().session, status: 'waiting', backgroundTasks: tasks(n) } }, async (rig) => {
    await open(page, rig)
    await expect(page.getByText(`working (${n} background tasks)`)).toBeVisible(WITHIN)
  })
})

test('waiting with background tasks and no reply card: says agents still running, no Approve or Deny, result readable, message sends (R-7)', async ({ page }) => {
  const resultText = `turn result ${rand()}`
  const sent = `still here ${rand()}`
  await withRig({
    session: { ...baseState().session, status: 'waiting', backgroundTasks: tasks(2) },
    transcript: [{ n: 1, role: 'assistant', text: resultText, ts: new Date().toISOString() }],
  }, async (rig) => {
    await open(page, rig)
    await expect(page.getByText('Agents still running; nothing needed from you')).toBeVisible(WITHIN)
    await expect(page.getByRole('button', { name: /^(Approve|Deny)$/ })).toHaveCount(0)
    await expect(page.getByText(resultText)).toBeVisible()
    const box = page.getByRole('textbox', { name: 'Goal or message' })
    await expect(box).toBeEnabled()
    await box.fill(sent)
    await page.getByRole('button', { name: 'Send' }).click()
    await expect.poll(() => rig.calls.filter((c) => c.kind === 'send' && c.text === sent).length, WITHIN).toBe(1)
  })
})

test('the goal box grows with its text (no inner scroll after 10 lines) and is resizable', async ({ page }) => {
  await withRig({}, async (rig) => {
    await open(page, rig)
    const box = page.getByRole('textbox', { name: 'Goal or message' })
    await box.focus()
    for (let i = 1; i <= 10; i++) {
      await page.keyboard.type(`line ${i} ${rand()}`)
      if (i < 10) await page.keyboard.press('Enter')
    }
    const m = await box.evaluate((e: HTMLTextAreaElement) => ({ scroll: e.scrollHeight, client: e.clientHeight, resize: getComputedStyle(e).resize }))
    expect(m.scroll, `inner scroll: scrollHeight ${m.scroll} vs clientHeight ${m.client}`).toBeLessThanOrEqual(m.client + 1)
    expect(m.resize, 'the box can be resized by the user').not.toBe('none')
  })
})

test('the no-config and no-truss-dir notices read as status, tagged "Status:", not "Notice:"', async ({ page }) => {
  const a = `no config ${rand()}`
  const b = `no truss dir ${rand()}`
  await withRig({ notices: [{ id: 'no-config', text: a }, { id: 'no-truss-dir', text: b }] }, async (rig) => {
    await open(page, rig)
    for (const text of [a, b]) {
      const item = page.getByRole('listitem').filter({ hasText: text })
      await expect(item).toBeVisible(WITHIN)
      await expect(item).toContainText('Status:')
      await expect(item).not.toContainText('Notice:')
    }
  })
})

test('the tab title is "(<open requests>) Truss", and plain "Truss" at 0', async ({ page }) => {
  await withRig({}, async (rig) => {
    await open(page, rig)
    await expect(page).toHaveTitle('Truss')
    const question = `pick ${rand()}`
    const choice = `a-${rand()}`
    const q = rig.question({ question, header: 'Pick', options: [choice, `b-${rand()}`] })
    const p = rig.permission(`ls ${rand()}`)
    await expect(page).toHaveTitle('(2) Truss', WITHIN)
    rig.answer(q, { answers: { [question]: choice } })
    await expect(page).toHaveTitle('(1) Truss', WITHIN)
    rig.answer(p, { decision: 'deny' })
    await expect(page).toHaveTitle('Truss', WITHIN)
  })
})

test('desktop notifications: nothing asked before the enable click; question and permission each raise one; reply card and background status raise none', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any
    w.__asks = 0
    w.__notes = [] as string[]
    class FakeNotification {
      static permission = 'default'
      static requestPermission(cb?: (p: string) => void) {
        w.__asks++
        FakeNotification.permission = 'granted'
        if (cb) cb('granted')
        return Promise.resolve('granted')
      }
      constructor(title: string) { w.__notes.push(String(title)) }
      close() {}
      addEventListener() {}
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true })
  })
  const asks = () => page.evaluate(() => (window as any).__asks as number)
  const notes = () => page.evaluate(() => (window as any).__notes.length as number)
  await withRig({}, async (rig) => {
    await open(page, rig)
    rig.setSession({ status: 'running' })
    await page.waitForTimeout(400)
    expect(await asks(), 'nothing is asked before a click on the enable control').toBe(0)
    expect(await notes()).toBe(0)
    const enable = page.getByRole('button', { name: /notification/i })
    await expect(enable, 'an enable-notifications control exists').toBeVisible(WITHIN)
    await enable.click()
    await expect.poll(asks, WITHIN).toBe(1)
    rig.question({ question: `q ${rand()}`, header: 'Q', options: [`a-${rand()}`, `b-${rand()}`] })
    await expect.poll(notes, WITHIN).toBe(1)
    rig.permission(`rm ${rand()}`)
    await expect.poll(notes, WITHIN).toBe(2)
    rig.reply(`reply ${rand()}`, 0)
    rig.setSession({ status: 'waiting', backgroundTasks: tasks(2) })
    await page.waitForTimeout(800)
    expect(await notes(), 'a reply card and the background-task status raise no notification').toBe(2)
  })
})
