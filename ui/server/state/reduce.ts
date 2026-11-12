// The reducer of ui-state (ADR-0011 Decision 4, "Reduce"): event and message lines, with the plan and the
// QC verdicts, become the schema's `run` (ui/contract/state.schema.json, $defs/run). It folds lines one by
// one and keeps no line, so its memory depends on the number of agents, not on the size of the logs.
// Node built-ins only; erasable TypeScript.

export type MemberState = 'spawned' | 'stalled' | 'tagged' | 'reported' | 'allowance-spent' | 'fetched'
export type ActivityEvent = 'spawn' | 'stall' | 'tag' | 'report' | 'allowance-spent' | 'fetch' | 'incomplete' | 'message'

export interface Member {
  name: string
  type: string | null
  model: string | null
  effort: string | null
  state: MemberState
  detail: string | null
  ts: string
  agentId: string | null // ADR-0028 section 6: the spawn line's agentId
  purpose: string | null // set by the store from the agent files
  task: string | null // set by the store from the session's task descriptions
  activity?: string | null // set by the store from the agent's transcript tail
}
export interface Activity {
  ts: string
  agent: string
  event: ActivityEvent
  text: string
}
export interface Qc {
  verdict: 'PASS' | 'FAIL' | null
  file: string
}
export interface Crew {
  slug: string
  stage: number | null
  verdict: string | null
  status: 'planned' | 'running' | 'merged' | 'dropped' | null
  goal: string | null
  owns: string[]
  projectManager: Member | null
  members: Member[]
  latest: Activity | null
  estAgents: number | null // ADR-0023 gap f
  stuck: Stuck | null // ADR-0023 gap g
  qc: Qc | null
}
export interface Stuck {
  kind: 'stalled' | 'idle-project-manager'
  since: string
  minutes: number
  detail: string
}
export interface Goal {
  id: string
  goal: string | null
  approval: 'auto' | 'client' | null
  approvedAt: string | null
}
export interface Skipped {
  file: string
  line: number
  reason: 'json' | 'version'
}
export interface Run {
  goal: string | null
  version: number | null
  approval: 'auto' | 'client' | null
  approvedAt: string | null
  crews: Crew[]
  goals: Goal[] // ADR-0023 gap d
  skipped: Skipped[]
}
export interface PlanCrew {
  slug: string
  stage: number | null
  verdict: string | null
  status: Crew['status']
  goal: string | null
  owns: string[]
  estAgents: number | null
}
export interface Plan {
  goal: string | null
  version: number | null
  approval: Run['approval']
  approvedAt: string | null
  crews: PlanCrew[]
  goals: Goal[] // plan.json's goals entries, in file order (the run goal is not among them)
}

const SKIPPED_MAX = 100
const EVENTS = new Set(['spawn', 'stall', 'tag', 'report', 'allowance-spent', 'fetch', 'incomplete'])

interface Stamped extends Activity {
  seq: number // read order, to break a tie on ts
}
interface CrewAcc {
  slug: string
  projectManager: Member | null
  members: Map<string, Member>
  latest: Stamped | null
  lastOf: Map<string, Stamped> // each agent's newest event line in this crew
  stall: StallAcc | null // the crew's newest stall event of a known kind
}

