// stage.js module: findings, fix rounds and the tests backstop. Edit here, then run `npm run build:stage`.
// the findings of a report: one per "- " line (with its continuation lines); a text with no bullet is one finding
function findingsOf(text) {
  const out = []
  for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
    if (line.startsWith('- ')) out.push(line)
    else if (line.trim() !== '' && out.length) out[out.length - 1] += `\n${line}`
  }
  return out.length ? out : String(text || '').trim() ? [String(text).trim()] : []
}

// ADR-0046 item 8: the defects of a findings list, which get a regression case from the tester before the builder fixes them.
// Every stress-test finding is a real defect (test gaps go under ## Notes); a QC finding is one when it is rated bug or risk.
const DEFECT_RE = /^-\s*(?:`[^`]*`|\S+)?\s*:?\s*(?:\*\*)?\b(?:bug|risk)\b/i
const qcDefect = (f) => DEFECT_RE.test(f)

// the tester's part of a fix round: the findings that name its files, and a regression case first for each defect
function regressionDetail(crew, header, mine, defects) {
  return [
    ...(mine.length ? [header, ...mine] : []),
    ...(defects.length
      ? [
          ...(mine.length ? [''] : []),
          `Before the builder fixes them, write a regression case for each defect below: a test that fails on the current head ${crew.head || 'HEAD'} because of the defect and passes once it is fixed. Commit it failing; never change code to make it pass. Name each case and its file in your report.`,
          ...defects,
        ]
      : []),
  ].join('\n')
}

// QC and stress-test findings: those naming a tester task file, and (ADR-0046 item 8) a regression case for each defect, go to a
// tester fix member first, the rest to a builder fix member. isDefect picks the defects; a crew with no tester files has no tester,
// so its builder writes the regression cases (ADR-0046 item 0 lets it add tests).
async function fixFindings(crew, what, header, findingsText, wholeDetail, isDefect = qcDefect) {
  const tf = testerFiles(crew)
  const all = findingsOf(findingsText)
  const mine = tf.length ? all.filter((f) => tf.some((file) => namesFile(f, file))) : []
  const defects = tf.length ? all.filter((f) => !mine.includes(f) && isDefect(f)) : []
  if (!mine.length && !defects.length) {
    await fixBuilder(crew, what, wholeDetail)
    return testsBackstop(crew, what)
  }
  await fixBuilder(crew, defects.length ? `${what}, regression cases first` : what, regressionDetail(crew, header, mine, defects), 'tester')
  // a finding that names a tester file and a code file also goes to the builder, for its code half
  const rest = all.filter((f) => !mine.includes(f) || namesCode(f, tf))
  if (!rest.length) return
  const cases = defects.length ? `\n\nA tester has committed a regression case for each defect above, failing on purpose; make them pass by fixing the code, and never edit them.` : ''
  await fixBuilder(crew, what, `${header}\n${rest.join('\n')}${cases}`)
  await testsBackstop(crew, what)
}

// ADR-0024 item 28: the backstop's own prompt, for the resolver role in the crew worktree (isolation none, as resolveConflicts):
// no merge first step and no own-worktree line, since the rewrite is on the crew branch itself
function backstopPrompt(crew, what, lines) {
  const e = crew.e
  const body = [
    `Task: tests backstop, ${what}`,
    `Work in the crew worktree ${e.worktree} (branch ${e.branch}). Do not make a new worktree.`,
    `Run git as git -C ${e.worktree} <command> so it acts on the crew worktree whatever your working directory is.`,
    '',
    'These builder commits on the crew branch touch tester-owned files, so the tests check fails:',
    ...lines,
    '',
    `Rewrite them on the crew branch ${e.branch} itself. Split each listed commit so its changes to the files listed for it sit in their own commit with the trailers Truss-Crew: ${crew.slug} and Truss-Role: ${TRAILER_ROLE.tester}, and the rest stays in a commit with its original trailers.`,
    'Keep the tree identical: git diff between the old and the new tip must be empty, and no file content changes.',
    `Report the branch ${e.branch} and its new tip as the commit.`,
  ]
  const trailers = [
    'Every commit you make keeps the trailers named above: a split-out tester-file commit ends with',
    `Truss-Crew: ${crew.slug}`,
    `Truss-Role: ${TRAILER_ROLE.tester}`,
    'and the rest keep their original Truss-Crew and Truss-Role lines; never give them Truss-Role: resolver.',
  ]
  // ADR-0026 item 51 2: inCrewWorktree drops the own-worktree proof line and says to commit on the crew branch in the crew worktree
  return memberPrompt(crew, 'resolver', { start: [], body, trailers, inCrewWorktree: true })
}

// bug 28: after a builder fix, the tests check testsGuard runs. Touched tester files get a resolver that moves each such
// change into a tester commit on the crew branch, then one re-check; a check that still fails is left to testsGuard to stop on.
async function testsBackstop(crew, what) {
  // ADR-0046 item 1: on a head the tests check already passed, no commit can touch a tester file; a pass here also
  // serves testsGuard's next run on the same head
  if (unmoved(crew, 'testsAt')) return
  const n = (crew.backstops = (crew.backstops || 0) + 1)
  // an extra line per run, so no run shares testsGuard's cache key or another run's (the runtime caches by prompt)
  const check = (k) => runFactory(crew, `tests-check --slug ${sh(crew.slug)}`, 'ok', null, testsCheckExtra(crew, `Backstop: ${n}.${k}`))
  const r = await check(1)
  if (r.met) passedAt(crew, 'testsAt')
  const touched = !r.met && r.parsed && Array.isArray(r.parsed.touched) ? r.parsed.touched : []
  if (!touched.length) return
  const lines = touched.map((t) => `- ${t && t.commit} (Truss-Role: ${t && t.role}): ${t && Array.isArray(t.files) ? t.files.join(', ') : ''}`)
  const at = crew.step
  const label = `${what}, builder commits on tester files`
  const persona = personaFor(crew, 'resolver', lines.join('\n'), null)
  const report = await ask(crew, 'resolver', backstopPrompt(crew, label, lines), { schema: MEMBER_SCHEMA, at, title: `Resolve backstop for ${crew.slug}`, ...(persona ? { persona } : {}) })
  // ADR-0026 item 51 3: a resolver's QUESTION, PROPOSAL or CHECKPOINT stops the crew with that tag, as runMember does
  if (report && ['QUESTION', 'PROPOSAL', 'CHECKPOINT'].includes(report.marker)) throw new Stop(report.marker, report.text, at)
  if (!report || report.marker !== 'DONE') throw new Stop('BLOCKED', `the resolver did not finish the tests backstop (${label}): ${report ? report.text : 'no report'}`, at)
  crew.proofs.push(`tests backstop (${what}): ${report.proof}`)
  await check(2)
}

