// stage.js module: member, task, fix and resolver prompts. Edit here, then run `npm run build:stage`.
// ---------------------------------------------------------------- prompts

// ADR-0022 U4: the crew's UX direction as one heading line and every line quoted with "> "; [] on a crew without ux or
// without a direction, so those briefs are unchanged. No brief gets a path in its place.
function directionLines(crew) {
  const d = uxOn(crew) ? crew.direction : null
  if (!d) return []
  const text = d.text.replace(/\r/g, '').replace(/\s+$/, '')
  return [`The crew's UX direction (report ${d.label}), quoted:`, ...text.split('\n').map((l) => `> ${l}`)]
}

// ADR-0046 item 0 (client ruling 2026-11-12): the crew owns the docs of its work. A builder updates them in the same change as
// the code, in every round, fix rounds included; the knowledge step after it is a backstop that fills gaps. Tests: the builder
// may add and edit regression tests for its own fixes; only what a tester wrote (the acceptance test, written before the build,
// and a regression case a tester wrote first) stays read-only, because that is what proves the work and a builder must not bend it.
function docsLines(crew) {
  return [
    'You own the docs of your change. In the same commit as the code, every round (a fix round too), bring back in line every doc your change makes stale:',
    `- the feature map (${FEATURE_MAP}), through your fragment of it: an entry for each user-facing capability you add or move, and every entry whose paths or behaviour you changed;`,
    `- the knowledge docs (${KNOWLEDGE_DIR}/**) and rule files (${RULES_DIR}/*.md) whose \`sources\` you changed: fix the text (in your fragment of a doc that already exists), then, in the doc itself, set \`verified\` to the commit your change builds on (git rev-parse HEAD before you commit);`,
    `- the architecture doc (${crew.e.architecture || 'docs/architecture.md'}, through your fragment of it) and the ADRs in ${ADR_DIR}: the descriptive text and the citations that point at code you moved. Cite code by symbol (a function or constant name), not by line number; replace any line-number citation you touch with the symbol. Never edit an ADR's Decision or Status: raise a PROPOSAL instead;`,
    '- the skill and agent prose (.claude/skills/*/*.md, .claude/agents/*.md, and any SKILL.md or agents/*.md in your files) that describes the behaviour you changed, so it never says the opposite of the code.',
    fragmentLine(crew.slug),
    'Those .md doc paths are yours to edit even when they are outside your files list; never edit the YAML frontmatter of a persona or skill file outside your files list.',
    'Tests: add or edit regression tests for your own fixes in the files you may change. Never edit a test a tester wrote (the acceptance test, written before the build, and any regression case a tester wrote first): that is the proof of your work, so it stays read-only to you; when one is wrong, say so in your report.',
  ]
}

