// stage.js module: the stress test and its fix round. Edit here, then run `npm run build:stage`.
// drops one leading "[harness:" paragraph (up to the next blank line) before the first non-empty line; mirrors register.ts unbannered
const unbannered = (text) => {
  const lines = String(text || '').replace(/^﻿/, '').replace(/\r/g, '').split('\n')
  const i = lines.findIndex((l) => l.trim() !== '')
  if (i < 0 || !lines[i].trimStart().startsWith('[harness:')) return lines.join('\n')
  let j = i
  while (j < lines.length && lines[j].trim() !== '') j++
  return lines.slice(j).join('\n')
}

const stressTestCount = (text) => {
  const first = unbannered(text).split('\n').find((l) => l.trim() !== '')
  const m = first && first.trim().match(/^STRESSTEST: (\d+) findings$/)
  return m ? Number(m[1]) : null
}

// A Workflow run gives the stress test a worktree on a worktree-wf_<run>-<n> branch. agents/stress-engineer.md accepts it (its own-worktree rule),
// but a session that loaded the agent definition before that change still checks for worktree-agent- only and refuses to
// run (plugin agents don't reload mid-session), so the brief carries the rule itself.
const WF_WORKTREE = 'Your worktree is one this Workflow run made, so `git branch --show-current` starts with `worktree-wf_`, not `worktree-agent-`. That branch passes the own-worktree check: when the git-dir and git-common-dir differ and the branch starts with `worktree-wf_` or `worktree-agent-`, you are in your own worktree; reset it to the head above and run the stress test there. Never report `STRESSTEST: not run` because the branch starts with `worktree-wf_`.'

function stressTestPrompt(crew) {
  const e = crew.e
  return [
    'Stress test:',
    `Try to break crew ${crew.slug}'s work at head ${crew.head} on branch ${e.branch}.`,
    `Goal file: ${e.goalFile}`,
    `ADRs: ${e.adrs.join(', ') || 'none'}`,
    `High-impact paths: ${e.highImpact.join(', ') || 'none'}`,
    `Architecture doc: ${e.architecture}`,
    `Base: ${e.base}`,
    `Patch: git diff ${e.base}...${crew.head}`,
    '',
    WF_WORKTREE,
    '',
    SHELL,
    '',
    REFUSAL,
    PKILL,
    '',
    'Each finding names a plausible producer: the real caller or input that would produce the break.',
    'Class each finding as a real defect or a test gap. Only real defects count in STRESSTEST <n> and go under ## Findings; test gaps go under ## Notes and are not fixed.',
  ].join('\n')
}

async function runStressTest(crew) {
  crew.step = 'stress'
  guardAllowance(crew, 'stress')
  let text = await ask(crew, 'stress', stressTestPrompt(crew))
  if (stressTestCount(text) === null) {
    text = await ask(crew, 'stress', stressTestPrompt(crew))
    if (stressTestCount(text) === null) throw new Stop('BLOCKED', `the stress test gave no STRESSTEST line twice:\n${text || 'no result'}`, 'stress')
  }
  return text
}

// the lines of one "## " section of a report, up to the next line starting "## " or the end
function sectionOf(text, heading) {
  const out = []
  let section
  for (const line of String(text || '').replace(/^﻿/, '').replace(/\r/g, '').split('\n')) {
    if (line.startsWith('## ')) section = line.trimEnd()
    else if (section === heading) out.push(line)
  }
  return out
}

// one stress-test round: real defects go to one fix builder and one green run; test gaps (## Notes) are only handed back
async function stressTest(crew) {
  const text = await runStressTest(crew)
  crew.stressTest = text
  crew.deferred = sectionOf(text, '## Notes').filter((l) => l.startsWith('- ')).map((l) => l.slice(2))
  if (stressTestCount(text) === 0) return
  crew.step = 'stress'
  // a report with no ## Findings heading (bullets straight after the STRESSTEST line) goes whole, less its ## Notes section
  const findings = /^## Findings\s*$/m.test(text) ? sectionOf(text, '## Findings').join('\n') : String(text).replace(/\r/g, '').split('\n## Notes')[0]
  const from = crew.head
  await fixFindings(crew, 'stress-test findings', 'A stress test reported these findings:', findings, `A stress test reported these findings:\n${findings}`, () => true)
  // ADR-0046 item 3: the round's diff must add or change a test, checked at green, before QC
  await green(crew, { testsSince: from, findings })
}

