// The gates command (ADR-0046 item 1): several pre-QC gate steps in one runner call. Moved unchanged from bin/factory.ts
// (0.31.0 item 5). Never imports factory.ts, whose top-level await would make an import cycle.
import path from 'node:path'
import { CliError, isObj, need, str, usage } from '../store.ts'
import type { Obj } from '../store.ts'
import { heavyMain } from './heavy.ts'
import { dirOf, FACTORY, parseFlags, repoOf } from './shared.ts'

// ==== gates (ADR-0046 item 1, batching) ====

// The steps `gates` can run, in the order stage.js reaches them before QC: the green check (through the heavy slot), the owns
// check, the tests check, the knowledge lint and the QC admission. stage.js sends them as one runner call instead of one each.
export const GATE_STEPS = ['green', 'owns', 'tests', 'lint', 'admit'] as const
export type GateStep = (typeof GATE_STEPS)[number]
// a lint is met when it has no failure the crew's diff caused (new: false marks one already there at the merge base), the same
// rule stage.js uses to send the writer back (isNewFinding); predating failures and warnings go to QC, so they do not stop the gates
export function gateMet(step: GateStep, body: Obj): boolean {
  if (step === 'admit') return body.admitted === true
  if (step === 'lint') return Array.isArray(body.failures) && body.failures.every((x: unknown) => isObj(x) && x.new === false)
  return body.ok === true
}

// `gates --slug S --steps a,b,... [--cwd W --expect E --label L --tests-since SHA --wait-ms N] [--admit-label L --admit-title T
// --admit-wait-ms N]`: runs each step as its own command would (green as `heavy ... -- factory check`), in the order given,
// stopping at the first unmet one. Prints {ok, stopped, gates: {step: met}, codes: {step: exit}, steps: {step: body}}, plus
// green's head, env and heavy meta at the top so the status line carries them. Exit 0 when every step is met, else the stopped
// step's exit (1 when that was 0). The single commands stay as they are.
// `main` is the dispatcher in factory.ts, passed in so this module never imports factory.ts (factory.ts exports gatesMain bound to it).
export async function gatesRun(argv: string[], main: (argv: string[]) => { body: Obj; code: number }): Promise<{ body: Obj; code: number }> {
  try {
    const f = parseFlags(argv)
    const dir = path.resolve(dirOf(f))
    const repo = repoOf(f)
    const slug = need(f, 'slug')
    const steps = (need(f, 'steps') as string).split(',').map((s) => s.trim()).filter(Boolean)
    if (steps.length === 0) throw usage('--steps names no step')
    for (const s of steps) if (!(GATE_STEPS as readonly string[]).includes(s)) throw usage(`unknown gate step: ${s}; steps: ${GATE_STEPS.join(', ')}`)
    if (new Set(steps).size !== steps.length) throw usage('--steps names a step twice')
    const dr = ['--dir', dir, '--repo', repo]
    const gates: Obj = {}
    const codes: Obj = {}
    const out: Obj = {}
    let stopped: string | null = null
    let top: Obj = {}
    for (const s of steps as GateStep[]) {
      let r: { body: Obj; code: number }
      if (s === 'green') {
        const cwd = need(f, 'cwd')
        const since = str(f, 'tests-since')
        const wait = str(f, 'wait-ms')
        const self = [process.execPath, ...process.execArgv, FACTORY]
        const inner = [...self, 'check', '--slug', slug, '--cwd', cwd, '--expect', str(f, 'expect') ?? 'green', ...(since ? ['--tests-since', since] : []), ...dr]
        r = await heavyMain([...dr, '--slug', slug, '--label', str(f, 'label') ?? `${slug}-check`, '--cwd', cwd, ...(wait ? ['--wait-ms', wait] : []), '--', ...inner])
        top = { ...(typeof r.body.head === 'string' ? { head: r.body.head } : {}), ...(typeof r.body.env === 'string' ? { env: r.body.env } : {}), ...(isObj(r.body.heavy) ? { heavy: r.body.heavy } : {}) }
      } else if (s === 'admit') {
        const label = str(f, 'admit-label')
        const title = str(f, 'admit-title')
        // ADR-0046 item 1: a call that ran green (up to HEAVY_WAIT_MS for the slot, then the suite) never adds an admit wait, so
        // the whole call stays inside the runner's 600 s Bash timeout; stage.js re-runs a held admit alone, with its own wait
        const admitWait = steps.includes('green') ? '0' : (str(f, 'admit-wait-ms') ?? '0')
        r = main(['admit', '--wait-ms', admitWait, '--slug', slug, ...(label !== undefined ? ['--label', label] : []), ...(title !== undefined ? ['--title', title] : []), ...dr])
      } else {
        const cmd = s === 'owns' ? 'owns-check' : s === 'tests' ? 'tests-check' : 'knowledge-lint'
        r = main([cmd, '--slug', slug, ...dr])
      }
      out[s] = r.body
      codes[s] = r.code
      gates[s] = gateMet(s, r.body)
      if (!gates[s]) {
        stopped = s
        break
      }
    }
    const ok = stopped === null
    const code = ok ? 0 : (codes[stopped as string] as number) || 1
    return { body: { ok, stopped, gates, codes, ...top, steps: out }, code }
  } catch (e) {
    if (e instanceof CliError) return { body: e.body, code: e.code }
    return { body: { error: e instanceof Error ? e.message : String(e) }, code: 2 }
  }
}
