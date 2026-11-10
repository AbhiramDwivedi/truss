// Child process for ledger.check.ts. argv: <ledger.ts path> <repo> <tag>
// Appends one merge row through ledgerAppend and prints {"ok": true}.
import { pathToFileURL } from 'node:url'

const [ledgerPath, repo, tag] = process.argv.slice(2)
const ledger: any = await import(pathToFileURL(ledgerPath).href)

ledger.ledgerAppend(repo, { v: 1, ts: new Date().toISOString(), kind: 'merge', session: 'worker', crew: tag, goal: `goal ${tag}`, workType: null, process: 'full', qc: true, red: true, target: 'main', base: 'b'.repeat(40), head: 'c'.repeat(40), costUsd: null, costWhy: 'not recorded', pad: 'x'.repeat(300) })
console.log(JSON.stringify({ ok: true }))
