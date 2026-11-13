// stage.js module: the scope check and the tests guard. Edit here, then run `npm run build:stage`.
async function scope(crew) {
  crew.step = 'scope'
  if (unmoved(crew, 'scopeAt')) return
  const r = takeGate(crew, 'owns') ?? (await runFactory(crew, `owns-check --slug ${sh(crew.slug)}`, 'ok'))
  if (r.met) return passedAt(crew, 'scopeAt')
  // ADR-0033: factory owns-check itself leaves out the doc files the crew's knowledge commit alone changed (bin/factory.ts
  // knowledgeDocs); stage.js exempts nothing, so whatever it still lists is outside
  const outside = r.parsed && Array.isArray(r.parsed.outside) ? r.parsed.outside : []
  const names = outside.length ? outside.join(', ') : r.out
  throw new Stop('QUESTION', `Files changed outside the crew owns: ${names}. Extend owns?`, 'scope')
}

// a builder or resolver commit that touched a tester's file is a sure QC FAIL (agents/qc-engineer.md step 8), and no fix
// builder can clear it, since QC reads the history: stop BLOCKED before a QC engineer is paid for it
async function testsGuard(crew) {
  crew.step = 'tests'
  // a resume that answers at tests (the PM rewrote the crew branch) must re-run the check, not replay the cached BLOCKED
  const attempt = (crew.e.answers || []).filter((a) => a && a.at === 'tests').length
  if (unmoved(crew, 'testsAt')) return
  const r = takeGate(crew, 'tests', (g) => g.attempt === attempt) ?? (await runFactory(crew, `tests-check --slug ${sh(crew.slug)}`, 'ok', null, testsCheckExtra(crew, attempt ? `Attempt: ${attempt}` : null)))
  if (r.met) return passedAt(crew, 'testsAt')
  const touched = r.parsed && Array.isArray(r.parsed.touched) ? r.parsed.touched : []
  const lines = touched.map((t) => `- ${t && t.commit} (Truss-Role: ${t && t.role}): ${t && Array.isArray(t.files) ? t.files.join(', ') : ''}`)
  throw new Stop('BLOCKED', `${lines.length ? `These commits touch acceptance-test files a tester wrote:\n${lines.join('\n')}` : `the tests check did not pass:\n${r.out}`}\nThe QC engineer fails any builder or resolver commit that touches them, so the crew stops before QC. Drop those commits from the crew branch (or have the tester make the change) and resume.`, 'tests')
}

