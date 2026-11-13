// stage.js module: the knowledge step (ADR-0033) and the QC Knowledge block. Edit here, then run `npm run build:stage`.
// ---------------------------------------------------------------- the knowledge step (ADR-0033)

// `/` separators; the repo prefix is compared folded on win32 and darwin (PLATFORM), and the returned path keeps its case
const repoRel = (f) => {
  const fold = PLATFORM === 'win32' || PLATFORM === 'darwin' ? (s) => s.toLowerCase() : (s) => s
  const root = `${flatPath(F.repo).replace(/\/+$/, '')}/`
  const p = flatPath(f)
  return fold(p).startsWith(fold(root)) ? p.slice(root.length) : p
}
const crewTasks = (crew) => (crew.tasks && crew.tasks.length ? crew.tasks : crew.e.tasks) || []
// a crew has code tasks unless its tasks are all writer tasks (none known: a merge-ready resume, so code)
const hasCodeTasks = (crew) => {
  const tasks = crewTasks(crew)
  return tasks.length === 0 || tasks.some((t) => t.role !== 'writer')
}
// the repo-relative files of the personas this crew's tasks ran as
function crewPersonaFiles(crew) {
  const files = []
  for (const t of crewTasks(crew)) {
    const n = taskPersona(t)
    const f = n && Object.hasOwn(PERSONAS, n) && PERSONAS[n] ? PERSONAS[n].file : null
    if (typeof f === 'string' && f && !files.includes(repoRel(f))) files.push(repoRel(f))
  }
  return files
}
const ruleFilesOf = (rules) => (Array.isArray(rules) ? rules.filter((r) => r && typeof r.path === 'string' && r.path).map((r) => r.path) : [])
// ADR-0035: where the crew product calls live. It was the product-owner persona file, which is always loaded; calls now go to a lazy
// knowledge file, and the persona keeps only its judging rules.
const productOwnerFile = () => repoRel(PRODUCT_DECISIONS)
// the well-formed entries of the green check's sourceChanges: source files the crew diff added, renamed or deleted
function sourceChangesOf(parsed) {
  const list = parsed && Array.isArray(parsed.sourceChanges) ? parsed.sourceChanges : []
  return list
    .filter((c) => isPlainObject(c) && (c.status === 'A' || c.status === 'D' || c.status === 'R') && typeof c.path === 'string' && c.path && (c.status !== 'R' || (typeof c.from === 'string' && c.from)))
    .map((c) => ({ status: c.status, path: c.path, ...(c.status === 'R' ? { from: c.from } : {}) }))
}
const isMarkdown = (p) => /\.md$/i.test(String(p))
// ADR-0035: a file every session loads whole: CLAUDE.md, CLAUDE.local.md or AGENTS.md in any directory, the agents index, a persona file
// the path form alwaysLoaded compares: `/` separators, the repo root and a leading `./` dropped, lower case (the root is
// normalised the same way, so `C:\repo\x` and `C:/repo/x` agree)
function loadedForm(p) {
  const root = `${flatPath(F.repo).replace(/\/+$/, '')}/`.toLowerCase()
  const f = flatPath(p).toLowerCase()
  return plainGlob(f.startsWith(root) ? f.slice(root.length) : f)
}
function alwaysLoaded(p) {
  const f = loadedForm(p)
  const base = f.slice(f.lastIndexOf('/') + 1)
  if (/^(claude|claude\.local|agents)\.md$/.test(base) || f === loadedForm(AGENTS_INDEX) || f.startsWith('.claude/agents/')) return true
  return Object.values(PERSONAS).some((x) => isPlainObject(x) && typeof x.file === 'string' && loadedForm(x.file) === f)
}

