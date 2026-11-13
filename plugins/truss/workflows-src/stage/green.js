// stage.js module: the green check, the full suite and green fix rounds. Edit here, then run `npm run build:stage`.
// ---------------------------------------------------------------- green, stress test, scope, QC

// ADR-0046 item 3: the stress-fix round's message when its diff adds or changes no test file
// The defects themselves go along, as stressTest gives them to fixFindings, so the fix member knows which cases to add.
const noTestText = (since, head, findings) => `${since === head ? `The stress-fix round left the head at ${head}: it committed no fix and no test file` : `The stress-fix round (${since}..${head}) changed no test file`}: every defect fix carries a regression test that fails before the fix and passes after it (R-71). Add a regression case for each defect the stress test reported, and name each in your report.${findings ? `\nThe stress test reported these findings:\n${findings}` : ''}`

// 0.31.0 item 1: the tests a passing green check ran (factory check's `tests`: targeted or full, and why) and the check record
// that holds them, kept as crew.greenRecord for QC (qcPrompt), which reads it instead of re-running a suite green on that head.
function noteTests(crew, parsed) {
  const t = parsed && isPlainObject(parsed.tests) ? parsed.tests : null
  if (!t) return
  const why = Array.isArray(t.why) ? t.why.map(String) : []
  crew.greenRecord = { head: crew.head, mode: t.mode === 'full' ? 'full' : 'targeted', files: Array.isArray(t.files) ? t.files.map(String) : [], why, record: typeof parsed.record === 'string' ? parsed.record : null }
  log(`green check: crew ${crew.slug}, ${crew.greenRecord.mode} tests (${crew.greenRecord.files.length} files): ${why.join('; ').slice(0, 600) || 'no reason given'}`)
}

// 0.31.0 item 1: the full suite runs once before merge, after a QC PASS, unless the green check already ran it on this head (a diff
// whose reach was unclear). null when it passed or was not needed; the failing check result otherwise.
async function fullSuite(crew) {
  const gr = crew.greenRecord
  if (crew.fullAt === crew.head || (gr && gr.head === crew.head && gr.mode === 'full')) return null
  crew.step = 'full-suite'
  const g = await check(crew, 'green', null, '--full')
  if (g.met) {
    crew.fullAt = crew.head
    log(`full suite before merge: crew ${crew.slug}, passed on head ${crew.head}`)
    return null
  }
  const env = envOf(g)
  if (env) throw new Stop('BLOCKED', `the full suite fails on the environment, not the code, so no fix builder can clear it: ${env}\nFix the host (install what it names) and resume the crew.${knownOf(g)}\n${clip(g.out)}`, 'full-suite')
  return g
}

