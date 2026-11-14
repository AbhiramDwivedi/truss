// stage.js module: runFactory: factory.ts commands through a Sonnet runner. Edit here, then run `npm run build:stage`.
// ---------------------------------------------------------------- runner

const clip = (s, n = 4000) => (s.length > n ? s.slice(s.length - n) : s)

// Runs one factory.ts command through the runner. met: the parsed stdout has key === true. The key decides, not res.exit:
// the runner relays the JSON's own exit field (the acceptance test's exit), and factory.ts prints the key true only when it exits 0.
// one shell word: bare when only safe characters, else single-quoted with each ' written as '\''
const sh = (v) => {
  const s = String(v)
  return /^[A-Za-z0-9_./:@=+,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`
}

// ADR-0019 item 11: the whole stdout when it is one JSON object, else its last line that is a JSON object (npm warnings,
// git chatter or a runner's own lines around the result line are skipped); null when there is none
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
function lastJsonObject(stdout) {
  const tryParse = (s) => {
    try {
      return JSON.parse(s)
    } catch {
      return undefined
    }
  }
  const whole = tryParse(stdout)
  if (isPlainObject(whole)) return whole
  const lines = stdout.replace(/\r/g, '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim()
    if (!l.startsWith('{')) continue
    const v = tryParse(l)
    if (isPlainObject(v)) return v
  }
  return null
}

// ADR-0027 F-67: the truss dir every factory.ts line carries, absolute: an absolute F.dir as is, else resolved against
// F.repo. A runner or heavy inner command runs with its own cwd, where a relative dir (.git/truss/<id>) does not resolve.
const trussDir = () => (F.dir.startsWith('/') ? F.dir : `${F.repo.replace(/\/+$/, '')}/${F.dir}`)

// extra: one more line after the command, so a resumed call gets its own cache key (the runtime caches by prompt); null
// leaves the prompt exactly as it was
async function runFactory(crew, command, key, line = null, extra = null) {
  // ADR-0046 item 1: a gates result is good only up to the next runner call (dropGates)
  dropGates(crew)
  // ADR-0046 item 1: a reap left due by the last member spawn runs first inside this same command (--reap-first <slug>,
  // before heavy's `--`), so it costs no runner spawn. A reap command itself never carries it.
  const fold = !!crew.reapDue && !/^reap\b/.test(String(command || ''))
  const rf = fold ? ` --reap-first ${sh(crew.slug)}` : ''
  // R-142: the admission of the member that starts right after this call (crew.admitPlan, set by the step before it) rides on the
  // call too (--admit-first), and its answer waits in crew.admitFirst for admit(). Any other runner call voids an earlier answer.
  const plan = crew.admitPlan && !/^reap\b/.test(String(command || '')) ? crew.admitPlan : null
  crew.admitFirst = null
  const af = plan ? ` --admit-first ${sh(crew.slug)} --admit-label ${sh(plan.label)} --admit-title ${sh(plan.title)}${plan.persona ? ` --admit-persona ${sh(plan.persona)}` : ''}${plan.high ? ' --admit-high' : ''}` : ''
  // the flags go just before --dir, so --dir, --repo and --status-line stay last
  const base = line ? (rf || af ? line.replace(/ --dir /, `${rf}${af} --dir `) : line) : null
  const full = base ?? `node ${sh(`${F.plugin}/bin/factory.ts`)} ${command}${rf}${af} --dir ${sh(trussDir())} --repo ${sh(F.repo)} --status-line`
  const prompt = [
    'Run exactly the one command below, as written, in a single shell call. Do not change directory and do not run anything else.',
    ...(line ? ['Run it with a Bash timeout of 600000.'] : []),
    "Return the command's exit code as exit and its full standard output as stdout.",
    `Return as status the last line of standard output that starts with \`${STATUS_PREFIX}\`: copy that line character for character, or "" when there is none.`,
    '',
    full,
    ...(extra ? [extra] : []),
  ].join('\n')
  const res = await ask(crew, 'runner', prompt, { schema: RUNNER_SCHEMA })
  if (!res || typeof res.stdout !== 'string') return { met: false, parsed: null, out: 'the runner returned no result' }
  const fromStdout = lastJsonObject(res.stdout)
  if (fold && full.includes(rf)) {
    // the reap ran (or failed) inside the command; a failure is logged as a separate reap's was, and never stops the crew
    crew.reapDue = false
    const rr = fromStdout && fromStdout.reapedFirst
    if (isPlainObject(rr) && !Array.isArray(rr.reaped)) crew.proofs.push(`reap failed: ${typeof rr.error === 'string' ? rr.error : JSON.stringify(rr)}`)
  }
  // the admission answer, as admit() takes it: no answer (a factory without --admit-first) leaves the member its own admit call
  const af1 = plan && fromStdout && isPlainObject(fromStdout.admittedFirst) ? fromStdout.admittedFirst : null
  if (af1) {
    crew.admitFirst = { label: plan.label, title: plan.title, persona: plan.persona || null, high: !!plan.high, noWait: true, met: af1.admitted === true, parsed: af1, exit: res.exit, out: `exit ${res.exit}\n${JSON.stringify(af1)}` }
    crew.admitPlan = null
  }
  const status = statusOf(res.status)
  // ADR-0022 U5: the status line decides met, its fields laid over the stdout JSON (heavy.ran from its ran); an empty or
  // unparseable status falls back to the stdout rule
  if (status && Object.keys(status).length > 0) {
    const parsed = { ...(fromStdout || {}), ...status }
    if (typeof status.ran === 'boolean') parsed.heavy = { ...(isPlainObject(fromStdout && fromStdout.heavy) ? fromStdout.heavy : {}), ran: status.ran }
    return { met: status[key] === true, parsed, exit: res.exit, out: `exit ${res.exit}\n${res.stdout}` }
  }
  const met = fromStdout !== null && typeof fromStdout === 'object' && fromStdout[key] === true
  return { met, parsed: fromStdout, exit: res.exit, out: `exit ${res.exit}\n${res.stdout}` }
}