function memberPrompt(crew, role, parts) {
  const e = crew.e
  const lines = [`You are the ${role} for crew ${crew.slug}. ${BRAVE}`, '']
  lines.push(...parts.start)
  lines.push(`Approved scope: ${scopeOf(e)}`, '', 'Build only the approved scope quoted above. Drift (tidying, reformatting, renames, unrelated refactors, "while I am here" edits) never goes into the diff and is never reported as a proposal. A meaningful change beyond it (a better approach, a stale design, a broken assumption elsewhere, a real defect) is never left out: surface it in your report.', '')
  const dl = directionLines(crew)
  if (dl.length) lines.push(...dl, '')
  lines.push(`Acceptance test: ${acceptanceOf(e)}`, '')
  lines.push(...parts.body)
  if (role === 'builder') lines.push('', ...docsLines(crew))
  lines.push(
    '',
    PROOF,
    '',
    ...(parts.noLearned ? [] : [LEARNED, '']),
    FETCH,
    '',
    ...(role === 'writer' ? [] : [DIFF, '']),
    ...(role === 'builder' || parts.debug ? [DEBUG, ''] : []),
    SHELL,
    '',
    'Members run plain single `node --test <files>` commands; the stage green step runs the acceptance test.',
    '',
    ...(parts.inCrewWorktree ? memberHeavyLines(crew).slice(0, -1) : memberHeavyLines(crew)),
    '',
    FOREGROUND,
    '',
    REFUSAL,
    PKILL,
    '',
    ...(parts.trailers || ['Every commit you make ends with these trailers:', `Truss-Crew: ${crew.slug}`, `Truss-Role: ${TRAILER_ROLE[role]}`]),
    "They go in the message's last block, with no blank line between them or before any Co-Authored-By line, or git does not read them. Put Truss-Crew and Truss-Role in the same final paragraph as any Co-Authored-By or Claude-Session lines your harness tells you to add, with no blank line between any of them. Your harness's Co-Authored-By lines do not get their own paragraph after a blank line. Write the end of the message like this:",
    '',
    'Subject line',
    '',
    'Body.',
    '',
    `Truss-Crew: ${crew.slug}`,
    `Truss-Role: ${TRAILER_ROLE[role]}`,
    'Co-Authored-By: Name <name@example.com>',
    'Claude-Session: https://example.com/session',
    '',
    'After each commit, run `git log -1 --format=%B` and check that its last block holds the Truss-Crew and Truss-Role lines; if it does not, fix the message with git commit --amend. A merge refuses a commit whose Truss-Crew or Truss-Role git cannot read.',
    '',
    'You have no Agent tool; do the work yourself.',
    `${parts.inCrewWorktree ? `Work and commit on the crew branch ${crew.e.branch} in the crew worktree ${crew.e.worktree}` : 'Commit on your branch'} and report the branch and commit. Put your proof in the proof field. marker is DONE when finished, CHECKPOINT when you must stop early (put a handoff note in text), QUESTION, BLOCKED or PROPOSAL when you cannot go on.`,
  )
  return lines.join('\n')
}

function taskPrompt(crew, task, note) {
  const e = crew.e
  const answers = answersFor(crew, task.name)
  const body = [`Task: ${task.name}`, `Files you may change: ${task.files.join(', ')}`, `Files to read: ${(task.reads || []).join(', ') || 'none'}`]
  // ADR-0035: the rule files whose `paths` match the task's files; only when one matches. Kept until an eval shows rules load natively in member worktrees.
  const ruleFiles = rulesFor(F.rules, task.files)
  if (ruleFiles.length) body.push(`Context for your files: ${ruleFiles.join(', ')}. Read each one unless it is already in your context.`)
  // ADR-0019 item 16: a builder's read-only list, the tester task files (or the entry's ownTests when no tester task has any)
  if (task.role === 'builder') {
    const tf = testerFiles(crew)
    const ro = tf.length ? tf : ownTestsOf(crew)
    if (ro.length) body.push(`Test files, read-only to you (a tester wrote them before your build as the proof of it; never edit them, and add any regression test of your own in your files): ${ro.join(', ')}`)
  }
  body.push('', 'Brief:', task.brief)
  if (answers.length) body.push('', 'Answers to your earlier questions:', ...answers)
  if ((crew.testsUpdated || new Set()).has(task.name)) body.push('', 'A test-writer has already updated the tests the ruling above orders; they are merged on the crew branch. The tests are updated, so build the code to pass them and never edit them.')
  if (note) body.push('', ...resumeLines(note))
  const start = firstStep(e, (note && note.branch) || priorOf(crew, task.name))
  return memberPrompt(crew, task.role, { start, body })
}

// ADR-0019 item 9: the owned globs that are test paths, from the factory's one test-path rule (the start entry's ownTests).
// stage.js keeps no rule of its own; an entry without ownTests has none.
const ownTestsOf = (crew) => (Array.isArray(crew.e.ownTests) ? crew.e.ownTests.filter((g) => typeof g === 'string' && g !== '') : [])