// opts.testsSince (ADR-0046 item 3): the head before a stress-fix round. The green check then lists the test files changed since
// it, and a pass with none is a failure: a fix member adds the cases (the tester when the crew has tester files), once; a second
// pass with none stops the crew, so a fix with no regression test never reaches QC.
async function green(crew, opts = {}) {
  const since = typeof opts.testsSince === 'string' && opts.testsSince ? opts.testsSince : null
  // ADR-0046 item 1: nothing merged since the last green pass, so the head is the one it passed on
  if (crew.head && unmoved(crew, 'greenAt') && !since) {
    crew.step = 'green'
    log(`green check skipped: crew ${crew.slug}, head ${crew.head} unchanged since it passed`)
    return
  }
  let noTest = 0
  for (let attempt = 1; ; attempt++) {
    crew.step = 'green'
    const g = await check(crew, 'green', since)
    crew.greenOut = g.out
    if (g.met) {
      if (typeof g.parsed.head !== 'string' || !g.parsed.head) throw new Stop('BLOCKED', `the green check gave no head:\n${g.out}`, 'green')
      crew.head = g.parsed.head
      crew.sourceChanges = sourceChangesOf(g.parsed)
      noteTests(crew, g.parsed)
      passedAt(crew, 'greenAt')
      // a project whose test files truss can't recognise: unknown, so a warning, never a stop (ADR-0046 item 3, testGlobs)
      if (since && typeof g.parsed.testsUnknown === 'string' && g.parsed.testsUnknown) log(`warning: green check: crew ${crew.slug}: ${g.parsed.testsUnknown}`)
      // an old factory prints no testsSince (and an unknown one none either): no list, no check. A head that did not move after
      // a stress test that reported defects (green only gets testsSince then) fixed nothing: the same failure as no test.
      if (since && Array.isArray(g.parsed.testsSince) && g.parsed.testsSince.length === 0) {
        const text = noTestText(since, g.parsed.head, typeof opts.findings === 'string' ? opts.findings.trim() : '')
        if (noTest++ >= 1) throw new Stop('BLOCKED', text, 'green')
        log(`green check: crew ${crew.slug}, stress-fix round added no test`)
        await fixBuilder(crew, 'stress-fix regression tests', text, testerFiles(crew).length ? 'tester' : 'builder')
        continue
      }
      return
    }
    const env = envOf(g)
    // ADR-0024 seam 2: an env line that does not explain every failure is named to the fix builder, never stopped on
    const seen = !env && g.parsed && typeof g.parsed.envSeen === 'string' && g.parsed.envSeen ? `\nThe output shows an environment line, but it does not explain every failure: ${g.parsed.envSeen}\nThe cases it hits belong to the host, not the fix: leave them alone and fix the other failures.` : ''
    if (env) throw new Stop('BLOCKED', `the green check fails on the environment, not the code, so no fix builder can clear it: ${env}\nFix the host (install what it names) and resume the crew.${knownOf(g)}\n${clip(g.out)}`, 'green')
    if (attempt === 4) throw new Stop('BLOCKED', `the green check still fails after the escalation ladder:\n${clip(g.out)}`, 'green')
    if (attempt < 3) {
      await greenFix(crew, 'green check', `The green check failed.${knownOf(g)}${seen}\nIts output tail:\n${clip(g.out)}`)
    } else {
      const rca = await ask(crew, 'rca', [`Find the root cause of the failing green check for crew ${crew.slug}. Write no code and change no file; diagnose only.`, `Crew worktree: ${crew.e.worktree}`, `Acceptance test: ${acceptanceOf(crew.e)}`, 'Failing output:', clip(g.out)].join('\n'))
      await greenFix(crew, 'green check, after the root-cause analysis', `The green check keeps failing.${knownOf(g)}${seen}\nRoot-cause analysis:\n${rca || 'none returned'}\n\nFailing output:\n${clip(g.out)}`)
    }
  }
}

// ADR-0027 F-70: the builder goes first on every green failure. When it ends BLOCKED or QUESTION and its stop text names a
// tester file, that text goes to a tester fix member instead of stopping the crew; when the text also names a code file, a
// builder fix for the code half follows, in fixFindings' order. Any other stop still stops the crew. testsBackstop runs
// after each fix.
async function greenFix(crew, what, detail) {
  try {
    await fixBuilder(crew, what, detail)
  } catch (err) {
    const tf = testerFiles(crew)
    const reroute = err instanceof Stop && err.member && (err.tag === 'BLOCKED' || err.tag === 'QUESTION') && tf.some((file) => namesFile(String(err.text || ''), file))
    if (!reroute) throw err
    const said = `The ${what} fix builder ended ${err.tag}, naming a tester file. Its report:\n${err.text}`
    await fixBuilder(crew, `${what}, tester file named by the fix builder`, said, 'tester')
    await testsBackstop(crew, what)
    if (!namesCode(String(err.text), tf)) return
    // the stopped fix builder may have committed code on its branch already; the code-half builder carries it on
    await fixBuilder(crew, `${what}, the code half of the fix builder's report`, said, 'builder', typeof err.branch === 'string' ? err.branch : '')
  }
  await testsBackstop(crew, what)
}

