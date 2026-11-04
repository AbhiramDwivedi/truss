// Builds ui/contract/fixtures/rework/real-12/state.json (ADR-0028 section 11, fixture F4) from a real truss dir:
// the 79-crew run 361b2630-4123-451d-98e0-e36681a3c70c, trimmed to 12 crews and at most 100 agents.
// The run is folded through the real server reducer (ui/server/state/reduce.ts), so the crews have the shape the
// server serves. Reproducible: the same dir gives the same bytes. Run: node ui/contract/rework/make-real-12.ts [dir]
//
// The trim: the 12 crews with the most agents (ties by plan order); each keeps its foreman and its first
// MEMBERS_PER_CREW other agents, in order of first appearance. That is at most 12 x 8 = 96 agents, and every crew
// has more than 6, so each card shows "Show n more agents". Then, for a live-looking page: the last crew in plan
// order is running, the one before it planned, and every time is moved so the newest is one minute before the
// fixture anchor 2026-11-02T12:00:00.000Z (ui/e2e/harness.ts FIXTURE_ANCHOR).
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createReducer } from '../../server/state/reduce.ts'
import type { Plan } from '../../server/state/reduce.ts'

const here = import.meta.dirname
const REAL = process.argv[2] ?? '/home/abd/Projects/truss/.git/truss/361b2630-4123-451d-98e0-e36681a3c70c'
const OUT = resolve(here, '..', 'fixtures', 'rework', 'real-12', 'state.json')
const AGENTS_DIR = resolve(here, '..', '..', '..', 'plugins', 'truss', 'agents')
const CREWS = 12
const MEMBERS_PER_CREW = 7
const ANCHOR = Date.parse('2026-11-02T12:00:00.000Z')

type Ev = Record<string, any>
const events: Ev[] = readFileSync(join(REAL, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const realPlan = JSON.parse(readFileSync(join(REAL, 'plan.json'), 'utf8'))

// ---- the trim --------------------------------------------------------------------------------------------------

const agentsOf = new Map<string, string[]>() // crew -> agents in order of first appearance
for (const e of events) {
  if (typeof e.crew !== 'string' || typeof e.agent !== 'string' || e.crew === 'main') continue
  const list = agentsOf.get(e.crew) ?? []
  if (!list.includes(e.agent)) list.push(e.agent)
  agentsOf.set(e.crew, list)
}
const planned: any[] = realPlan.crews
const rank = planned
  .map((c, i) => ({ slug: c.slug as string, i, n: agentsOf.get(c.slug)?.length ?? 0 }))
  .filter((c) => c.n > MEMBERS_PER_CREW)
  .sort((a, b) => b.n - a.n || a.i - b.i)
  .slice(0, CREWS)
const keepCrews = new Set(rank.map((c) => c.slug))
if (keepCrews.size !== CREWS) throw new Error(`only ${keepCrews.size} crews have more than ${MEMBERS_PER_CREW} agents`)
const keepAgents = new Map<string, Set<string>>()
for (const slug of keepCrews) {
  const list = agentsOf.get(slug)!
  const rest = list.filter((a) => a !== slug).slice(0, MEMBERS_PER_CREW)
  keepAgents.set(slug, new Set([...(list.includes(slug) ? [slug] : []), ...rest]))
}
const kept = events.filter((e) => keepCrews.has(e.crew) && keepAgents.get(e.crew)!.has(e.agent))
const maxTs = Math.max(...kept.map((e) => Date.parse(e.ts)))
const shift = ANCHOR - 60_000 - maxTs
const move = (iso: string | null): string | null => (iso === null ? null : new Date(Date.parse(iso) + shift).toISOString())

// ---- the fold, through the server reducer ----------------------------------------------------------------------

const crewsInPlan = planned.filter((c) => keepCrews.has(c.slug))
const plan: Plan = {
  goal: realPlan.goal, version: realPlan.version, approval: realPlan.approval, approvedAt: move(realPlan.approvedAt), goals: [],
  crews: crewsInPlan.map((c, i) => ({
    slug: c.slug, stage: c.stage ?? null, verdict: c.verdict ?? null,
    status: i === crewsInPlan.length - 1 ? 'running' : i === crewsInPlan.length - 2 ? 'planned' : c.status,
    goal: null, owns: c.owns ?? [], estAgents: c.estAgents ?? null,
  })),
}
const reducer = createReducer()
const planStatus = new Map(plan.crews.map((c) => [c.slug, c.status]))
for (const e of kept) {
  // a planned crew has no events yet
  if (planStatus.get(e.crew) === 'planned') continue
  reducer.event({ ...e, ts: move(e.ts) })
}
const run = reducer.build(plan, () => null)

// ---- ADR-0028 section 6: agentId and purpose -------------------------------------------------------------------

const idOf = new Map<string, string | null>() // "<crew>\0<agent>" -> the latest spawn line's agentId
for (const e of kept) if (e.event === 'spawn') idOf.set(`${e.crew}\0${e.agent}`, typeof e.agentId === 'string' ? e.agentId : null)
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
const decorate = (m: any, crew: string, isForeman: boolean): any => ({
  ...m, agentId: idOf.get(`${crew}\0${m.name}`) ?? null, purpose: purposeOf(m.type, isForeman), task: null,
})
for (const c of run.crews as any[]) {
  if (c.foreman) c.foreman = decorate(c.foreman, c.slug, true)
  c.members = c.members.map((m: any) => decorate(m, c.slug, false))
}

// ---- the state --------------------------------------------------------------------------------------------------

const agents = (run.crews as any[]).reduce((n, c) => n + (c.foreman ? 1 : 0) + c.members.length, 0)
if (agents > 100) throw new Error(`${agents} agents, over 100`)
const at = (min: number): string => new Date(ANCHOR - min * 60_000).toISOString()
const state = {
  v: 1,
  repo: '/work/demo',
  trussDir: { path: '/work/demo/.git/truss/real-12', exists: true },
  session: {
    status: 'running', sessionId: 'session-real-12', model: 'claude-opus-5-5', claudeCodeVersion: '3.0.0', permissionMode: 'default',
    plugin: { name: 'truss', version: '0.18.0', path: '/work/demo/plugins/truss', source: null },
    usage: {
      costUsd: 418.62,
      models: {
        'claude-opus-5-5': { inputTokens: 1840233, outputTokens: 912044, cacheReadInputTokens: 61230918, cacheCreationInputTokens: 4418273 },
        'claude-sonnet-5-5': { inputTokens: 922871, outputTokens: 540112, cacheReadInputTokens: 29814550, cacheCreationInputTokens: 2210664 },
      },
      results: 14, at: at(2),
    },
    backgroundTasks: [], error: null, queue: [],
  },
  requests: [],
  transcript: [
    { n: 1, role: 'user', text: String(realPlan.goal), ts: at(240), id: 'msg-1', intent: 'goal' },
    { n: 2, role: 'assistant', text: `The plan has ${plan.crews.length} crews in ${new Set(plan.crews.map((c) => c.stage)).size} stages. The build is under way.`, ts: at(180) },
  ],
  run,
  decisions: [],
  adrs: [],
  design: { planMd: null, architecture: null, images: [] },
  notices: [],
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT,JSON.stringify(state, null, 2) + '\n')
console.log(`real-12: ${run.crews.length} crews, ${agents} agents -> ${OUT}`)
