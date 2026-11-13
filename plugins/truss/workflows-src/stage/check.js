// stage.js module: check(): the acceptance-test run and heavy-slot polling. Edit here, then run `npm run build:stage`.
// the tests-check runner's extra lines: Attempt (testsGuard only), Backstop, then Head when the entry has one (ADR-0024 seam 1).
// ADR-0026 item 51 4: the Head line names crew.head once the run has moved it, entry.head before that.
const testsCheckExtra = (crew, ...lines) => {
  const head = typeof crew.e.head === 'string' && crew.e.head ? [`Head: ${typeof crew.head === 'string' && crew.head ? crew.head : crew.e.head}`] : []
  const all = [...lines.filter(Boolean), ...head]
  return all.length ? all.join('\n') : null
}

// Starvation bound (gates item 8): the heavy slot is not FIFO. check() runs heavy up to HEAVY_WAIT_ROUNDS = 3 times when the job
// reports the slot busy (ran: false). In 0.26.0 each round waited HEAVY_WAIT_MS (540 s, then inside the 600 s Bash call), so a
// crew waited about 27 minutes in all. Since 0.31.0 the wait happens in factory's background job, not inside this Bash call, and
// a round lasts slotWaitMs: twice the longest recent suite, 540 s to 2 h (bin/factory/resources.ts). Non-FIFO: a crew can still
// lose every round and block. No sleep between rounds, since each run already waits inside factory.
const HEAVY_WAIT_ROUNDS = 3
// 0.31.0 item 2: a heavy run longer than the 540 s attach budget (HEAVY_ATTACH_MS) goes on in the background in factory
// (heavyJobMain) and comes back {heavy: {pending: true, ageMs, budgetMs}}; the same line, run again, waits up to 540 s more. The
// give-up comes from factory's own budget (heavyMain's budgetMs: the slot wait plus slotWaitMs for the run), so a crew still
// queued for the slot is never stopped while its job holds or waits for it. A pending reply without a budget blocks at once.
// A pending poll is not a slot round.
// the age and budget of a pending job, from the stdout heavy object or, when the runner gave only the status line, from that
const budgetOf = (r, h) => {
  const pick = (k) => (h && Number.isFinite(h[k]) ? h[k] : r.parsed && Number.isFinite(r.parsed[k]) ? r.parsed[k] : NaN)
  return { ageMs: pick('ageMs'), budgetMs: pick('budgetMs') }
}
const pendingOutOfBudget = (b) => !(Number.isFinite(b.ageMs) && Number.isFinite(b.budgetMs) && b.ageMs < b.budgetMs)
const secs = (ms) => (Number.isFinite(ms) ? Math.round(ms / 1000) : '?')
const pendingOf = (r) => !!(r.parsed && (r.parsed.pending === true || (isPlainObject(r.parsed.heavy) && r.parsed.heavy.pending === true)))

async function check(crew, expect, testsSince = null, more = '') {
  let r, h
  for (let round = 1, polls = 0; round <= HEAVY_WAIT_ROUNDS; polls++) {
    // ADR-0046 item 1: a green check gates already ran (never one with --tests-since, which gates does not send)
    const pre = round === 1 && polls === 0 && expect === 'green' && !testsSince && !more ? takeGate(crew, 'green') : null
    r = pre ?? (await runFactory(crew, 'heavy', 'ok', heavyLine(crew, expect, testsSince, more)))
    h = r.parsed && typeof r.parsed === 'object' ? r.parsed.heavy : null
    if (pendingOf(r)) {
      const b = budgetOf(r, h)
      if (pendingOutOfBudget(b)) throw new Stop('BLOCKED', `heavy run still going after ${secs(b.ageMs)} s (budget ${secs(b.budgetMs)} s): ${h && typeof h.why === 'string' ? h.why : r.out}`, crew.step)
      continue
    }
    if (!(h && typeof h === 'object' && h.ran === false)) return r
    round++
  }
  throw new Stop('BLOCKED', `heavy slot busy: ${typeof h.why === 'string' ? h.why : r.out}`, crew.step)
}

