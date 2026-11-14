// The rubric grader for the retro judge and triage output (ADR-0051 Decision 10). The judge and triage are LLM agents, so their
// output is graded in code: over a recording in the default suite, and over a fresh run in `retro-generic-live.e2e.ts`.
// `grade(judgeReport, triageReport, problems)` returns `{ pass, failures }`. It never imports retro/cli.ts or retro/counts.ts: it
// reads the fenced `finding` blocks and the `TRIAGE:` lines itself, so a wrong parser in the code under test cannot hide a failure.
// Erasable TypeScript, Node built-ins only.

type Json = Record<string, any>
export type Graded = { pass: boolean; failures: string[] }

const TARGET_KINDS = ['plugin', 'project-config', 'proposed-goal']
const DECISIONS = ['fix now', 'defer', 'drop']

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The fenced `finding` blocks of a judge report, in order: the parsed JSON, or the reason it is not JSON. */
export function findingBlocks(report: string): { n: number; value: Json | null; why: string | null }[] {
  const out: { n: number; value: Json | null; why: string | null }[] = []
  const lines = report.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() !== '```finding') continue
    const body: string[] = []
    let j = i + 1
    while (j < lines.length && lines[j].trimEnd() !== '```') body.push(lines[j++])
    const n = out.length + 1
    i = j
    if (j >= lines.length) {
      out.push({ n, value: null, why: 'block is never closed' })
      continue
    }
    try {
      const v = JSON.parse(body.join('\n'))
      out.push(isObj(v) ? { n, value: v, why: null } : { n, value: null, why: 'block is not a JSON object' })
    } catch {
      out.push({ n, value: null, why: 'block is not valid JSON' })
    }
  }
  return out
}

// null last: a null cost sorts after any number
const desc = (a: number | null, b: number | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a)

export function grade(judgeReport: string, triageReport: string, problems: { measures: Record<string, number>; findings: { id: string }[] }): Graded {
  const failures: string[] = []
  const fail = (s: string) => failures.push(s)
  const measures = problems.measures ?? {}
  const blocks = findingBlocks(judgeReport)
  if (blocks.length === 0) fail('the judge report holds no finding block')
  const costs: { n: number; wallMs: number | null; tokens: number | null }[] = []
  for (const b of blocks) {
    const at = `finding ${b.n}`
    const f = b.value
    if (!f) {
      fail(`${at}: ${b.why}`)
      continue
    }
    if (!nonEmpty(f.category)) fail(`${at}: category must be a non-empty string`)
    if (!nonEmpty(f.title)) fail(`${at}: title must be a non-empty line`)
    if (!Array.isArray(f.evidence) || f.evidence.length === 0) fail(`${at}: no counted evidence`)
    else {
      for (const e of f.evidence) {
        if (!isObj(e) || !nonEmpty(e.measure) || !isNum(e.value)) {
          fail(`${at}: an evidence entry is not {measure, value}`)
          continue
        }
        if (!Object.hasOwn(measures, e.measure)) fail(`${at}: evidence measure ${e.measure} is not counted`)
        else if (measures[e.measure] !== e.value) fail(`${at}: evidence measure ${e.measure} is ${e.value}, the count is ${measures[e.measure]}`)
      }
    }
    const c = f.cost
    if (!isObj(c) || !['wallMs', 'tokens', 'usd'].every((k) => k in c && (c[k] === null || isNum(c[k])))) fail(`${at}: cost must be {wallMs, tokens, usd}, each a number or null`)
    else if (c.wallMs === null && c.tokens === null && c.usd === null) fail(`${at}: cost has no number`)
    else costs.push({ n: b.n, wallMs: c.wallMs, tokens: c.tokens })
    if (!nonEmpty(f.fix)) fail(`${at}: fix must be a non-empty sentence`)
    if (!isObj(f.target) || !TARGET_KINDS.includes(f.target.kind)) fail(`${at}: target.kind must be one of ${TARGET_KINDS.join(', ')}`)
  }
  for (let i = 1; i < costs.length; i++) {
    const a = costs[i - 1]
    const b = costs[i]
    if (desc(a.wallMs, b.wallMs) > 0 || (a.wallMs === b.wallMs && desc(a.tokens, b.tokens) > 0)) fail(`ranking: finding ${b.n} costs more than finding ${a.n}, which is listed before it`)
  }
  // A finding id is one the counting step assigned, or F-<n> for the n-th kept judge finding (what `retro/cli.ts findings` assigns).
  const known = new Set<string>(problems.findings.map((x) => x.id))
  for (let n = 1; n <= blocks.length; n++) known.add(`F-${n}`)
  const tl = triageReport.split(/\r?\n/).filter((l) => l.startsWith('TRIAGE:'))
  if (tl.length === 0) fail('the triage report holds no TRIAGE line')
  for (const l of tl) {
    const parts = l.slice('TRIAGE:'.length).split('|').map((s) => s.trim())
    if (parts.length < 3 || !nonEmpty(parts[0]) || !DECISIONS.includes(parts[1]) || !nonEmpty(parts.slice(2).join('|'))) fail(`triage line is not "TRIAGE: <id> | <fix now|defer|drop> | <reason>": ${l}`)
    else if (!known.has(parts[0])) fail(`triage line names an unknown finding id ${parts[0]}`)
  }
  return { pass: failures.length === 0, failures }
}
