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
  foreman: Member | null
  members: Member[]
  latest: Activity | null
  qc: Qc | null
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
  skipped: Skipped[]
}
export interface PlanCrew {
  slug: string
  stage: number | null
  verdict: string | null
  status: Crew['status']
  goal: string | null
  owns: string[]
}
export interface Plan {
  goal: string | null
  version: number | null
  approval: Run['approval']
  approvedAt: string | null
  crews: PlanCrew[]
}

const SKIPPED_MAX = 100
const EVENTS = new Set(['spawn', 'stall', 'tag', 'report', 'allowance-spent', 'fetch', 'incomplete'])

interface Stamped extends Activity {
  seq: number // read order, to break a tie on ts
}
interface CrewAcc {
  slug: string
  foreman: Member | null
  members: Map<string, Member>
  latest: Stamped | null
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
}

export function createReducer(): Reducer {
  const crews = new Map<string, CrewAcc>() // event-named crews, in order of first appearance
  const agentCrew = new Map<string, string>() // agent name -> the first crew whose event lines name it
  const pairs = new Map<string, Pair>() // the newest message of each (from, to) pair
  const skipped: Skipped[] = []
  let seq = 0

  function crewOf(slug: string): CrewAcc {
    let c = crews.get(slug)
    if (c === undefined) {
      c = { slug, foreman: null, members: new Map(), latest: null }
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
    if (kind === null || !EVENTS.has(kind) || slug === null || slug === '' || agent === null || agent === '' || ts === null) return undefined
    if (slug === 'main') return undefined // crew main is never a crew
    const acc = crewOf(slug)
    if (!agentCrew.has(agent)) agentCrew.set(agent, slug)
    let text: string
    let ev: ActivityEvent
    if (kind === 'incomplete') {
      ev = 'incomplete'
      text = `workflow run ${str(obj.run) ?? ''} incomplete`
    } else {
      const isForeman = agent === slug
      let m = isForeman ? acc.foreman : (acc.members.get(agent) ?? null)
      if (m === null) {
        m = { name: agent, type: null, model: null, effort: null, state: 'spawned', detail: null, ts }
        if (isForeman) acc.foreman = m
        else acc.members.set(agent, m)
      }
      m.ts = ts
      if (kind === 'spawn') {
        ev = 'spawn'
        m.type = str(obj.type)
        m.model = str(obj.model)
        m.effort = str(obj.effort)
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

  function build(plan: Plan | null, qcFor: (slug: string) => Qc | null): Run {
    const planned = new Map<string, PlanCrew>()
    for (const c of plan?.crews ?? []) if (c.slug !== 'main' && !planned.has(c.slug)) planned.set(c.slug, c)
    const order = [...planned.keys()]
    for (const slug of crews.keys()) if (!planned.has(slug)) order.push(slug)

    // A message line belongs to the crew of its from agent, else of its to agent, as the event lines name them.
    // A crew's own slug names its foreman, so a plan crew's slug counts too.
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
        foreman: acc?.foreman === null || acc === undefined ? null : { ...acc.foreman },
        members: acc === undefined ? [] : [...acc.members.values()].map((m) => ({ ...m })),
        latest: latest === null ? null : { ts: latest.ts, agent: latest.agent, event: latest.event, text: latest.text },
        qc: qcFor(slug),
      }
    })
    return {
      goal: plan?.goal ?? null,
      version: plan?.version ?? null,
      approval: plan?.approval ?? null,
      approvedAt: plan?.approvedAt ?? null,
      crews: out,
      skipped: skipped.map((s) => ({ ...s })),
    }
  }

  return { event, message, skip, build }
}
