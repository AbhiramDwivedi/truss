// Child process for resources/heavy-lock.check.ts. argv: <resources/index.ts path> <dir> <counter file> <count> <startAt ms>
// Waits until startAt, then does <count> read-modify-write increments of <counter file>, each while holding the heavy slot.
// takeHeavySlot never waits, so a null take is retried every millisecond. Two holders at once lose an increment.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [modPath, dir, file, count, startAt] = process.argv.slice(2)
const m: any = await import(pathToFileURL(modPath).href)
const pause = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

while (Date.now() < Number(startAt)) pause(1)
const deadline = Date.now() + 30_000
let done = 0
while (done < Number(count)) {
  if (Date.now() > deadline) {
    console.error(`timed out after ${done} increments`)
    process.exit(1)
  }
  const token = m.takeHeavySlot(dir, { label: `w${process.pid}`, slug: 'race' })
  if (token === null) {
    pause(1)
    continue
  }
  const n = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0
  pause(2)
  writeFileSync(file, String(n + 1))
  m.releaseHeavySlot(dir, token)
  done++
}
console.log(JSON.stringify({ ok: true }))
