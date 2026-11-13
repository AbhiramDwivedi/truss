// stage.js module: check(): the acceptance-test run and heavy-slot polling. Edit here, then run `npm run build:stage`.
// the tests-check runner's extra lines: Attempt (testsGuard only), Backstop, then Head when the entry has one (ADR-0024 seam 1).
// ADR-0026 item 51 4: the Head line names crew.head once the run has moved it, entry.head before that.
const testsCheckExtra = (crew, ...lines) => {
  const head = typeof crew.e.head === 'string' && crew.e.head ? [`Head: ${typeof crew.head === 'string' && crew.head ? crew.head : crew.e.head}`] : []
  const all = [...lines.filter(Boolean), ...head]
  return all.length ? all.join('\n') : null
}

// Starvation bound (gates item 8): the heavy slot is not FIFO, and one heavy run waits at most HEAVY_WAIT_MS (540 s, under
// the 600 s Bash timeout) in factory. check() runs heavy up to HEAVY_WAIT_ROUNDS = 3 times in all, so a crew waits at most
// 3 rounds of 540 s, about 27 minutes, for the slot. Non-FIFO: a crew can still lose every round and block. No sleep
// between rounds, since each run already waits inside factory.
const HEAVY_WAIT_ROUNDS = 3
// 0.31.0 item 2: a heavy run longer than the 540 s attach budget goes on in the background in factory (heavyJobMain) and comes
// back {heavy: {pending: true}}; the same line, run again, waits up to 540 s more for it. HEAVY_POLLS = 8 bounds that at about
// 72 minutes, so a hung run blocks the crew instead of holding it for ever. A pending poll is not a slot round.
const HEAVY_POLLS = 8
const pendingOf = (r) => !!(r.parsed && (r.parsed.pending === true || (isPlainObject(r.parsed.heavy) && r.parsed.heavy.pending === true)))

async function check(crew, expect, testsSince = null, more = '') {
  let r, h
  for (let round = 1, polls = 0; round <= HEAVY_WAIT_ROUNDS; ) {
    // ADR-0046 item 1: a green check gates already ran (never one with --tests-since, which gates does not send)
    const pre = round === 1 && polls === 0 && expect === 'green' && !testsSince && !more ? takeGate(crew, 'green') : null
    r = pre ?? (await runFactory(crew, 'heavy', 'ok', heavyLine(crew, expect, testsSince, more)))
    h = r.parsed && typeof r.parsed === 'object' ? r.parsed.heavy : null
    if (pendingOf(r)) {
      if (++polls > HEAVY_POLLS) throw new Stop('BLOCKED', `heavy run still going after ${HEAVY_POLLS} polls: ${h && typeof h.why === 'string' ? h.why : r.out}`, crew.step)
      continue
    }
    if (!(h && typeof h === 'object' && h.ran === false)) return r
    round++
  }
  throw new Stop('BLOCKED', `heavy slot busy: ${typeof h.why === 'string' ? h.why : r.out}`, crew.step)
}