// again (0.29.0, ADR-0046 item 6): a re-run after a fix round ({why, from, items}) or to clear knowledge-lint failures ({why, from,
// items: [], lint}); it reviews only the fix's diff, from `from` (the head before that round)
function knowledgePrompt(crew, resume, again = null) {
  const e = crew.e
  const note = (i) => (!isMarkdown(i.target) ? ' (not markdown: skip it and list it in your report)' : i.kind === 'product' && alwaysLoaded(i.target) ? ` (always loaded: a product call never goes there; record it in ${productOwnerFile()} instead)` : '')
  const items = (again ? again.items : crew.learned).map((i) => `- [${i.kind}] ${i.text} (source: ${i.source || 'none given'}${i.target ? `; target: ${i.target}${note(i)}` : ''}; from ${i.member}, task ${i.task})`)
  const moved = crew.sourceChanges.map((c) => (c.status === 'A' ? `- added ${c.path}` : c.status === 'D' ? `- deleted ${c.path}` : `- renamed ${c.from} -> ${c.path}`))
  const from = again && again.from ? again.from : e.base
  const body = [
    `Task: record what crew ${crew.slug} learned`,
    ...(again && again.lint
      ? ['Why this run: the knowledge lint failed on the docs this crew changed. Fix each failure below in the doc it names (for a stale stamp, re-read the doc against the diff, fix what is wrong, then set `verified`; fix or drop a citation; fold an entry under its budget); change nothing else.', ...lintData(again.lint)]
      : again
        ? [`Why this run: a fix round (${again.why}) changed the code after the docs were recorded. Bring every doc the fix diff makes stale back in line, and record the fixers' learned items below.`]
        : []),
    `Learned items: ${items.length ? `\n${items.join('\n')}` : 'none reported'}`,
    ...(moved.length ? [`Source files the diff added, renamed or deleted (from git diff --name-status -M; tests, fixtures and docs left out):\n${moved.join('\n')}\nGive each user-facing capability among them a feature-map entry, and fix the feature-map entries and persona paths that name a deleted or renamed file. A file that is only an internal helper needs none.`] : []),
    `Diff range: ${from}...${crew.head || 'HEAD'} (git diff ${from}...${crew.head || 'HEAD'}, in the crew checkout)`,
    `Feature map: ${FEATURE_MAP}`,
    `Persona files the crew used: ${crewPersonaFiles(crew).join(', ') || 'none'}`,
    `Product decisions file: ${productOwnerFile()}`,
    `Agents index: ${AGENTS_INDEX}`,
    `Rules directory: ${RULES_DIR}`,
    `Knowledge directory: ${KNOWLEDGE_DIR}`,
    ...(ruleFilesOf(F.rules).length ? [`Rule files that exist: ${ruleFilesOf(F.rules).join(', ')}`] : []),
    `ADR directory: ${ADR_DIR}`,
    '',
    'Why: a later crew must find where functionality lives, what a persona must know and what the product owner decided from these docs, not by analysing the codebase again.',
    `Update the docs in your own worktree (the paths above are repo-relative), and change only docs. A learned item that names a target goes to that path, but a product item never goes into an always-loaded file (CLAUDE.md, AGENTS.md, the agents index or a persona file): ignore that target and record the call in the product decisions file. Only a markdown file (*.md) is a target: skip an item whose target is any other file, change nothing for it, and list it in your report. An item with no target goes where the table below says: a feature item is a capability; a persona item is an area-scoped rule or a cross-cutting persona rule; a product item is a product call; a decision item is a decision.`,
    '',
    'Where each item goes:',
    '| Item | Goes to |',
    '|---|---|',
    `| Area-scoped stack rule or invariant | \`${RULES_DIR}/<area>.md\`, with \`paths\` globs |`,
    '| Cross-cutting persona rule | the persona file, under `## Standards` |',
    `| Capability | the feature map (${FEATURE_MAP}) |`,
    `| Product call | the product decisions file (${productOwnerFile()}) |`,
    `| Decision | a new ADR in ${ADR_DIR} |`,
    '| Anything else | nowhere |',
    '',
    fragmentLine(crew.slug),
    '',
    `A rule file is lowercase ASCII kebab-case (\`${RULES_DIR}/export-ui.md\`), with frontmatter \`paths\` (globs: \`**\`, \`*\`, \`?\`, \`/\` and \`{a,b}\` alternation, no nested braces, no negation; each must match a tracked file), \`sources\` (the repo paths its facts come from) and \`verified\`. A rule holds invariants, gotchas and where-X-lives for that area, never a product call. A longer topic goes to \`${KNOWLEDGE_DIR}/<topic>.md\`, with frontmatter \`sources\` and \`verified\`, one topic per file. The persona files hold Standards only: a product call is never written into a persona file.`,
    `The feature map gets an entry for each user-facing capability the diff adds or moves, even when no item names it: what it does, its entry points as paths, the owning persona and pointers to its docs. A persona file gets a Standards item the crew learned only when it holds for every task of that persona, and a path a persona file names that the diff moved is fixed. The product decisions file gets the product calls this crew made and any domain truth.`,
    'Every fact you write cites its source path or hunk; drop a fact you cannot cite.',
    // ADR-0046 items 2 and 12: the mechanical repairs run here, before QC, so QC never fails on them
    'Before you commit, repair what is mechanical in the docs the diff touches: cite code by symbol (a function or constant name), not by line number; replace every `file:line` citation the docs hold with the symbol it points at; set `verified` on each doc you re-read.',
    'Then check every line of skill and agent prose (SKILL.md, agents/*.md) the diff added or changed against the code it describes; fix a line that says the code does something it does not, and name each fix in your report.',
    'Reconcile before you add: read what the doc says about the topic, then edit or delete an entry the diff supersedes or contradicts; never append a duplicate or a second entry on the same fact.',
    `Set \`verified: ${crew.head || 'the crew head'}\` in the frontmatter of every rule or knowledge doc you create or edit.`,
    `A new knowledge or rule file is linked from the feature map or the agents index (${AGENTS_INDEX}), in the same commit; the index holds pointers only.`,
    `Budgets (lines; the lint fails an always-loaded file over its budget): agents index ${BUDGETS.agentsIndex}, persona ${BUDGETS.persona} and ${BUDGETS.personaStandards} items under \`## Standards\`, rule file ${BUDGETS.rule}. It warns on a knowledge doc over ${BUDGETS.doc} and a feature-map entry over ${BUDGETS.featureEntry}. Over budget, fold entries into one another or move area rules to ${RULES_DIR}/<area>.md.`,
    'Keep every entry terse. Edit or merge into an existing entry rather than appending a new one beside it. Nothing to record is a valid outcome: Recording nothing for an item is allowed when the code already makes it obvious, and so is an unchanged doc. Name every architecture section, ADR, feature-map entry or rule file this change makes stale: update the descriptive text in the architecture doc and the feature map (module map entries, paths, how a module works), never edit an existing ADR, and raise a design PROPOSAL instead when an ADR\'s decision no longer holds.',
    `Commit with the subject \`docs(knowledge): ${crew.slug} learned\`, list every file you changed (repo-relative) in the files field of your report, and report DONE.`,
  ]
  if (resume) body.push('', ...resumeLines(resume))
  const start = firstStep(e, resume ? resume.branch : '')
  return `Knowledge: crew ${crew.slug}\n${memberPrompt(crew, 'writer', { start, body, noLearned: true })}`
}