// the files of the crew's tester tasks (from split or e.tasks). A merge-ready resume carries no tasks, so there the tester
// files are the entry's ownTests (ADR-0014 Decision 4 has no merge-ready exception). Bug 28: they always also cover the
// entry's guarded files and its ownTests globs, so a rework finding on any test file goes to a tester.
const testerFiles = (crew) => {
  const fromTasks = (crew.tasks || []).filter((t) => t.role === 'tester').flatMap((t) => t.files || [])
  const guarded = Array.isArray(crew.e.guarded) ? crew.e.guarded.filter((g) => typeof g === 'string' && g !== '') : []
  return [...new Set([...fromTasks, ...guarded, ...ownTestsOf(crew)])]
}

// the file paths a finding names
const pathsIn = (text) => String(text).match(/[\w@./*-]*[\w*-]\.(?:ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|sh|md|css|html|yml|yaml)\b/g) || []
// bug 28: a literal file's basename and its basename without the last extension (a stem under 3 characters is too loose)
const baseNames = (file) => {
  if (file.includes('*')) return []
  const b = file.slice(file.lastIndexOf('/') + 1)
  const stem = b.includes('.') ? b.slice(0, b.lastIndexOf('.')) : ''
  return [b, ...(stem.length >= 3 ? [stem] : [])]
}
// word as a whole name in text: not inside a longer name or path
const namesWord = (text, word) => new RegExp(`(^|[^\\w./-])${word.replace(/[.+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w/-])`).test(text)
const namesFile = (finding, file) => finding.includes(file) || (file.includes('*') && pathsIn(finding).some((p) => globToRegExp(file).test(p))) || baseNames(file).some((b) => namesWord(finding, b))
// the paths a finding names that are not a tester file (nor a tester file's basename): its code half
const namesCode = (finding, tf) => pathsIn(finding).some((p) => !tf.some((file) => p === file || (file.includes('*') && globToRegExp(file).test(p)) || file.endsWith(`/${p}`)))

const NIT_LINE = 'Fix every bug and risk finding. Fix a nit only when its fix changes no behaviour (wording, a name, a comment, a doc line); when fixing a nit would change what the code does, leave it unfixed and list it under a "Nits left" heading in your report text.'

// prev: the branch of an earlier member of this fix that stopped (a restart in this run), else entry.prior's `fix, <what>`
function fixPrompt(crew, what, detail, role = 'builder', prev = '') {
  const e = crew.e
  const tf = testerFiles(crew)
  const body = [`Task: fix, ${what}`]
  if (role === 'tester') {
    body.push(`Files you may change: ${(tf.length ? tf : ownTestsOf(crew)).join(', ')}`)
  } else {
    body.push(`Files you may change: ${e.owns.filter((o) => !tf.includes(o)).join(', ')}`)
    if (tf.length) body.push(`Files a tester owns, which you must not change: ${tf.join(', ')}`, 'Never edit a file in the tester list above; when a fix needs one changed, name it in your report instead.')
  }
  body.push('', 'Fix this, and only this:', detail)
  // ADR-0046 item 13: a nit's fix that changes behaviour is a new risk QC must judge again; leave it and list it instead
  if (role !== 'tester') body.push('', NIT_LINE)
  const answers = answersFor(crew, null)
  if (answers.length) body.push('', 'Answers to your earlier questions:', ...answers)
  const start = firstStep(e, prev || priorOf(crew, `fix, ${what}`))
  return memberPrompt(crew, role, { start, body, debug: true })
}

function resolverPrompt(crew, what, conflicts) {
  const e = crew.e
  const body = [
    `Task: resolve the conflicts from ${what}`,
    `Work in the crew worktree ${e.worktree} (branch ${e.branch}). Do not make a new worktree.`,
    `Conflicting files: ${conflicts.length ? conflicts.join(', ') : 'none listed; run git status to find them'}`,
    `Run git as git -C ${e.worktree} <command> so it acts on the crew worktree whatever your working directory is.`,
    'Resolve every conflict, keep both sides intent, run plain single `node --test <files>` commands (never the acceptance test, which the stage green step runs), and commit the merge. Never edit an acceptance-test file to make it pass.',
  ]
  return memberPrompt(crew, 'resolver', { start: [], body })
}

