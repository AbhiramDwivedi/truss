// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
//
// ADR-0046 item 1: stage.js sends the checks before QC as one `factory gates` runner call. The stubbed stage harnesses answer one
// factory command per runner prompt, so gatesAware(agent) wraps a harness's stub agent: a runner prompt holding `factory.ts gates`
// is split into the single-command prompts stage.js sent before (the same lines runFactory writes), each answered by the
// harness's own agent in order, stopping at the first unmet step as factory gates does; the answers are folded into the one
// result factory gates prints. Every other prompt goes to the agent unchanged. Each sub-call is recorded by the harness as
// before, under the gates call's label, so a test counts runner spawns by distinct label (spawnLabels).

// shell words of one command line: bare words and single-quoted words ('\'' inside), as stage.js sh() writes them
export function shellWords(line) {
  const out = []
  let cur = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") {
      const end = line.indexOf("'", i + 1)
      cur = (cur ?? '') + line.slice(i + 1, end < 0 ? line.length : end)
      i = end < 0 ? line.length : end
    } else if (/\s/.test(c)) {
      if (cur !== null) out.push(cur)
      cur = null
    } else cur = (cur ?? '') + c
  }
  if (cur !== null) out.push(cur)
  return out
}
const sh = (v) => {
  const s = String(v)
  return /^[A-Za-z0-9_./:@=+,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`
}
const GATES_RE = /factory\.ts'?\s+gates\b/
const KEY = { green: 'ok', owns: 'ok', tests: 'ok', lint: 'ok', admit: 'admitted' }
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function lastJson(stdout) {
  const tryParse = (s) => {
    try {
      return JSON.parse(s)
    } catch {
      return undefined
    }
  }
  const whole = tryParse(stdout)
  if (isObj(whole)) return whole
  for (const l of String(stdout).replace(/\r/g, '').split('\n').reverse()) {
    const v = l.trim().startsWith('{') ? tryParse(l.trim()) : undefined
    if (isObj(v)) return v
  }
  return null
}
function statusJson(s) {
  if (typeof s !== 'string' || !s.trim().startsWith('truss-status: ')) return null
  try {
    const v = JSON.parse(s.trim().slice('truss-status: '.length))
    return isObj(v) ? v : null
  } catch {
    return null
  }
}
// factory.ts gateMet: a lint is met with no failure the crew's diff caused. Many harnesses answer knowledge-lint with a bare
// default object; with no failures list it counts as met here (stage.js treats such output as an unparsed lint and goes on to QC).
function metOf(step, body) {
  if (step === 'lint') return Array.isArray(body.failures) ? body.failures.every((x) => isObj(x) && x.new === false) : body.ok !== false
  return body[KEY[step]] === true
}

// the single-command runner prompts a gates prompt stands for, one per step, in order
export function splitGates(prompt) {
  const lines = prompt.split('\n')
  const at = lines.findIndex((l) => GATES_RE.test(l))
  if (at < 0) return null
  const w = shellWords(lines[at])
  const bin = w[1]
  const flag = (n) => {
    const i = w.indexOf(`--${n}`)
    return i < 0 ? undefined : w[i + 1]
  }
  const slug = flag('slug')
  const dr = `--dir ${sh(flag('dir'))} --repo ${sh(flag('repo'))}`
  const reap = flag('reap-first')
  const head = lines.slice(0, at).filter((l) => !/^Run it with a Bash timeout/.test(l))
  const extra = lines.slice(at + 1)
  const steps = String(flag('steps') || '').split(',').filter(Boolean)
  return steps.map((step, k) => {
    const rf = k === 0 && reap !== undefined ? ` --reap-first ${sh(reap)}` : ''
    const plain = (cmd) => `node ${sh(bin)} ${cmd}${rf} --dir ${sh(flag('dir'))} --repo ${sh(flag('repo'))} --status-line`
    let line
    if (step === 'green') {
      const cwd = sh(flag('cwd'))
      // runFactory folds --reap-first in just before the first --dir, as here
      line = `node ${sh(bin)} heavy${rf} ${dr} --slug ${sh(slug)} --label ${sh(flag('label') || `${slug}-check`)} --cwd ${cwd} --status-line -- node ${sh(bin)} check --slug ${sh(slug)} --cwd ${cwd} --expect ${sh(flag('expect') || 'green')} ${dr}`
      return { step, prompt: [head[0], 'Run it with a Bash timeout of 600000.', ...head.slice(1), line].join('\n') }
    }
    if (step === 'owns') line = plain(`owns-check --slug ${sh(slug)}`)
    else if (step === 'tests') line = plain(`tests-check --slug ${sh(slug)}`)
    else if (step === 'lint') line = plain(`knowledge-lint --slug=${sh(slug)}`)
    else line = plain(`admit --wait-ms ${sh(flag('admit-wait-ms') || '90000')} --slug ${sh(slug)} --label ${sh(flag('admit-label'))} --title ${sh(flag('admit-title'))}`)
    return { step, prompt: [...head, line, ...(step === 'tests' ? extra : [])].join('\n') }
  })
}

// wraps a stub agent(prompt, opts) so it answers a gates prompt as factory gates would
export function gatesAware(agent) {
  return async (prompt, opts = {}) => {
    const subs = typeof prompt === 'string' && /-runner(-\d+)?$/.test(String(opts.label)) ? splitGates(prompt) : null
    if (!subs) return agent(prompt, opts)
    const gates = {}
    const codes = {}
    const steps = {}
    let stopped = null
    let top = {}
    for (const { step, prompt: p } of subs) {
      // factory gates runs each step in its own process and always has its JSON. A stub answer it could not have given (a thrown
      // runner, no result, output that does not parse) stops here and leaves the step out, so stage.js runs it alone and meets
      // that answer there, as before.
      let res
      try {
        // gatesStep marks the call as one step of a gates spawn, so a harness that counts labels can tell it from a second spawn
        res = await agent(p, { ...opts, gatesStep: step })
      } catch {
        res = null
      }
      const parsed = res && typeof res.stdout === 'string' ? lastJson(res.stdout) : null
      if (!parsed) {
        stopped = step
        break
      }
      const status = statusJson(res.status)
      const body = parsed
      const judged = status && Object.keys(status).length ? { ...body, ...status } : body
      steps[step] = body
      codes[step] = Number.isInteger(res.exit) ? res.exit : 0
      gates[step] = metOf(step, judged)
      if (step === 'green') top = { ...(typeof judged.head === 'string' ? { head: judged.head } : {}), ...(typeof judged.env === 'string' ? { env: judged.env } : {}) }
      if (!gates[step]) {
        stopped = step
        break
      }
    }
    const ok = stopped === null
    const body = { ok, stopped, gates, codes, ...top, steps }
    const exit = ok ? 0 : codes[stopped] || 1
    return { exit, stdout: JSON.stringify(body), status: `truss-status: ${JSON.stringify({ ok, ...top, gates, stopped })}` }
  }
}

// runner spawns of a stubbed stage run: one per distinct runner label (a gates call's sub-calls share its label)
export const spawnLabels = (calls) => [...new Set(calls.filter((c) => /-runner(-\d+)?$/.test(String(c.label))).map((c) => c.label))]