// A successor project manager of crew <slug> is <slug>-<n> with n an integer >= 2 (architecture.md); <slug>-1 is not one.
// Returns the slug a name succeeds, or null when the name is no successor project manager.
function successorBase(name: string): string | null {
  const m = /^(.+)-([1-9][0-9]*)$/.exec(name)
  return m !== null && Number(m[2]) >= 2 ? m[1] : null
}
// `name` is a successor project manager of crew `slug` when it is <slug>-<n> and not itself a plan crew: a plan crew
// phase-2 next to phase is a crew in its own right, so its lines never clear phase's stall.
function follows(name: string, slug: string, planned: { has(slug: string): boolean }): boolean {
  return !planned.has(name) && successorBase(name) === slug
}
interface StallAcc {
  act: Stamped // the stall line's own stamp, compared against lastOf to see if the agent spoke since
  kind: Stuck['kind']
  minutes: number
}
interface Pair {
  ts: string
  from: string
  to: string
  summary: string
  seq: number
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function timeOf(ts: string): number {
  const t = Date.parse(ts)
  return Number.isNaN(t) ? -Infinity : t
}

// true when `a` is newer than `b`, or ties it and was read later
function newerOrEqual(a: Stamped, b: Stamped | null): boolean {
  if (b === null) return true
  const ta = timeOf(a.ts)
  const tb = timeOf(b.ts)
  if (ta !== tb) return ta > tb
  return a.seq >= b.seq
}

export interface Reducer {
  event(obj: Record<string, unknown>): 'version' | undefined
  message(obj: Record<string, unknown>): 'version' | undefined
  skip(file: string, line: number, reason: 'json' | 'version'): void
  build(plan: Plan | null, qcFor: (slug: string) => Qc | null): Run
  spawnedBy(agentId: string): string | null // the spawn line's `by` for an agentId; internal to ui-state
  titleOf(label: string): string | null // the card title a `title` event recorded for a workflow label; internal to ui-state
}

export function createReducer(): Reducer {
  const crews = new Map<string, CrewAcc>() // event-named crews, in order of first appearance
  const agentCrew = new Map<string, string>() // agent name -> the first crew whose event lines name it
  const pairs = new Map<string, Pair>() // the newest message of each (from, to) pair
  const skipped: Skipped[] = []
  // successor-shaped name <b>-<n> -> its newest event line (under crew <b>-<n> or crew b). The hook logs a successor
  // project manager's lines under its own crew <b>-<n> (plugins/truss/hooks/register.ts crewOf), so this is kept outside
  // the crew accumulators; a crew's stall reads the names that follow it (see follows) once the plan is known.
  const successorLatest = new Map<string, Stamped>()
  const spawnBy = new Map<string, string | null>() // agentId -> the spawn line's `by`; read by the store, not published
  const titles = new Map<string, string>() // workflow label -> card title from a `title` event; read by the store, not published
  let seq = 0

  function crewOf(slug: string): CrewAcc {
    let c = crews.get(slug)
    if (c === undefined) {
      c = { slug, projectManager: null, members: new Map(), latest: null, lastOf: new Map(), stall: null }
      crews.set(slug, c)
    }
    return c
  }

  function event(obj: Record<string, unknown>): 'version' | undefined {
    if (obj.v !== 1) return 'version'
    const kind = str(obj.event)
    const slug = str(obj.crew)
    const agent = str(obj.agent)
    const ts = str(obj.ts)
    if (kind === 'title') {
      const label = str(obj.label)
      const title = str(obj.title)
      if (label !== null && title !== null && title.trim() !== '') titles.set(label, title.trim())
      return undefined
    }
    if (kind === null || !EVENTS.has(kind) || slug === null || slug === '' || agent === null || agent === '' || ts === null) return undefined
    if (slug === 'main') return undefined // crew main is never a crew
    if (kind === 'stall' && obj.kind !== 'agent' && obj.kind !== 'idle-project-manager') return undefined // an unknown stall kind is ignored
    const acc = crewOf(slug)
    if (!agentCrew.has(agent)) agentCrew.set(agent, slug)
    let text: string
    let ev: ActivityEvent
    if (kind === 'incomplete') {
      ev = 'incomplete'
      text = `workflow run ${str(obj.run) ?? ''} incomplete`
    } else {
      const isProjectManager = agent === slug
      let m = isProjectManager ? acc.projectManager : (acc.members.get(agent) ?? null)
      if (m === null) {
        m = { name: agent, type: null, model: null, effort: null, state: 'spawned', detail: null, ts, agentId: null, purpose: null, task: null }
        if (isProjectManager) acc.projectManager = m
        else acc.members.set(agent, m)
      }
      m.ts = ts
      if (kind === 'spawn') {
        ev = 'spawn'
        m.type = str(obj.type)
        m.model = str(obj.model)
        m.effort = str(obj.effort)
        m.agentId = str(obj.agentId)
        if (m.agentId !== null) spawnBy.set(m.agentId, str(obj.by)) // internal: never on Member (ADR-0029)
        m.state = 'spawned'
        m.detail = null
        text = `${agent} spawned`
      } else if (kind === 'stall') {
        ev = 'stall'
        const minutes = typeof obj.minutes === 'number' ? obj.minutes : 0
        m.state = 'stalled'
        m.detail = `${minutes} min`
        text = `${agent} stalled ${minutes} min`
      } else if (kind === 'tag') {
        ev = 'tag'
        const tag = str(obj.tag) ?? ''
        m.state = 'tagged'
        m.detail = tag
        text = `${agent} sent ${tag}`
      } else if (kind === 'report') {
        ev = 'report'
        const marker = str(obj.marker)
        m.state = 'reported'
        m.detail = marker
        text = marker === null ? `${agent} reported` : `${agent} reported ${marker}`
      } else if (kind === 'allowance-spent') {
        ev = 'allowance-spent'
        m.state = 'allowance-spent'
        m.detail = null
        text = `${agent} spent the rework allowance`
      } else {
        ev = 'fetch'
        const what = str(obj.url) ?? str(obj.query)
        m.state = 'fetched'
        m.detail = what
        text = `${agent} fetched ${what ?? ''}`
      }
    }
    const act: Stamped = { ts, agent, event: ev, text, seq: ++seq }
    if (newerOrEqual(act, acc.latest)) acc.latest = act
    if (newerOrEqual(act, acc.lastOf.get(agent) ?? null)) acc.lastOf.set(agent, act)
    // A line of successor project manager <b>-<n> counts for crew b: its own line (agent <b>-<n>) or a spawn by it, logged
    // under crew <b>-<n> (the hook's shape) or under crew b.
    const by = kind === 'spawn' ? str(obj.by) : null
    for (const name of by !== null && by !== agent ? [agent, by] : [agent]) {
      const base = successorBase(name)
      if (base === null || (slug !== name && slug !== base)) continue
      if (newerOrEqual(act, successorLatest.get(name) ?? null)) successorLatest.set(name, act)
    }
    // A spawn also counts as a later event of its `by` agent when that agent is of this crew (its project manager or a
    // member), so a stall clears once the stalled agent spawns someone. main, factory and workflow:* credit no one.
    if (by !== null && by !== agent && by !== 'main' && by !== 'factory' && !by.startsWith('workflow:') && (by === slug || acc.members.has(by))) {
      if (newerOrEqual(act, acc.lastOf.get(by) ?? null)) acc.lastOf.set(by, act)
    }
    if (kind === 'stall' && (obj.kind === 'agent' || obj.kind === 'idle-project-manager') && timeOf(ts) !== -Infinity) {
      const s: StallAcc = { act, kind: obj.kind === 'agent' ? 'stalled' : 'idle-project-manager', minutes: typeof obj.minutes === 'number' && obj.minutes >= 0 ? obj.minutes : 0 }
      if (acc.stall === null || newerOrEqual(act, acc.stall.act)) acc.stall = s
    }
    return undefined
  }

  function message(obj: Record<string, unknown>): 'version' | undefined {
    if ('v' in obj && obj.v !== 1) return 'version'
    const from = str(obj.from)
    const to = str(obj.to)
    const ts = str(obj.ts)
    if (ts === null || (from === null && to === null)) return undefined
    const f = from ?? ''
    const t = to ?? ''
    const p: Pair = { ts, from: f, to: t, summary: str(obj.summary) ?? '', seq: ++seq }
    const key = `${f}\u0000${t}`
    const old = pairs.get(key)
    // the newest of the pair by ts, the later read on a tie: only that one can be a crew's latest activity
    if (old === undefined || newerOrEqual({ ...p, agent: f, event: 'message', text: '' }, { ...old, agent: f, event: 'message', text: '' })) pairs.set(key, p)
    return undefined
  }

  function skip(file: string, line: number, reason: 'json' | 'version'): void {
    if (skipped.length < SKIPPED_MAX) skipped.push({ file, line, reason })
  }

  // The crew's newest stall, while the crew is running and the stalled agent has no later event line.
  function stuckOf(acc: CrewAcc | undefined, status: Crew['status'], planned: { has(slug: string): boolean }): Stuck | null {
    if (acc === undefined || acc.stall === null || status !== 'running') return null
    const s = acc.stall
    if (acc.lastOf.get(s.act.agent) !== s.act) return null
    // An idle-project-manager stall also clears on a later line of a successor project manager; a kind agent stall does not.
    if (s.kind === 'idle-project-manager') {
      for (const [name, succ] of successorLatest) {
        if (succ !== s.act && follows(name, acc.slug, planned) && newerOrEqual(succ, s.act)) return null
      }
    }
    return {
      kind: s.kind,
      since: new Date(timeOf(s.act.ts) - s.minutes * 60_000).toISOString(),
      minutes: s.minutes,
      detail: `${s.act.agent} stalled ${s.minutes} min`,
    }
  }

  function build(plan: Plan | null, qcFor: (slug: string) => Qc | null): Run {
    const planned = new Map<string, PlanCrew>()
    for (const c of plan?.crews ?? []) if (c.slug !== 'main' && !planned.has(c.slug)) planned.set(c.slug, c)
    const order = [...planned.keys()]
    for (const slug of crews.keys()) if (!planned.has(slug)) order.push(slug)

    // A message line belongs to the crew of its from agent, else of its to agent, as the event lines name them.
    // A crew's own slug names its project manager, so a plan crew's slug counts too.
    const resolve = (name: string): string | undefined => agentCrew.get(name) ?? (planned.has(name) ? name : undefined)
    const messageLatest = new Map<string, Stamped>()
    for (const p of pairs.values()) {
      const slug = (p.from !== '' ? resolve(p.from) : undefined) ?? (p.to !== '' ? resolve(p.to) : undefined)
      if (slug === undefined) continue
      const act: Stamped = { ts: p.ts, agent: p.from, event: 'message', text: `${p.from} to ${p.to}: ${p.summary}`, seq: p.seq }
      if (newerOrEqual(act, messageLatest.get(slug) ?? null)) messageLatest.set(slug, act)
    }

    const out: Crew[] = order.map((slug) => {
      const pc = planned.get(slug)
      const acc = crews.get(slug)
      let latest: Stamped | null = acc?.latest ?? null
      const ml = messageLatest.get(slug)
      if (ml !== undefined && newerOrEqual(ml, latest)) latest = ml
      return {
        slug,
        stage: pc?.stage ?? null,
        verdict: pc?.verdict ?? null,
        status: pc?.status ?? null,
        goal: pc?.goal ?? null,
        owns: pc === undefined ? [] : [...pc.owns],
        projectManager: acc?.projectManager === null || acc === undefined ? null : { ...acc.projectManager },
        members: acc === undefined ? [] : [...acc.members.values()].map((m) => ({ ...m })),
        latest: latest === null ? null : { ts: latest.ts, agent: latest.agent, event: latest.event, text: latest.text },
        estAgents: pc?.estAgents ?? null,
        stuck: stuckOf(acc, pc?.status ?? null, planned),
        qc: qcFor(slug),
      }
    })
    return {
      goal: plan?.goal ?? null,
      version: plan?.version ?? null,
      approval: plan?.approval ?? null,
      approvedAt: plan?.approvedAt ?? null,
      crews: out,
      // the run's first goal as id run, then plan.json's goals entries in file order; [] with no readable plan.json
      goals: plan === null
        ? []
        : [{ id: 'run', goal: plan.goal, approval: plan.approval, approvedAt: plan.approvedAt }, ...plan.goals.map((g) => ({ ...g }))],
      skipped: skipped.map((s) => ({ ...s })),
    }
  }

  return { event, message, skip, build, spawnedBy: (id) => spawnBy.get(id) ?? null, titleOf: (l) => titles.get(l) ?? null }
}
