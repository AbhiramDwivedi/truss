// Builds ui/contract/fixtures/rework/real-data/state.json (ADR-0029 Contract) from the raw fixture
// ui/contract/fixtures/real-data/: a truss dir plus a fake Claude dir. The raw events are folded through the real server
// reducer (ui/server/state/reduce.ts) as make-real-12.ts does, so the crews have the shape the server serves; tags stay as
// the reducer gives them (the client's agentStatus applies the done rule). Member `task` is filled from the agent
// transcripts by ADR-0029 section 2 (the first non-empty brief line after the harness preamble, dedented, cut to 200
// characters; null when the file is missing). `by` is read here and never leaves. Every time is moved so the newest is one
// minute before the fixture anchor 2026-11-02T12:00:00.000Z. Reproducible: the same raw fixture gives the same bytes.
// Run: node ui/contract/rework/make-real-data.ts
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createReducer } from '../../server/state/reduce.ts'
import type { Plan } from '../../server/state/reduce.ts'
import { parseDecisions } from '../../server/state/files.ts'

const here = import.meta.dirname
const RAW = resolve(here, '..', 'fixtures', 'real-data')
const SESSION = '00000000-0000-4000-8000-000000000001'
const TRUSS = join(RAW, 'truss', SESSION)
const SUB = join(RAW, 'claude', 'projects', '-fixture-repo', SESSION, 'subagents')
const OUT = resolve(here, '..', 'fixtures', 'rework', 'real-data', 'state.json')
const AGENTS_DIR = resolve(here, '..', '..', '..', 'plugins', 'truss', 'agents')
const ANCHOR = Date.parse('2026-11-02T12:00:00.000Z')
const PREAMBLE_END = 'The computed task text follows:'

type Ev = Record<string, any>
const events: Ev[] = readFileSync(join(TRUSS, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const rawPlan = JSON.parse(readFileSync(join(TRUSS, 'plan.json'), 'utf8'))
const rawDecisions = parseDecisions(readFileSync(join(TRUSS, 'decisions.md'), 'utf8'))

const maxTs = Math.max(...events.map((e) => Date.parse(e.ts)))
const shift = ANCHOR - 60_000 - maxTs
const move = (iso: string | null): string | null => (iso === null ? null : new Date(Date.parse(iso) + shift).toISOString())
const moveRun = (run: string | null): string | null => {
  if (run === null) return null
  const m = /^(\S+)(.*)$/s.exec(run)!
  return `${new Date(Date.parse(m[1]!) + shift).toISOString().replace(/\.\d{3}Z$/, 'Z')}${m[2]}`
}

// ---- the fold, through the server reducer ----------------------------------------------------------------------

const plan: Plan = {
  goal: rawPlan.goal, version: rawPlan.version, approval: rawPlan.approval, approvedAt: move(rawPlan.approvedAt),
  goals: [],
  crews: rawPlan.crews.map((c: any) => ({
    slug: c.slug, stage: c.stage ?? null, verdict: c.verdict ?? null, status: c.status ?? null,
    goal: c.goal ?? null, owns: c.owns ?? [], estAgents: c.estAgents ?? null,
  })),
}
const reducer = createReducer()
for (const e of events) reducer.event({ ...e, ts: move(e.ts) })
const run = reducer.build(plan, () => null)

// ---- ADR-0029 section 2: the task from the transcript -----------------------------------------------------------

const byOf = new Map<string, string | null>() // "<crew>\0<agent>" -> the latest spawn line's by (read here, never published)
const idOf = new Map<string, string | null>()
for (const e of events) {
  if (e.event !== 'spawn') continue
  byOf.set(`${e.crew}\0${e.agent}`, typeof e.by === 'string' ? e.by : null)
  idOf.set(`${e.crew}\0${e.agent}`, typeof e.agentId === 'string' ? e.agentId : null)
}
function taskOf(agentId: string | null, by: string | null): string | null {
  if (agentId === null) return null
  const wf = by !== null && by.startsWith('workflow:') ? by.slice('workflow:'.length) : null
  const file = join(SUB, ...(wf === null ? [] : ['workflows', wf]), `agent-${agentId}.jsonl`)
  if (!existsSync(file)) return null
  const first = readFileSync(file, 'utf8').split('\n')[0]!
  const content = JSON.parse(first)?.message?.content
  if (typeof content !== 'string') return null
  const at = content.indexOf(PREAMBLE_END)
  if (at < 0) return null
  const line = content.slice(at + PREAMBLE_END.length).split('\n').map((l) => l.trim()).find((l) => l !== '')
  return line === undefined ? null : line.slice(0, 200)
}

const descriptions = new Map<string, string>()
if (existsSync(AGENTS_DIR)) {
  for (const f of readdirSync(AGENTS_DIR).filter((x) => x.endsWith('.md')).sort()) {
    const m = /^description:\s*(.+)$/m.exec(readFileSync(join(AGENTS_DIR, f), 'utf8'))
    if (m) descriptions.set(f.slice(0, -3), m[1]!.trim().replace(/^["']|["']$/g, '').split(/(?<=\.)\s/)[0]!)
  }
}
const purposeOf = (type: string | null, isForeman: boolean): string | null => {
  if (isForeman || type === 'workflow-crew') return descriptions.get('foreman') ?? null
  if (type === null) return null
  return descriptions.get(type.replace(/^truss:/, '')) ?? null
}
const decorate = (m: any, crew: string, isForeman: boolean): any => {
  const key = `${crew}\0${m.name}`
  const agentId = idOf.get(key) ?? null
  return { ...m, agentId, purpose: purposeOf(m.type, isForeman), task: taskOf(agentId, byOf.get(key) ?? null) }
}
for (const c of run.crews as any[]) {
  if (c.foreman) c.foreman = decorate(c.foreman, c.slug, true)
  c.members = c.members.map((m: any) => decorate(m, c.slug, false))
}

// ---- the state --------------------------------------------------------------------------------------------------

const state = {
  v: 1,
  repo: '/work/demo',
  trussDir: { path: `/work/demo/.git/truss/${SESSION}`, exists: true },
  session: {
    status: 'idle', sessionId: null, model: null, claudeCodeVersion: null, permissionMode: null, plugin: null,
    usage: null, backgroundTasks: [], error: null, queue: [],
  },
  requests: [],
  transcript: [],
  run,
  decisions: rawDecisions.map((d) => ({ ...d, run: moveRun(d.run) })),
  adrs: [],
  design: { planMd: null, architecture: null, images: [] },
  notices: [],
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(state, null, 2) + '\n')
console.log(`real-data: ${run.crews.length} crews -> ${OUT}`)
