// stage.js module: batched gates (ADR-0046 item 1), the truss-status line and the heavy check lines. Edit here, then run `npm run build:stage`.
// ---------------------------------------------------------------- gates (ADR-0046 item 1, batching)

// The checks before QC (green, owns-check, tests-check, knowledge-lint, the QC admit) used to cost one runner spawn each. gates()
// sends the ones due now as one `factory gates` command; factory runs them in order and stops at the first unmet one. Each
// step's sub-result waits in crew.gates, and the step's own function (check, scope, testsGuard, knowledgeLint, admit) takes it
// instead of calling the runner, then judges it exactly as before. The runner judges nothing. A sub-result is dropped at the
// next runner call or member spawn, or when a merge moved the head, so a step never reads a result older than its inputs;
// a step with no sub-result (gates stopped before it, or the stdout was cut) runs alone, as before.
const GATE_KEY = { green: 'ok', owns: 'ok', tests: 'ok', lint: 'ok', admit: 'admitted' }
const dropGates = (crew) => {
  crew.gates = null
}

// the sub-result of `step` from the last gates call, or null. Steps listed before it are dropped (they were skipped or taken).
// match(g) checks the inputs the step would have sent (tests-since, the admit label).
function takeGate(crew, step, match = null) {
  const g = crew.gates
  if (!g) return null
  if (g.moves !== (crew.moves || 0)) {
    crew.gates = null
    return null
  }
  const i = g.order.indexOf(step)
  if (i < 0) return null
  g.order = g.order.slice(i + 1)
  const r = g.results[step]
  if (!r || (match && !match(g))) return null
  return r
}

// want: which steps the caller reaches next ({green, owns, tests, lint, admit}); each is kept only when the step would really
// call the runner now (its own skip rules). Fewer than two steps left: nothing is sent, and each step runs alone as before.
async function gates(crew, want) {
  const steps = []
  if (want.green && !(crew.head && unmoved(crew, 'greenAt'))) steps.push('green')
  if (want.owns && !unmoved(crew, 'scopeAt')) steps.push('owns')
  if (want.tests && !unmoved(crew, 'testsAt')) steps.push('tests')
  if (want.lint && (hasCodeTasks(crew) || knowledgeFilesExist()) && (steps.includes('green') || !(crew.lint && crew.lintHead === crew.head))) steps.push('lint')
  // the QC admit (runQc): its label and title as runQc will send them; never past the rework allowance, where qc stops first
  const admitLabel = want.admit && spendOf(crew) <= F.reworkAllowance ? peekLabel(crew, 'qc') : null
  const admitTitle = admitLabel ? titleOf(crew, 'qc') : null
  if (admitLabel) steps.push('admit')
  if (steps.length < 2) return
  const { bin, dr, slug, cwd } = heavyParts(crew)
  const attempt = (crew.e.answers || []).filter((a) => a && a.at === 'tests').length
  const parts = [`node ${bin} gates --slug ${slug} --steps ${steps.join(',')}`]
  if (steps.includes('green')) parts.push(`--cwd ${cwd} --expect green --label ${sh(`${crew.slug}-check`)}`)
  // a call that runs green may already spend HEAVY_WAIT_MS (540 s) on the slot: its admit waits 0, so the call stays under the
  // 600 s Bash timeout, and a memory hold there is re-run alone by admit() with its own 90 s wait
  const admitWait = steps.includes('green') ? 0 : 90000
  if (admitLabel) parts.push(`--admit-label ${sh(admitLabel)} --admit-title ${sh(admitTitle)} --admit-wait-ms ${admitWait}`)
  parts.push(`${dr} --status-line`)
  // the tests check's extra lines (Attempt, Head) ride along, so a resumed call keeps its own cache key
  const extra = steps.includes('tests') ? testsCheckExtra(crew, attempt ? `Attempt: ${attempt}` : null) : null
  let r
  try {
    r = await runFactory(crew, 'gates', 'ok', parts.join(' '), extra)
  } catch {
    // the gates call only saves spawns: a runner that dies on it leaves every step to run alone, which meets the failure itself
    return
  }
  const subs = r.parsed && isPlainObject(r.parsed.steps) ? r.parsed.steps : {}
  const met = r.parsed && isPlainObject(r.parsed.gates) ? r.parsed.gates : {}
  const codes = r.parsed && isPlainObject(r.parsed.codes) ? r.parsed.codes : {}
  const results = {}
  for (const s of steps) {
    const body = subs[s]
    if (!isPlainObject(body)) break
    const exit = Number.isInteger(codes[s]) ? codes[s] : r.exit
    // met as the step's own runFactory call would judge it (the same key); gates' own met only says where it stopped
    results[s] = { met: body[GATE_KEY[s]] === true, parsed: body, exit, out: `exit ${exit}\n${JSON.stringify(body)}`, ...(s === 'admit' && admitWait === 0 ? { noWait: true } : {}) }
    if (typeof met[s] === 'boolean' && !met[s]) break
  }
  crew.gates = { moves: crew.moves || 0, order: steps, results, admitLabel, admitTitle, attempt }
}

