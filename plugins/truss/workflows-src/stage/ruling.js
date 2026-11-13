// stage.js module: rulingStep (0.31.0 item 6): stopped fix branches and qc rulings on a resume. Edit here, then run `npm run build:stage`.
// 0.31.0 item 6: on a resume, before green. First every earlier fix member's stopped branch (entry.prior at `fix, <what>`) is
// integrated: no fix member of this run may reach the round that would merge it, and a branch that does not merge stops the crew
// naming it. Then, on an answers resume where no task member ran (every saved task done; a member that runs gets the ruling in its
// prompt, answersFor), a new ruling at qc goes to a fix builder; its branch is integrated before green, so the head that green
// checks and QC rules on holds it. A ruling at qc that orders no change belongs on a merge-ready resume.
async function rulingStep(crew, membersRan) {
  const e = crew.e
  const stopped = (Array.isArray(e.prior) ? e.prior : []).filter((p) => p && typeof p.at === 'string' && p.at.startsWith('fix, ') && typeof p.branch === 'string' && p.branch)
  const rulings = e.resume === 'answers' && !membersRan ? freshAnswers(e).filter((a) => a && a.at === 'qc' && typeof a.text === 'string') : []
  if (!stopped.length && !rulings.length) return
  crew.step = 'qc'
  crew.priorMerged = crew.priorMerged || []
  for (const p of stopped) {
    await integrate(crew, p.branch, 'qc')
    crew.priorMerged.push(p.branch)
    crew.proofs.push(`${p.at}: the commits of its stopped member branch ${p.branch} were merged on resume`)
  }
  if (!rulings.length) return
  const detail = ['The program manager ruled on this crew\'s stop at QC. Build every change the ruling orders (edits, cherry-picks, doc lines), commit them on your branch, and change nothing else:', ...rulings.map((a) => `- ${a.text}`)].join('\n')
  await fixBuilder(crew, 'the program manager ruling at qc', detail)
}