// Runs the writer member that records what the crew learned. Only when a member (or a product call) reported learned items, or the
// green check saw the diff add, rename or delete non-test source files (sourceChanges, from git), and the crew has code tasks;
// otherwise skipped with no run. A crew whose tasks are all writer tasks always skips it. The writer edits docs from given items, so
// it runs on Sonnet at effort medium, not the writer row's Opus; QC (Opus) checks the result.
// Returns false when it did not run, true when it ran; the caller then runs green again, always: markdown can be test input (this
// repo's own prose checks read SKILL.md and agents/*.md), and land runs no check.
async function knowledge(crew, again = null) {
  if (!hasCodeTasks(crew)) return false
  if (!again && !crew.learned.length && !crew.sourceChanges.length) return false
  crew.step = 'knowledge'
  const before = crew.head
  const wmake = (resume) => knowledgePrompt(crew, resume, again)
  const wopts = { title: `Record what ${crew.slug} learned`, member: { model: 'sonnet', effort: 'medium' } }
  const first = await pendingCall(crew, 'writer', wmake, wopts, 'knowledge')
  const report = await runMember(crew, 'writer', wmake, wopts, 'knowledge', first)
  crew.learned = crew.learned.filter((i) => i.task !== 'knowledge')
  crew.unrecorded = crew.unrecorded.filter((i) => i.task !== 'knowledge')
  // the fixers' items this re-run recorded count as learned, no longer as unrecorded
  if (again && again.items.length) {
    crew.unrecorded = crew.unrecorded.filter((i) => !again.items.includes(i))
    crew.learned.push(...again.items)
  }
  crew.proofs.push(`knowledge: ${report.proof}`)
  const head = await integrate(crew, report.branch, 'knowledge')
  crew.knowledgeRan = true
  const sha = typeof report.commit === 'string' && report.commit.trim() ? report.commit.trim() : null
  if (sha) {
    crew.knowledgeSha = sha
    // a refusal (the sha is not in before..head) or a failure is logged and the crew carries on: green re-runs, and owns-check then
    // refuses any out-of-owns doc change because no commit is exempt
    await recordKnowledgeCommit(crew, sha, before, head)
  }
  return true
}

