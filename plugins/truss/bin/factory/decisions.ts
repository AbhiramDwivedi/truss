// Crew decisions and per-crew state: crew-decision, decision-reply, decision-ack, knowledge-commit, crew-learned,
// decisions. Moved unchanged from bin/factory.ts (0.31.0 item 5). Never imports factory.ts, whose top-level await would make an
// import cycle.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isObj, need, readJson, str, usage } from '../store.ts'
import type { Flags, Obj } from '../store.ts'
import { localTime } from '../../hooks/register.ts'
import { SLUG } from './plan.ts'
import { appendDecisionLine, appendEvent, dirOf, repoOf, run } from './shared.ts'

// ==== crew decisions ====

// A crew's product calls reach the main session as they happen, and the crew never waits. State is one small file per decision
// under <dir>/crew-decisions/: <id>.json (the call), <id>.reply.json (the main session's reply), <id>.consumed (the crew applied the
// reply and said so with decision-ack). Each file is made once with the exclusive flag, so the id counter, the reply hand-over and
// two crews acking at the same time need no lock: a second claimant gets EEXIST and skips. Reading replies marks nothing: a reply
// that a runner garbled on its way back is read again.
const CREW_DECISIONS = (dir: string): string => `${dir}/crew-decisions`
// Per-crew state under <dir>/crews/<slug>/: checkpoint.json (the crew passed its reply checkpoint), knowledge-commit.json
// ({shas}: the crew's knowledge commits), learned.jsonl (one learned item per line) and state.json ({state}: finished or stopped,
// written when the crew's result is read, cleared when the crew starts again).
export const CREW_STATE = (dir: string, slug: string): string => `${dir}/crews/${slug}`
// stopped is not here: a stopped crew can be resumed and still applies replies at its checkpoint.
const CLOSED_CREW = ['finished', 'merged', 'dropped']
export function readQuiet(p: string): any {
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''))
  } catch {
    return undefined
  }
}
export function knowledgeShas(dir: string, slug: string): string[] {
  const v = readQuiet(`${CREW_STATE(dir, slug)}/knowledge-commit.json`)
  return isObj(v) && Array.isArray(v.shas) ? v.shas.filter((s: unknown): s is string => typeof s === 'string') : []
}
// The learned items stored for a crew, oldest first; a line that is not a JSON object is skipped.
export function learnedOf(dir: string, slug: string): Obj[] {
  const p = `${CREW_STATE(dir, slug)}/learned.jsonl`
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').flatMap((l) => {
    try {
      const v = JSON.parse(l)
      return isObj(v) ? [v] : []
    } catch {
      return []
    }
  })
}
export function setCrewState(dir: string, slug: string, state: 'finished' | 'stopped' | null): void {
  const p = `${CREW_STATE(dir, slug)}/state.json`
  try {
    if (state === null) rmSync(p, { force: true })
    else {
      mkdirSync(CREW_STATE(dir, slug), { recursive: true })
      writeFileSync(p, JSON.stringify({ state }) + '\n')
    }
  } catch {
    // a failed write only means decisions still reads the plan's status for this crew
  }
}
// The crew's status for decisions: the plan's status (planned, running, merged, dropped), finished or stopped once its result was
// read, unknown when the plan or the crew is missing.
function crewStatusOf(dir: string, plan: Obj | undefined, slug: string): string {
  const entry = plan === undefined ? undefined : plan.crews.find((x: unknown) => isObj(x) && x.slug === slug)
  const planned = isObj(entry) && typeof entry.status === 'string' ? entry.status : 'unknown'
  if (planned === 'merged' || planned === 'dropped') return planned
  const st = readQuiet(`${CREW_STATE(dir, slug)}/state.json`)
  return isObj(st) && (st.state === 'finished' || st.state === 'stopped') ? st.state : planned
}
const planQuiet = (dir: string): Obj | undefined => {
  const v = readQuiet(`${dir}/plan.json`)
  return isObj(v) && Array.isArray(v.crews) ? v : undefined
}
// The crew has applied (or can no longer apply) the main session's replies: it recorded its checkpoint, or it is closed.
const pastCheckpoint = (dir: string, slug: string, status: string): boolean => existsSync(`${CREW_STATE(dir, slug)}/checkpoint.json`) || CLOSED_CREW.includes(status)
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').replace(/\|/g, '/').trim()
type CrewDecision = { id: string; ts: string; crew: string; task: string; question: string; answer: string; by: string }
type DecisionReply = { id: string; crew: string; reply: 'ack' | 'change'; note: string | null }

