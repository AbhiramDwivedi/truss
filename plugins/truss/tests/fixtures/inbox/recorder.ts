// A notify command for tests/inbox.check.ts: appends one JSON line {stdin, env} to the file named by argv[2], where env holds the TRUSS_INBOX_* variables it got.
import { appendFileSync } from 'node:fs'

let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  stdin += c
})
process.stdin.on('end', () => {
  const env: Record<string, string | undefined> = {}
  for (const k of ['TRUSS_INBOX_ID', 'TRUSS_INBOX_KIND', 'TRUSS_INBOX_REPO', 'TRUSS_INBOX_TITLE']) env[k] = process.env[k]
  appendFileSync(process.argv[2] as string, JSON.stringify({ stdin, env }) + '\n')
})
