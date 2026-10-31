// Negative control for tests/resources-contract.check.ts (ADR-0015): a complete resources module whose admission always
// admits. It must fail `case: holds below the threshold` and nothing else. The threshold, the sampler and the
// default are right; only `admits` ignores the sample.
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

export function minFreeMB(env: Record<string, string | undefined> = process.env): number {
  const v = env.TRUSS_MIN_FREE_MB
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : DEFAULT_MIN_FREE_MB
}

// The defect: it admits whatever the sample says.
export function admits(_s: { freeMB: number }, _min: number): boolean {
  return true
}