function readDecision(dir: string, id: string): CrewDecision {
  const p = `${CREW_DECISIONS(dir)}/${id}.json`
  if (!/^d-[a-z0-9-]+-\d+$/.test(id) || !existsSync(p)) throw usage(`no crew decision ${id} in this run`)
  return readJson(p) as CrewDecision
}
function readReply(dir: string, id: string): DecisionReply | undefined {
  const p = `${CREW_DECISIONS(dir)}/${id}.reply.json`
  return existsSync(p) ? (readJson(p) as DecisionReply) : undefined
}

// factory crew-decision --crew <slug> --task <id> --question <q> --answer <a> --by <who>: the project manager (or a member) records a
// product call it made and went on. Appends the decide line, writes a crew-decision event, prints {id}.
export function cmdCrewDecision(f: Flags): Obj {
  const dir = dirOf(f)
  const crew = need(f, 'crew')
  if (!SLUG.test(crew)) throw usage(`--crew ${crew} is not a crew slug`)
  const v: Record<string, string> = {}
  for (const k of ['task', 'question', 'answer', 'by']) {
    v[k] = oneLine(need(f, k))
    if (v[k] === '') throw usage(`--${k} is empty`)
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw usage(`--dir is not a directory: ${dir}`)
  const cdir = CREW_DECISIONS(dir)
  mkdirSync(cdir, { recursive: true })
  const taken = readdirSync(cdir).filter((n) => new RegExp(`^d-${crew}-\\d+\\.json$`).test(n)).length
  for (let n = taken + 1; n < taken + 10000; n++) {
    const id = `d-${crew}-${n}`
    const rec: CrewDecision = { id, ts: new Date().toISOString(), crew, task: v.task as string, question: v.question as string, answer: v.answer as string, by: v.by as string }
    try {
      writeFileSync(`${cdir}/${id}.json`, JSON.stringify(rec) + '\n', { flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw e
    }
    appendDecisionLine(dir, `- ${localTime(Date.now())} | PO crew ${crew}: ${rec.question} | ${rec.answer} | ${rec.by} | decided`)
    appendEvent(dir, { event: 'crew-decision', id, crew, task: rec.task, question: rec.question, answer: rec.answer, by: rec.by })
    return { id }
  }
  throw usage(`no free decision id for crew ${crew}`)
}

// factory decision-reply <id> ack|change [--note <text>]: the main session answers a crew's call. change needs a note.
export function cmdDecisionReply(f: Flags): Obj {
  const dir = dirOf(f)
  const id = need(f, 'id')
  const verdict = need(f, 'reply')
  if (verdict !== 'ack' && verdict !== 'change') throw usage(`the reply must be ack or change, got ${verdict}`)
  const rawNote = str(f, 'note')
  const note = rawNote === undefined ? null : oneLine(rawNote)
  if (verdict === 'change' && (note === null || note === '')) throw usage('a change reply needs --note: say what the crew should do instead')
  const d = readDecision(dir, id)
  const cdir = CREW_DECISIONS(dir)
  const rec: DecisionReply = { id, crew: d.crew, reply: verdict, note: note === '' ? null : note }
  // the exclusive create makes a second reply (even one at the same moment) a refusal, never an overwrite
  try {
    writeFileSync(`${cdir}/${id}.reply.json`, JSON.stringify(rec) + '\n', { flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw usage(`crew decision ${id} already has a reply`)
    throw e
  }
  appendEvent(dir, { event: 'decision-reply', id, crew: d.crew, reply: verdict, note: rec.note })
  const status = crewStatusOf(dir, planQuiet(dir), d.crew)
  if (!pastCheckpoint(dir, d.crew, status)) return { id, reply: verdict }
  return {
    id, reply: verdict, crewPastCheckpoint: true,
    hint: `crew ${d.crew} is past its reply checkpoint (status ${status}) and will not apply this reply; the crew result lists the call as late, so a change becomes a fix at merge`,
  }
}

// factory decision-replies --crew <slug>: the replies to a crew's calls that it has not acked yet, as [{id, reply, note}]. It marks
// nothing: the crew acks with decision-ack once it has applied them, so a reply lost on the way back is read again.
export function cmdDecisionReplies(f: Flags): Obj {
  const dir = dirOf(f)
  const crew = need(f, 'crew')
  const cdir = CREW_DECISIONS(dir)
  const out: { id: string; reply: string; note: string | null }[] = []
  const names = existsSync(cdir) ? readdirSync(cdir).filter((n) => n.endsWith('.reply.json')).sort(byDecisionId) : []
  for (const n of names) {
    const r = readJson(`${cdir}/${n}`) as DecisionReply
    if (r.crew !== crew || existsSync(`${cdir}/${r.id}.consumed`)) continue
    out.push({ id: r.id, reply: r.reply, note: r.note })
  }
  return out as unknown as Obj
}

// factory decision-ack --crew <slug> --ids <id,id,...>: the crew applied these replies. Each is marked consumed with an exclusive
// create, so two acks of one reply never both count: prints {acked, already}. Every id must be a reply to a call of this crew, or
// nothing is acked.
export function cmdDecisionAck(f: Flags): Obj {
  const dir = dirOf(f)
  const crew = need(f, 'crew')
  const ids = [...new Set(need(f, 'ids').split(',').map((s) => s.trim()).filter((s) => s !== ''))]
  if (ids.length === 0) throw usage('--ids needs at least one decision id')
  const cdir = CREW_DECISIONS(dir)
  for (const id of ids) {
    const d = readDecision(dir, id)
    if (d.crew !== crew) throw usage(`crew decision ${id} belongs to crew ${d.crew}, not ${crew}`)
    if (readReply(dir, id) === undefined) throw usage(`crew decision ${id} has no reply to ack`)
  }
  const acked: string[] = []
  const already: string[] = []
  for (const id of ids) {
    try {
      writeFileSync(`${cdir}/${id}.consumed`, '', { flag: 'wx' })
      acked.push(id)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      already.push(id)
    }
  }
  if (acked.length > 0) appendEvent(dir, { event: 'decision-ack', crew, ids: acked })
  return { acked, already }
}

// factory decision-checkpoint --crew <slug>: the crew passed its reply checkpoint (it applied the replies it had, or made no call).
// A reply that comes later is not applied by the crew; decision-reply and decisions --open say so. Safe to call again.
export function cmdDecisionCheckpoint(f: Flags): Obj {
  const dir = dirOf(f)
  const crew = need(f, 'crew')
  if (!SLUG.test(crew)) throw usage(`--crew ${crew} is not a crew slug`)
  mkdirSync(CREW_STATE(dir, crew), { recursive: true })
  writeFileSync(`${CREW_STATE(dir, crew)}/checkpoint.json`, JSON.stringify({ ts: new Date().toISOString() }) + '\n')
  return { crew, checkpoint: true }
}

// factory knowledge-commit --slug <slug> --sha <sha>: records the commit that holds the crew's knowledge step, the one commit
// owns-check lets change docs outside the crew's owns. Prints {slug, sha} with the full sha. With --base and --head (shas) the sha
// must be a non-merge commit in base..head (git rev-list --no-merges), else it is a usage error and nothing is recorded; the output
// then also carries files (git diff --name-only base head). There is no docs-only answer: markdown can be test input, so green
// always re-runs after the knowledge commit.
export function cmdKnowledgeCommit(f: Flags): Obj {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  if (!SLUG.test(slug)) throw usage(`--slug ${slug} is not a crew slug`)
  const given = need(f, 'sha')
  if (!/^[0-9a-f]{7,64}$/.test(given)) throw usage(`--sha ${given} is not a commit sha`)
  const r = run(repoOf(f), ['rev-parse', '--verify', '-q', `${given}^{commit}`])
  if (r.status !== 0 || r.out === '') throw usage(`--sha ${given} is not a commit of this repo`)
  const sha = r.out
  const base = str(f, 'base')
  const head = str(f, 'head')
  const ranged = base !== undefined && head !== undefined
  if (ranged) {
    for (const [name, v] of [['base', base], ['head', head]]) if (!/^[0-9a-f]{7,64}$/.test(v)) throw usage(`--${name} ${v} is not a commit sha`)
    const l = run(repoOf(f), ['rev-list', '--no-merges', `${base}..${head}`])
    if (l.status !== 0) throw usage(`git rev-list ${base}..${head} failed: ${l.err || l.out}`)
    if (!l.out.split('\n').map((x) => x.trim()).includes(sha)) throw usage(`--sha ${sha} is not a non-merge commit in ${base}..${head}`)
  }
  const shas = knowledgeShas(dir, slug)
  if (!shas.includes(sha)) {
    mkdirSync(CREW_STATE(dir, slug), { recursive: true })
    writeFileSync(`${CREW_STATE(dir, slug)}/knowledge-commit.json`, JSON.stringify({ shas: [...shas, sha] }) + '\n')
    appendEvent(dir, { event: 'knowledge-commit', crew: slug, sha })
  }
  if (!ranged) return { slug, sha }
  const d = run(repoOf(f), ['-c', 'core.quotepath=off', 'diff', '--name-only', base as string, head as string])
  if (d.status !== 0) throw usage(`git diff ${base} ${head} failed: ${d.err || d.out}`)
  const files = d.out.split('\n').map((l) => l.trim()).filter(Boolean)
  return { slug, sha, files }
}

// factory crew-learned --slug <slug> --add=<json array>: appends the learned items of one member report to the crew's list. The list
// survives a restart of the crew's run: start --resume hands it back as learned, and the knowledge step reads it. Prints
// {slug, added, total}.
export function cmdCrewLearned(f: Flags): Obj {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  if (!SLUG.test(slug)) throw usage(`--slug ${slug} is not a crew slug`)
  let items: unknown
  try {
    items = JSON.parse(need(f, 'add'))
  } catch {
    throw usage('--add is not JSON')
  }
  if (!Array.isArray(items) || items.length === 0) throw usage('--add must be a JSON array of at least one learned item')
  for (const i of items) {
    if (!isObj(i) || typeof i.kind !== 'string' || i.kind.trim() === '' || typeof i.text !== 'string' || i.text.trim() === '') throw usage('every learned item needs a kind and a text')
  }
  mkdirSync(CREW_STATE(dir, slug), { recursive: true })
  appendFileSync(`${CREW_STATE(dir, slug)}/learned.jsonl`, items.map((i) => JSON.stringify(i) + '\n').join(''))
  return { slug, added: items.length, total: learnedOf(dir, slug).length }
}
// d-<crew>-<n> in the order they were made: by crew, then n as a number.
function byDecisionId(a: string, b: string): number {
  const split = (s: string): [string, number] => {
    const m = /^d-(.*)-(\d+)\./.exec(s)
    return [m?.[1] ?? s, Number(m?.[2] ?? 0)]
  }
  const [ca, na] = split(a)
  const [cb, nb] = split(b)
  return ca < cb ? -1 : ca > cb ? 1 : na - nb
}

// factory decisions [--open] [--crew <slug>]: the run's crew decisions in the order they were made, each with its reply status and
// its crew's status (crewStatus); --open keeps the ones with no reply yet whose crew can still apply one, so a crew past its
// checkpoint or a finished crew goes quiet. One read of a small directory, cheap to poll.
export function cmdDecisions(f: Flags): Obj {
  const dir = dirOf(f)
  const cdir = CREW_DECISIONS(dir)
  const only = str(f, 'crew')
  const files = existsSync(cdir) ? readdirSync(cdir).filter((n) => /^d-.*-\d+\.json$/.test(n)) : []
  const plan = planQuiet(dir)
  const status = new Map<string, string>()
  const statusOf = (crew: string): string => status.get(crew) ?? (status.set(crew, crewStatusOf(dir, plan, crew)), status.get(crew) as string)
  const list = files.map((n) => {
    const d = readJson(`${cdir}/${n}`) as CrewDecision
    const r = readReply(dir, d.id)
    return { ...d, reply: r?.reply ?? null, note: r?.note ?? null, consumed: existsSync(`${cdir}/${d.id}.consumed`), crewStatus: statusOf(d.crew) }
  }).filter((d) => (only === undefined || d.crew === only) && (f.open !== true || (d.reply === null && !pastCheckpoint(dir, d.crew, d.crewStatus))))
  list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : byDecisionId(`${a.id}.`, `${b.id}.`)))
  // review 3: with --crew, whether the crew already passed its reply checkpoint, so a resume applies no reply it was told is late
  if (only !== undefined) return { decisions: list, checkpoint: SLUG.test(only) && existsSync(`${CREW_STATE(dir, only)}/checkpoint.json`) }
  return { decisions: list }
}
