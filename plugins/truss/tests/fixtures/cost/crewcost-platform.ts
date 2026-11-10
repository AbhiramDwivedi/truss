// node crewcost-platform.ts <cost.ts path> <dir> <repo> <slug> [win32]
// Prints crewCost as one JSON line. With `win32` it fakes process.platform before cost.ts is imported (cost.ts reads process.platform at call time).
import { pathToFileURL } from 'node:url'

const [costPath, dir, repo, slug, fake] = process.argv.slice(2)
if (fake === 'win32') Object.defineProperty(process, 'platform', { value: 'win32' })
const c = await import(pathToFileURL(costPath).href)
console.log(JSON.stringify(c.crewCost(dir, repo, slug)))
