// Child process for store.check.ts. argv: <store.ts path> <mode> ...
//   append <dir> <lock> <file> <count> <tag>   runs appendJsonl <count> times
//   counter <dir> <lock> <file> <count>        <count> locked read-modify-write increments of <file>
//   exclusive <path> <id>                      runs one createExclusive, prints {"won": boolean}
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [storePath, mode, ...rest] = process.argv.slice(2)
const store: any = await import(pathToFileURL(storePath).href)

if (mode === 'append') {
  const [dir, lock, file, count, tag] = rest
  for (let i = 0; i < Number(count); i++) store.appendJsonl(dir, lock, file, { tag, i, pad: 'x'.repeat(200) })
  console.log(JSON.stringify({ ok: true }))
} else if (mode === 'exclusive') {
  const [target, id] = rest
  const won = store.createExclusive(target, { id })
  console.log(JSON.stringify({ won }))
} else if (mode === 'counter') {
  // a read-modify-write under withLock; two holders at once lose an increment
  const [dir, lock, file, count] = rest
  for (let i = 0; i < Number(count); i++) {
    store.withLock(dir, lock, () => {
      const n = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
      writeFileSync(file, String(n + 1))
    }, { waitMs: 30_000 })
  }
  console.log(JSON.stringify({ ok: true }))
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(2)
}
