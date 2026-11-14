// A private copy of the plugin for tests/trust-026.check.ts whose bin/transcripts.ts keeps every real export and overrides the two proof seams:
// proofTranscriptRoot() returns $TRUSS_TEST_PROOF_ROOT, and readProofFile(p, opts) appends p to the file $TRUSS_TEST_READ_LOG before the
// real one runs. Those two env names exist only in this stub, never in shipped code. Built once per process; never write inside it.
import { cpSync, renameSync, writeFileSync } from 'node:fs'
import { pluginCopy, tmp } from '../workflow-run/harness.ts'

let cached: string | undefined

/** The dir of the stubbed plugin copy; run its bin/factory.ts, or import its bin/inbox.ts and bin/guard.ts in this process. */
export function proofPlugin(): string {
  if (cached) return cached
  const d = tmp('proof-plugin-')
  cpSync(pluginCopy(), d, { recursive: true })
  renameSync(`${d}/bin/transcripts.ts`, `${d}/bin/transcripts-real.ts`)
  writeFileSync(`${d}/bin/transcripts.ts`, [
    `import { appendFileSync } from 'node:fs'`,
    `import * as real from './transcripts-real.ts'`,
    `export * from './transcripts-real.ts'`,
    `export const proofTranscriptRoot = () => String(process.env.TRUSS_TEST_PROOF_ROOT ?? '').replace(/\\\\/g, '/')`,
    `export function readProofFile(p, opts) {`,
    `  if (process.env.TRUSS_TEST_READ_LOG) appendFileSync(process.env.TRUSS_TEST_READ_LOG, String(p).replace(/\\\\/g, '/') + '\\n')`,
    `  return real.readProofFile(p, opts)`,
    `}`,
    '',
  ].join('\n'))
  cached = d
  return d
}
