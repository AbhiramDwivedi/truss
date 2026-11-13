// The run's event and decision logs: D/events.jsonl and D/decisions.md. Split from bin/factory/shared.ts (0.32.0 item 8); the only
// factory leaf that loads hooks/register.ts (for localTime). Never imports factory.ts, whose top-level await would make an import
// cycle.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import type { Obj } from '../core.ts'
import { localTime } from '../../hooks/register.ts'

// Appends {"v":1,"ts":now,...obj} as one line to D/events.jsonl.
export function appendEvent(dir: string, obj: Obj): void {
  appendFileSync(`${dir}/events.jsonl`, JSON.stringify({ v: 1, ts: new Date().toISOString(), ...obj }) + '\n')
}
// Appends `- HH:MM | <what | why> | none | followed` (local time, localTime from the hooks) to D/decisions.md; text is "what | why".
export function appendDecision(dir: string, text: string): void {
  appendDecisionLine(dir, `- ${localTime(Date.now())} | ${text} | none | followed`)
}
// The one append step appendDecision and `decide` share (ADR-0027 F-73): a newline guard, then the line and its newline.
export function appendDecisionLine(dir: string, line: string): void {
  const p = `${dir}/decisions.md`
  const old = existsSync(p) ? readFileSync(p, 'utf8') : ''
  appendFileSync(p, `${old === '' || old.endsWith('\n') ? '' : '\n'}${line}\n`)
}
