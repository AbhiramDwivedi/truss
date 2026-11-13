// stage.js module: verdicts, UNSCOPED lines and the context blocks of the QC brief. Edit here, then run `npm run build:stage`.
// the same rule as register.ts qcRuling and markerOf: the first non-empty line decides
function verdictOf(text) {
  const lines = unbannered(text).split('\n')
  const first = (lines.find((l) => l.trim() !== '') || '').trimStart()
  if (first.startsWith('VERDICT: PASS')) return 'PASS'
  if (first.startsWith('VERDICT: FAIL')) return 'FAIL'
  return undefined
}

// mirrors register.ts UNSCOPED (stage.js cannot import it)
const UNSCOPED = '- UNSCOPED: '

// the UNSCOPED lines under ## Findings; a section runs from its "## " heading to the next line starting "## " (register.ts qcRuling)
function unscopedOf(text) {
  const out = []
  let section
  for (const line of String(text || '').replace(/^﻿/, '').replace(/\r/g, '').split('\n')) {
    if (line.startsWith('## ')) section = line.trimEnd()
    else if (section === '## Findings' && line.startsWith(UNSCOPED)) out.push(line)
  }
  return out
}

// report paths of the crew's earlier members, from labelFrom (same label scheme as nextLabel, without touching the counters)
function earlierReports(crew) {
  const from = crew.e.labelFrom || {}
  const path = (role, n) => `${F.dir}/reports/${crew.slug}/${n === 1 ? `${crew.slug}-${role}` : `${crew.slug}-${role}-${n}`}.md`
  const paths = []
  for (const role of Object.keys(from).sort()) {
    for (let n = 1; n < from[role]; n++) {
      if (role === 'stress' && n === from[role] - 1) continue
      paths.push(path(role, n))
    }
  }
  const last = from.stress > 1 ? path('stress', from.stress - 1) : null
  return { paths, last }
}

// ADR-0022 U4: a ux crew's QC gets the direction and the last review's label, verdict and findings; [] on other crews
function uxQcLines(crew) {
  if (!uxOn(crew)) return []
  const rv = crew.uxReview
  const review = rv
    ? [`Last UX review: report ${rv.label}, verdict ${rv.verdict}.`, ...(rv.findings.length ? ['Its findings:', ...rv.findings] : [])]
    : ['Last UX review: none in this run.']
  const dl = directionLines(crew)
  return [...(dl.length ? [...dl, ''] : []), ...review, 'Check the UI work against the UX direction yourself.', '']
}

// ADR-0024 item 25: QC gets the answers at the UX steps, which no member gets; [] when there are none
function uxAnswerLines(crew) {
  const answers = (crew.e.answers || []).filter((a) => a && UX_STEPS.includes(a.at))
  return answers.length ? ['Answers to earlier stops of this crew:', ...answers.map((a) => `- at ${a.at}: ${a.text}`), ''] : []
}

// ADR-0032: the persona files QC holds the diff to: every persona this crew's tasks used, then every read-only persona (a judge,
// such as a product owner). [] when there are none.
function standardsLines(crew) {
  const files = []
  const add = (n) => {
    const f = PERSONAS[n] && PERSONAS[n].file
    if (typeof f === 'string' && f && !files.includes(f)) files.push(f)
  }
  for (const t of (crew.tasks && crew.tasks.length ? crew.tasks : crew.e.tasks) || []) if (taskPersona(t) && Object.hasOwn(PERSONAS, taskPersona(t))) add(taskPersona(t))
  for (const n of Object.keys(PERSONAS)) if (PERSONAS[n] && PERSONAS[n].readOnly === true) add(n)
  return files.length ? ['Standards: hold the diff to the Standards section of each of these persona files; quote the item you rule on:', ...files.map((f) => `- ${f}`), ''] : []
}