// the object of a `truss-status: {...}` line, or null when the runner gave none or it does not parse
function statusOf(s) {
  if (typeof s !== 'string') return null
  const t = s.trim()
  if (!t.startsWith(STATUS_PREFIX)) return null
  try {
    const v = JSON.parse(t.slice(STATUS_PREFIX.length))
    return isPlainObject(v) ? v : null
  } catch {
    return null
  }
}

// the environment failure factory.ts check names in its output (ADR-0009 "check, environment failures"), or null
const envOf = (r) => (r.parsed && typeof r.parsed.env === 'string' && r.parsed.env ? r.parsed.env : null)

// the catalog hits factory.ts check adds (ADR-0012 Decision 3), as "known problem <id>: <fix>" lines; '' when none or malformed
const knownOf = (r) => {
  const c = r.parsed && Array.isArray(r.parsed.catalog) ? r.parsed.catalog : []
  const lines = c.filter((h) => h && typeof h.id === 'string' && h.id && typeof h.fix === 'string').map((h) => `known problem ${h.id}: ${h.fix}`)
  return lines.length ? `\n${lines.join('\n')}` : ''
}

// ADR-0015 Decision 6: the check runs through factory heavy. runFactory appends --dir and --repo after the whole command,
// which would land after the --, so this line carries both flags on each side.
function heavyParts(crew) {
  const bin = sh(`${F.plugin}/bin/factory.ts`)
  // the inner command runs with cwd = the crew worktree, where a relative truss dir (.git/truss/<id>) does not resolve
  const dr = `--dir ${sh(trussDir())} --repo ${sh(F.repo)}`
  const slug = sh(crew.slug)
  const cwd = sh(crew.e.worktree)
  // ADR-0022 U5: --status-line goes on the heavy side of the --, so heavy prints the one status line
  return { bin, dr, slug, cwd, prefix: `node ${bin} heavy ${dr} --slug ${slug} --label ${sh(`${crew.slug}-check`)} --cwd ${cwd} --status-line --` }
}

function heavyLine(crew, expect, testsSince = null, more = '') {
  const { bin, dr, slug, cwd, prefix } = heavyParts(crew)
  return `${prefix} node ${bin} check --slug ${slug} --cwd ${cwd} --expect ${sh(expect)}${testsSince ? ` --tests-since ${sh(testsSince)}` : ''}${more ? ` ${more}` : ''} ${dr}`
}

// ADR-0017 Decisions 1-2 (ADR-0019 item 5): the member side of the one heavy slot, from the same values as heavyLine. Its
// label is <slug>-check, so the reap after each member also clears a member run's orphans.
const memberHeavyLines = (crew) => [
  'Run a build, a browser test or a whole test suite through the one heavy slot: the program and its arguments go after the `--` of the line below, with no shell, and the Bash timeout is 600000 because the slot wait counts against it.',
  `${heavyParts(crew).prefix} <program> <arguments>`,
  'A result with "ran": false means the slot was busy: report it, never retry it another way.',
  'A result with "pending": true means the run goes on in the background: run the same line again, unchanged, to wait for its result.',
  `That slot runs in the crew worktree ${crew.e.worktree}, on the crew branch, so it never sees your own worktree's changes: a green result from it proves nothing about them. Prove your own change with a plain node --test in your own worktree.`,
]

