// retro (ADR-0012 Decision 8; R-23): reads <truss dir>/retro/state.json, which only the plugin writes, for the
// state's retro key. Returns the parsed value only when it is JSON, has v 1 and matches
// docs/retro-state.schema.json (as ui/contract/state.schema.json copies it); null otherwise. Unlike files.ts
// cached(), a file that fails to parse gives null, never the last good value. Reads only.
// Node built-ins only; erasable TypeScript.
import fs from 'node:fs'
import path from 'node:path'

export const RETRO_STEPS = ['extract', 'judges', 'triage', 'fixGoal', 'applied'] as const
const STATUSES = ['pending', 'running', 'done', 'failed', 'skipped']
const DATE_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function dateTime(v: unknown): boolean {
  return typeof v === 'string' && DATE_TIME.test(v) && !Number.isNaN(Date.parse(v))
}

function sameKeys(o: Record<string, unknown>, keys: readonly string[]): boolean {
  const have = Object.keys(o)
  return have.length === keys.length && keys.every((k) => k in o)
}

function stepOk(s: unknown): boolean {
  if (!isObject(s) || !sameKeys(s, ['status', 'at', 'detail'])) return false
  if (typeof s.status !== 'string' || !STATUSES.includes(s.status)) return false
  if (s.at !== null && !dateTime(s.at)) return false
  if (s.detail !== null && (typeof s.detail !== 'string' || s.detail.length > 200)) return false
  return true
}

export function validRetro(v: unknown): boolean {
  if (!isObject(v) || !sameKeys(v, ['v', 'updatedAt', 'steps'])) return false
  if (v.v !== 1 || !dateTime(v.updatedAt)) return false
  const steps = v.steps
  if (!isObject(steps) || !sameKeys(steps, RETRO_STEPS)) return false
  return RETRO_STEPS.every((k) => stepOk(steps[k]))
}

export function readRetro(trussDir: string): unknown {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(trussDir, 'retro', 'state.json'), 'utf8'))
    return validRetro(parsed) ? parsed : null
  } catch {
    return null
  }
}
