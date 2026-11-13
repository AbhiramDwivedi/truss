// stage.js module: UX direction and review (ADR-0022 U4). Edit here, then run `npm run build:stage`.
// ---------------------------------------------------------------- UX direction and review (ADR-0022 U4)

// the first non-empty line of a reply, past a harness banner
const firstLineOf = (text) => (unbannered(text).split('\n').find((l) => l.trim() !== '') || '').trim()
const stopTagOf = (first) => ['QUESTION', 'BLOCKED', 'PROPOSAL'].find((t) => first.startsWith(`${t}:`))
const replyOf = (v) => unbannered(typeof v === 'string' ? v : '').replace(/\r/g, '').trim()

function uxDirectionPrompt(crew) {
  const e = crew.e
  const answers = (e.answers || []).filter((a) => a.at === 'ux-direction').map((a) => `- ${a.text}`)
  const lines = [
    `UX direction: crew ${crew.slug}`,
    `Goal file: ${e.goalFile}`,
    `Crew worktree: ${e.worktree}`,
    `Approved scope: ${scopeOf(e)}`,
    `Architecture doc: ${e.architecture}`,
    `ADRs: ${(e.adrs || []).join(', ') || 'none'}`,
  ]
  if (answers.length) lines.push('', 'Answers to your earlier questions:', ...answers)
  lines.push('', REFUSAL, PKILL)
  return lines.join('\n')
}

// UX: DIRECTION keeps the reply as the direction; a stop tag stops the crew; anything else gets one fresh ux agent
async function uxDirection(crew) {
  crew.step = 'ux-direction'
  let text = ''
  for (let n = 0; n < 2; n++) {
    const got = {}
    text = replyOf(await ask(crew, 'ux', uxDirectionPrompt(crew), { at: 'ux-direction', labelOut: got, title: `UX direction ${crew.slug}` }))
    const first = firstLineOf(text)
    if (first.startsWith('UX: DIRECTION')) {
      crew.direction = { label: got.label, text }
      return
    }
    const tag = stopTagOf(first)
    if (tag) throw new Stop(tag, text, 'ux-direction')
  }
  throw new Stop('BLOCKED', `no direction from two UX engineers:\n${text || 'no result'}`, 'ux-direction')
}

// i30: a page, component or style is a literal suffix match on an owns entry; a glob such as ui/e2e/** is not one
const UI_SUFFIXES = ['.tsx', '.jsx', '.vue', '.svelte', '.css', '.html']
// ADR-0026 item 51 1: an owns entry exactly ui/** also counts as owning UI; other subtree globs stay files
const ownsUiFile = (owns) => (owns || []).some((f) => String(f) === 'ui/**' || UI_SUFFIXES.some((s) => String(f).endsWith(s)))

// i30/i33: the review mode and how the reviewer takes its own screenshots
function reviewModeLines(e) {
  const livePage = typeof e.livePage === 'string' && e.livePage.trim() ? e.livePage : null
  const mode = livePage || ownsUiFile(e.owns) ? 'live' : 'files'
  const out = [`Review mode: ${mode}`]
  if (mode === 'files') {
    out.push("This crew owns no page, component or style: judge the direction's checklist from the files and diff alone.")
  } else {
    out.push('Take your own screenshots of each screen the direction names.')
    if (livePage) out.push("The goal file's ## UX Live page line, quoted:", livePage)
    else if ((e.owns || []).includes('ui/**')) {
      out.push(
        'No Live page line was given, so use the default for a crew that owns ui/**:',
        '1. Run `npm --prefix ui run build`.',
        '2. Start `node ui/server/main.ts` in the background on a port the OS picks, and note its pid.',
        '3. Wait for its listening line, which names the port.',
        '4. Capture each screen with @playwright/test chromium, loaded from ui/node_modules.',
        '5. Kill the server by its pid.',
      )
    }
  }
  if (!livePage) out.push("Read the goal file's ## UX section: if it has a Live page line, follow it to take your screenshots and review live.")
  out.push('Never stop BLOCKED for missing screenshots: after two failed starts, review from the files and say so in your report.')
  return out
}

function uxReviewPrompt(crew, previous) {
  const e = crew.e
  const lines = [
    `UX review: crew ${crew.slug}`,
    `Goal file: ${e.goalFile}`,
    `Checkout: ${e.worktree}`,
    `Head: ${crew.head}`,
    `Crew branch: ${e.branch}`,
    '',
    ...directionLines(crew),
    '',
    ...reviewModeLines(e),
    '',
    "The last green check's output tail:",
    clip(crew.greenOut || 'none'),
  ]
  if (previous) lines.push('', `The previous review (report ${previous.label}) asked for rework:`, previous.text)
  // an answer to a QUESTION: stop at ux-review reaches the next reviewer, as uxDirectionPrompt passes ux-direction answers
  const answers = (e.answers || []).filter((a) => a.at === 'ux-review').map((a) => `- ${a.text}`)
  if (answers.length) lines.push('', 'Answers to your earlier questions:', ...answers)
  lines.push('', REFUSAL, PKILL)
  return lines.join('\n')
}

// a review's numbered findings (`<n>. <screen>: ...`), each with its indented continuation lines
function uxFindingsOf(text) {
  const out = []
  for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
    if (/^\s*\d+\.\s/.test(line)) out.push(line.trim())
    else if (/^\s+\S/.test(line) && out.length) out[out.length - 1] += `\n${line.trim()}`
  }
  return out
}

// one review: UX: PASS or UX: REWORK; a stop tag stops the crew; no verdict gets one fresh reviewer, then BLOCKED
async function runUxReview(crew, previous) {
  let text = ''
  for (let n = 0; n < 2; n++) {
    const got = {}
    text = replyOf(await ask(crew, 'ux', uxReviewPrompt(crew, previous), { at: 'ux-review', labelOut: got, title: `UX review ${crew.slug}` }))
    const first = firstLineOf(text)
    const verdict = first.startsWith('UX: PASS') ? 'PASS' : first.startsWith('UX: REWORK') ? 'REWORK' : null
    if (verdict) return { label: got.label, text, verdict, findings: verdict === 'REWORK' ? uxFindingsOf(text) : [] }
    const tag = stopTagOf(first)
    if (tag) throw new Stop(tag, text, 'ux-review')
  }
  throw new Stop('BLOCKED', `no verdict from two UX reviews:\n${text || 'no result'}`, 'ux-review')
}

// after green, before the stress test, scope and QC: a REWORK costs one rework unit, as a QC FAIL does
async function uxReview(crew) {
  let previous = null
  for (;;) {
    crew.step = 'ux-review'
    guardAllowance(crew, 'ux-review')
    const rv = await runUxReview(crew, previous)
    crew.uxReview = rv
    if (rv.verdict === 'PASS') return
    crew.fails++
    if (spendOf(crew) > F.reworkAllowance) throw allowanceStop(crew, 'ux-review', rv.text)
    const header = 'The UX review asked for rework, with these findings:'
    const findings = rv.findings.length ? rv.findings.map((f) => `- ${f}`).join('\n') : rv.text
    await fixFindings(crew, 'UX findings', header, findings, `${header}\n${findings}`)
    await green(crew)
    previous = rv
  }
}

