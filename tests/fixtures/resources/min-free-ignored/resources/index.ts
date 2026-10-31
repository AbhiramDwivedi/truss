// Negative control for tests/resources-contract.check.ts (ADR-0015): a complete resources module whose threshold is a
// fixed number. It must fail `case: TRUSS_MIN_FREE_MB sets the threshold`. The sampler and `admits` are right; only
// `minFreeMB` ignores the env.
import os from 'node:os'
import { readFileSync } from 'node:fs'

export const DEFAULT_MIN_FREE_MB = 2048

export function sample(): { freeMB: number; totalMB: number; cpus: number } {
  const seam = process.env.TRUSS_SAMPLE
  if (seam !== undefined && seam !== '') {
    if (seam === 'error') throw new Error('TRUSS_SAMPLE=error')
    const s = JSON.parse(readFileSync(seam, 'utf8'))
    if (typeof s?.freeMB !== 'number' || typeof s?.totalMB !== 'number' || s.freeMB < 0 || s.totalMB < 0) throw new Error('bad sample')
    return s
  }
  return { freeMB: Math.round(os.freemem() / 2 ** 20), totalMB: Math.round(os.totalmem() / 2 ** 20), cpus: os.availableParallelism() }
}

// The defect: the threshold is fixed, so TRUSS_MIN_FREE_MB changes nothing.
export function minFreeMB(_env: Record<string, string | undefined> = process.env): number {
  return DEFAULT_MIN_FREE_MB
}

export function admits(s: { freeMB: number }, min: number): boolean {
  return s.freeMB >= min
}