// factory knowledge-commit: the crew's knowledge commit, which factory's owns check exempts. A failure is logged, never stops the crew.
// Returns the parsed result ({slug, sha, files} when base and head are given), or null.
async function recordKnowledgeCommit(crew, sha, base, head) {
  try {
    const range = base && head ? ` --base=${sh(base)} --head=${sh(head)}` : ''
    const r = await runFactory(crew, `knowledge-commit --slug ${sh(crew.slug)} --sha ${sh(sha)}${range}`, 'sha')
    if (!r.parsed || typeof r.parsed.sha !== 'string') {
      log(`knowledge-commit not confirmed: crew ${crew.slug}: ${clip(r.out, 300)}`)
      return null
    }
    return r.parsed
  } catch (err) {
    if (err instanceof Stop) throw err
    log(`knowledge-commit failed: crew ${crew.slug}: ${err && err.message ? err.message : String(err)}`)
    return null
  }
}

// ADR-0046 item 9: what in a doc blocks QC and what does not
const DOC_DRIFT_LINE = 'Doc drift: a `verified` stamp behind the head, or a `file:line` citation whose line moved while the cited code still exists, is never a FAIL; list it under ## Notes. A doc statement that is wrong about what the code does (behaviour, a name, a path that no longer exists) is a FAIL, quoting it.'

// ADR-0033: the QC brief's Knowledge block, when one of its two rules can apply: the crew has code tasks or made product calls
function knowledgeLines(crew) {
  if (!hasCodeTasks(crew) && !crew.decisions.length) return lintLines(crew)
  const calls = crew.decisions.map((d) => `- ${d.question} | ${d.answer}${d.reply === 'change' ? ' (overruled by main session)' : ''}`)
  return [
    'Knowledge:',
    `Feature map: ${FEATURE_MAP}`,
    `Product decisions file: ${productOwnerFile()}`,
    ...(crew.knowledgeSha ? [`Knowledge commit: ${crew.knowledgeSha} (the docs commit this crew's knowledge step made)`] : []),
    ...(calls.length ? ['Product calls this crew made:', ...calls] : []),
    'If the diff adds or moves user-facing functionality, the feature map must be updated in this diff, and every product call this crew made must appear in the product decisions file; otherwise FAIL, quoting the missing entry.',
    `A crew's fragment of a shared doc (\`<doc without .md>.d/${crew.slug}.md\`, or \`${RULES_DIR}.d/<area>/${crew.slug}.md\` for a rule file) counts as an update of that doc: \`factory stitch\` folds it in when the run ends. An edit to the body of a shared doc that already existed, instead of a fragment, goes under ## Notes, never a FAIL.`,
    'Never FAIL for missing optional learning: a stack rule, a domain truth or a decision the code already makes obvious.',
    DOC_DRIFT_LINE,
    '',
    ...lintLines(crew),
  ]
}

