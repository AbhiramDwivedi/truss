// stage.js module: rulingStep (0.31.0 item 6): stopped fix branches and qc rulings on a resume. Edit here, then run `npm run build:stage`.
// 0.31.0 item 6: on a resume, before green. First every earlier fix member's stopped branch (entry.prior at `fix, <what>`) is
// integrated: no fix member of this run may reach the round that would merge it, and a branch that does not merge stops the crew
// naming it. Then, on an answers resume where no task member ran (every saved task done; a member that runs gets the ruling in its
// prompt, answersFor), a new ruling at qc goes to a fix builder; its branch is integrated before green, so the head that green
// checks and QC rules on holds it. A ruling at qc that orders no change (waive and proceed, `rulingOrdersChange`) spawns no builder.
// A ruling orders a change when its text asks for an edit or a cherry-pick. A "waive and proceed" ruling, or one that says no
// change is needed, orders none and spawns no member. A phrase that denies a change ("no change", "nothing to fix") is
// removed first; any other edit word keeps the builder, so an ambiguous ruling is still built.
function rulingOrdersChange(text) {
  const denied = /\b(?:no|without|nothing to|not? need(?:ed)? to|no need to)\s+(?:further\s+|more\s+|code\s+|doc\s+)?(?:changes?|edits?|fix(?:es)?|build|commits?|cherry-picks?|updates?|work)\b/gi
  return /\b(?:edit|edits|change|changes|add|adds|append|remove|delete|replace|update|rename|rewrite|revert|fix|build|implement|write|cherry-pick|cherry pick|amend|correct|commit|insert)\b/i.test(text.replace(denied, ' '))
}

async function rulingStep(crew, membersRan) {
  const e = crew.e
  const stopped = (Array.isArray(e.prior) ? e.prior : []).filter((p) => p && typeof p.at === 'string' && p.at.startsWith('fix, ') && typeof p.branch === 'string' && p.branch)
  const rulings = e.resume === 'answers' && !membersRan ? freshAnswers(e).filter((a) => a && a.at === 'qc' && typeof a.text === 'string' && rulingOrdersChange(a.text)) : []
  if (!stopped.length && !rulings.length) return
  crew.step = 'qc'
  crew.priorMerged = crew.priorMerged || []
  for (const p of stopped) {
    await integrate(crew, p.branch, 'qc')
    crew.priorMerged.push(p.branch)
    crew.proofs.push(`${p.at}: the commits of its stopped member branch ${p.branch} were merged on resume`)
  }
  if (!rulings.length) return
  // bug K: a ruling with role "tester" orders a test change a builder may not make; a tester fix member builds it first
  // (fixBuilder integrates its branch), then the other rulings go to the builder
  const forTester = rulings.filter((a) => a.role === 'tester')
  const forBuilder = rulings.filter((a) => a.role !== 'tester')
  if (forTester.length) {
    const testerDetail = ['The program manager ruled on this crew\'s stop at QC, and the ruling changes tests. Build every test change the ruling orders, commit them on your branch, and change nothing else:', ...forTester.map((a) => `- ${a.text}`)].join('\n')
    await fixBuilder(crew, 'the program manager ruling at qc', testerDetail, 'tester', '', 'qc')
  }
  if (!forBuilder.length) return
  const detail = ['The program manager ruled on this crew\'s stop at QC. Build every change the ruling orders (edits, cherry-picks, doc lines), commit them on your branch, and change nothing else:', ...forBuilder.map((a) => `- ${a.text}`)].join('\n')
  await fixBuilder(crew, 'the program manager ruling at qc', detail)
}

