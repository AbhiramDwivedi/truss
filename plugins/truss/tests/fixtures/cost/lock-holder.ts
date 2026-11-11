// Child process for cost-026.check.ts. argv: <store.ts path> <session dir> <hold ms>
// Takes the usage lock of the session dir with the real withLock, prints one line {"held":true} and keeps the lock for <hold ms>, then releases it.
import { writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [storePath, dir, holdMs] = process.argv.slice(2)
const store: any = await import(pathToFileURL(storePath).href)

store.withLock(
  dir,
  'usage',
  () => {
    writeSync(1, JSON.stringify({ held: true }) + '\n') // a sync write: the event loop is blocked below
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs))
  },
  { waitMs: 30_000 },
)
