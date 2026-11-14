// admit's counterpart reap (ADR-0015): kills the process groups a finished heavy run left behind. Split from
// bin/factory/resources.ts (0.32.0 item 8). Never imports factory.ts, whose top-level await would make an import cycle.
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { isObj, need } from '../core.ts'
import type { Flags, Obj } from '../core.ts'
import { groupAlive, killGroup } from '../../resources/index.ts'
import { dirOf } from './cli.ts'
import { GROUPS, pidAlive, sleepSync } from './slot.ts'

export function cmdReap(f: Flags): Obj {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  const label = need(f, 'label')
  const reaped: number[] = []
  const skipped: number[] = []
  const gdir = GROUPS(dir)
  for (const name of existsSync(gdir) ? readdirSync(gdir) : []) {
    const file = `${gdir}/${name}`
    let rec: Obj
    try {
      rec = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (!isObj(rec) || rec.slug !== slug || rec.label !== label || !Number.isInteger(rec.pgid)) continue
    if (pidAlive(rec.heavyPid)) {
      skipped.push(rec.pgid)
      continue
    }
    if (groupAlive(rec.pgid)) {
      killGroup(rec.pgid, 'SIGTERM')
      for (let i = 0; i < 20 && groupAlive(rec.pgid); i++) sleepSync(100)
      if (groupAlive(rec.pgid)) killGroup(rec.pgid, 'SIGKILL')
    }
    rmSync(file, { force: true })
    reaped.push(rec.pgid)
  }
  return { reaped, skipped }
}
