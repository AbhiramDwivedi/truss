// Child process for store.check.ts. argv: <store.ts path> <mode> ...
//   append <dir> <lock> <file> <count> <tag>   runs appendJsonl <count> times
//   exclusive <path> <id>                      runs one createExclusive, prints {"won": boolean}
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
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(2)
}
