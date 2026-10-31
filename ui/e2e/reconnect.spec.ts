// ui-web: SSE drop and replay (ADR-0011 Decision 5; R-3, R-15). The real createServer on port 0 behind the
// harness proxy; the proxy cuts the browser's connection while the same server instance keeps emitting deltas.
// Written from the spec before ui/web exists.
import { test, expect, type Page } from '@playwright/test'
import { startInterface, rand, WITHIN, INSTANCE_RE, type Iface } from './harness.ts'

async function withIface(fn: (iface: Iface) => Promise<void>): Promise<void> {
  const iface = await startInterface({})
  try { await fn(iface) } finally { await iface.stop() }
}
async function open(page: Page, iface: Iface): Promise<void> {
  await page.goto(iface.url)
  await expect(page.getByRole('banner')).toBeVisible({ timeout: 10000 })
}
let n = 0
const entry = (text: string) => ({ n: ++n, role: 'assistant', text, ts: new Date().toISOString() })
// Delivers one transcript entry per call, as the server would.
const say = (iface: Iface, text: string) => iface.emit(null, [entry(text)])
const count = (page: Page, text: string) => page.getByText(text, { exact: false }).count()

test.describe('SSE drop and replay', () => {
  test('R-3, R-15: deltas emitted while the connection is dropped show exactly once after reconnect, with no reload', async ({ page }) => {
    await withIface(async (iface) => {
      await open(page, iface)
      await page.evaluate(() => { (window as any).__noReload = 'still here' })
      const tag = rand()
      say(iface, `before-${tag}`)
      await expect(page.getByText(`before-${tag}`)).toBeVisible(WITHIN)
      await expect.poll(() => iface.sseRequests.length).toBeGreaterThan(0)
      const connections = iface.sseRequests.length
      const seqAtCut = iface.seq

      iface.refuse(true)
      iface.cut()
      const dropped = [1, 2, 3, 4, 5].map((i) => `dropped-${i}-${tag}`)
      for (const t of dropped) say(iface, t)
      iface.setSession({ model: `model-while-dropped-${tag}`, status: 'running' })
      // Nothing can reach the page while it is cut off.
      await page.waitForTimeout(300)
      expect(await count(page, `dropped-1-${tag}`)).toBe(0)

      iface.refuse(false)
      // The page reconnects by itself and shows everything it missed, within 2 s of the line being back.
      for (const t of dropped) await expect(page.getByText(t)).toBeVisible({ timeout: 5000 })
      await expect(page.getByRole('banner')).toContainText(`model-while-dropped-${tag}`, WITHIN)

      // Exactly once each, including the one shown before the drop.
      for (const t of [`before-${tag}`, ...dropped]) expect(await count(page, t), t).toBe(1)
      // It reconnected, naming the last delta it had: Last-Event-ID is <instance>:<seq>.
      expect(iface.sseRequests.length).toBeGreaterThan(connections)
      const re = iface.sseRequests.slice(connections).find((r) => r.lastEventId !== null)
      expect(re, 'a reconnect with Last-Event-ID').toBeTruthy()
      expect(re!.lastEventId).toBe(`${iface.instance}:${seqAtCut}`)
      expect(re!.lastEventId!.split(':')[0]).toMatch(INSTANCE_RE)
      // No reload happened.
      expect(await page.evaluate(() => (window as any).__noReload)).toBe('still here')

      // A delta after the replay still arrives, once.
      say(iface, `after-${tag}`)
      await expect(page.getByText(`after-${tag}`)).toBeVisible(WITHIN)
      expect(await count(page, `after-${tag}`)).toBe(1)
    })
  })

  test('R-3: several drops in a row lose nothing and repeat nothing', async ({ page }) => {
    await withIface(async (iface) => {
      await open(page, iface)
      await page.evaluate(() => { (window as any).__noReload = 'still here' })
      const tag = rand()
      const all: string[] = []
      for (let round = 0; round < 3; round++) {
        iface.refuse(true)
        iface.cut()
        for (let i = 0; i < 3; i++) { const t = `r${round}-${i}-${tag}`; all.push(t); say(iface, t) }
        await page.waitForTimeout(150)
        iface.refuse(false)
        for (const t of all) await expect(page.getByText(t)).toBeVisible({ timeout: 5000 })
      }
      for (const t of all) expect(await count(page, t), t).toBe(1)
      expect(await page.evaluate(() => (window as any).__noReload)).toBe('still here')
    })
  })

  test('R-3: a request card opened while the connection was dropped shows after reconnect', async ({ page }) => {
    await withIface(async (iface) => {
      await open(page, iface)
      const tag = rand()
      iface.refuse(true)
      iface.cut()
      iface.permission({ toolName: 'Bash', title: `Opened while dropped ${tag}`, summary: 'ls', input: { command: 'ls' } })
      await page.waitForTimeout(200)
      iface.refuse(false)
      await expect(page.getByText(`Opened while dropped ${tag}`).first()).toBeVisible({ timeout: 5000 })
      expect(await count(page, `Opened while dropped ${tag}`)).toBeGreaterThan(0)
      await expect(page.getByRole('button', { name: /approve|allow/i })).toHaveCount(1)
    })
  })

  test('R-3: a restarted server (new instance) gives a fresh snapshot the page shows', async ({ page }) => {
    await withIface(async (iface) => {
      await open(page, iface)
      await page.evaluate(() => { (window as any).__noReload = 'still here' })
      const tag = rand()
      const oldInstance = iface.instance
      say(iface, `old-instance-${tag}`)
      await expect(page.getByText(`old-instance-${tag}`)).toBeVisible(WITHIN)
      const connections = iface.sseRequests.length

      iface.refuse(true)
      iface.cut()
      iface.setSession({ model: `model-after-restart-${tag}` })
      await iface.restart()
      expect(iface.instance).not.toBe(oldInstance)
      expect(iface.seq).toBe(0) // seq is back at 0 on the new instance
      iface.refuse(false)

      // The page shows the new snapshot's state.
      await expect(page.getByRole('banner')).toContainText(`model-after-restart-${tag}`, { timeout: 5000 })
      // It asked with the old instance's id, which the new instance does not know: a snapshot, not a replay.
      const re = iface.sseRequests.slice(connections).find((r) => r.lastEventId !== null)
      expect(re!.lastEventId!.startsWith(`${oldInstance}:`)).toBe(true)
      // What was in the snapshot shows once, with no duplicate from the old connection.
      expect(await count(page, `old-instance-${tag}`)).toBe(1)

      // Deltas of the new instance start again at seq 1 and still show, once.
      say(iface, `new-instance-${tag}`)
      await expect(page.getByText(`new-instance-${tag}`)).toBeVisible(WITHIN)
      expect(await count(page, `new-instance-${tag}`)).toBe(1)
      expect(iface.seq).toBe(1)
    })
  })

  test('R-3: a snapshot with v: 2 makes the page reload', async ({ page }) => {
    await withIface(async (iface) => {
      await open(page, iface)
      await page.evaluate(() => { (window as any).__before = 'marker' })
      let served = 0
      await page.route('**/api/events*', async (route) => {
        if (served++ > 0) return route.continue()
        const snap = { type: 'snapshot', instance: iface.instance, seq: 0, state: { v: 2, somethingRenamed: true } }
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' },
          body: `retry: 1000\nid: ${iface.instance}:0\nevent: snapshot\ndata: ${JSON.stringify(snap)}\n\n`,
        })
      })
      const navigated = page.waitForEvent('framenavigated', { predicate: (f) => f === page.mainFrame(), timeout: 8000 })
      iface.cut() // the page reconnects and is served the v: 2 snapshot
      await navigated
      // The reload came back with a fresh page that talks to the real server again.
      await expect(page.getByRole('banner')).toBeVisible({ timeout: 10000 })
      expect(await page.evaluate(() => (window as any).__before)).toBeUndefined()
      const tag = rand()
      say(iface, `after-reload-${tag}`)
      await expect(page.getByText(`after-reload-${tag}`)).toBeVisible(WITHIN)
    })
  })
})
