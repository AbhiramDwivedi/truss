// @ts-nocheck
// Helpers for the 'e2e 025:' cases of tests/ltc-guard.check.ts (contract-025 sections 4, 6 and 7): a world whose temp git repo has a bare
// `origin`, a test-only price table written into the temp repo's config at test time (no price is committed), the budget crew's synthetic
// transcript from fixtures/cost/ (read only), and the PM's end-of-run flow of /truss:run --next driven through real factory processes.
// Node built-ins only; every temp dir is realpath-ed and removed at exit; no shell is run.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crew, git, planObj, putFile, writeGoal } from '../workflow-run/harness.ts'
import { CHEAP, cli, mk, mkWorld, planWrite, say } from './harness.ts'
import type { World } from './harness.ts'

const COST_FIX = fileURLToPath(new URL('../cost/', import.meta.url)).replace(/\\/g, '/')

/** Synthetic rates, one unit per million tokens: 2M in + 1M out + 2M cache reads of the budget crew come to exactly 5.2. Test values, never a real price. */
export const TEST_PRICING = { 'test-model-budget': { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.6, cacheWrite5mPerMTok: 1, cacheWrite1hPerMTok: 1 } }

export type E2eWorld = World & { origin: string }

/** A world (see mkWorld) with a bare `origin` remote that already holds main; the config gets the test price table. */
export function mkE2eWorld(config: Record<string, unknown> = {}, files: Record<string, string> = {}): E2eWorld {
  const w = mkWorld({ architecture: 'docs/architecture.md', adr: 'docs/adr', pricing: TEST_PRICING, ...config }, files)
  const origin = mk('ltc-origin-')
  git(origin, ['init', '--bare', '-q', '-b', 'main'])
  git(w.repo, ['remote', 'add', 'origin', origin])
  git(w.repo, ['push', '-q', 'origin', 'main'])
  return { ...w, origin }
}

/** The raw `git for-each-ref` output of the bare origin, byte for byte. */
export function originRefs(w: E2eWorld): string {
  const r = spawnSync('git', ['-C', w.origin, 'for-each-ref'], { encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, `git for-each-ref in the origin: ${r.stderr}`)
  return r.stdout
}

/** Lays the budget crew's transcript (and its Agent meta, description bcrew-builder) under the session's transcripts, from the cost fixtures. */
export function layBudgetCrew(w: World): void {
  const base = `${w.troot}/proj-ltc/${w.sid}/subagents/agent-bcrew`
  mkdirSync(path.dirname(base), { recursive: true })
  writeFileSync(`${base}.jsonl`, readFileSync(`${COST_FIX}budget-crew.jsonl`))
  writeFileSync(`${base}.meta.json`, readFileSync(`${COST_FIX}budget-crew.meta.json`))
}

/** Every parsed line of the shared inbox file. */
export const inboxOps = (w: World): any[] => (existsSync(w.inboxFile) ? readFileSync(w.inboxFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

/** The items of one kind, folded by the real `inbox` command. */
export function itemsOf(w: World, kind: string): any[] {
  const r = cli(w, 'inbox', ['--kind', kind])
  assert.equal(r.status, 0, say(r))
  return r.json.items
}

export const ledgerRows = (w: World): any[] => {
  const p = `${w.shared}/ledger.jsonl`
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}
export const eventLines = (w: World): string[] => readFileSync(`${w.dir}/events.jsonl`, 'utf8').split('\n').filter(Boolean)

/** A designer result carrying a one-crew version 4 plan: a solo crew of work type docs that owns src/**, plus a cheap long-term cost line. */
function designerPlan(slug: string): string {
  const plan = planObj([crew(slug, { process: 'solo', workType: 'docs', owns: ['src/**'] })], { version: 4, approval: 'auto', approvedAt: null })
  const body = JSON.stringify(plan, null, 2)
  return `Here is the plan.\n\n${CHEAP}\n\n\`\`\`\`json plan.json\n${body}\n\`\`\`\`\n\n\`\`\`\`markdown plan.md\n# The plan\n\nBody.\n\`\`\`\`\n`
}

export type Flow = { id: string; slug: string; crewHead: string; branches: string[]; branchesBeforeLand: string[]; originBefore: string; originAfter: string; pushPr: any[]; land: any }

/**
 * The PM's side of `/truss:run --next` (contract-025 section 7) through real factory processes. One queue item sits in docs/queue.md. Steps:
 * intake, unattended --on, queue-next, plan-write, plan-check, approve --by auto, start, a crew commit that adds no trigger file, land,
 * escalate --kind push-pr (the title by --title-file), queue-set running then done, unattended --off. Every step asserts its exit code.
 */
export function runUnattendedFlow(w: E2eWorld, slug = 'uploader'): Flow {
  const ok = (r: any, what: string): any => {
    assert.equal(r.status, 0, `${what}: ${say(r)}`)
    return r.json
  }
  const originBefore = originRefs(w)
  const intake = ok(cli(w, 'intake', ['--source', 'md']), 'intake')
  assert.equal(intake.added.length, 1, `one item in docs/queue.md: ${JSON.stringify(intake)}`)
  const id = intake.added[0]
  const queued = ok(cli(w, 'queue', ['--state', 'new']), 'queue --state new')
  assert.deepEqual(queued.items.map((i: any) => i.id), [id])
  ok(cli(w, 'unattended', ['--on']), 'unattended --on')
  const next = ok(cli(w, 'queue-next'), 'queue-next')
  assert.equal(next.item?.id, id, `queue-next claims the item: ${JSON.stringify(next).slice(0, 300)}`)
  // the PM writes the goal and the plan from the brief and the design engineer: nothing of the item's title goes in
  const pw = planWrite(w, 'wf_e2eplan1-aaa', designerPlan(slug))
  ok(pw, 'plan-write')
  assert.equal(pw.json.written, true, say(pw))
  writeGoal(w.dir, slug, { goal: 'Add a retry to the uploader.', scope: 'Add a retry to the uploader only.' })
  ok(cli(w, 'plan-check'), 'plan-check')
  ok(cli(w, 'approve', ['--by', 'auto']), 'approve --by auto')
  const started = ok(cli(w, 'start', ['--slug', slug, '--stage', 'next']), 'start')
  assert.equal(started.direct?.length, 1, `a solo crew starts direct: ${JSON.stringify(started).slice(0, 400)}`)
  const wt = `${w.repo}/.claude/worktrees/truss-${slug}`
  const crewHead = putFile(wt, `src/${slug}/retry.ts`, 'export const retries = 3\n', 'add a retry to the uploader') as string
  const branchesBeforeLand = git(w.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean)
  const land = cli(w, 'land', ['--slug', slug])
  ok(land, 'land')
  assert.equal(land.json.merged, true, say(land))
  const titleFile = `${mk('ltc-title-')}/push-pr.txt`
  writeFileSync(titleFile, 'Push main and open the pull request for the unattended run\n')
  const esc = ok(cli(w, 'escalate', ['--kind', 'push-pr', '--title-file', titleFile, '--ref', `push-pr:${w.sid}`]), 'escalate push-pr')
  assert.equal(esc.deduped, false, JSON.stringify(esc))
  ok(cli(w, 'queue-set', ['--id', id, '--state', 'running']), 'queue-set running')
  ok(cli(w, 'queue-set', ['--id', id, '--state', 'done']), 'queue-set done')
  const off = ok(cli(w, 'unattended', ['--off']), 'unattended --off')
  assert.equal(off.item, id, 'the claimed item id was in unattended.json')
  const branches = git(w.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean)
  return { id, slug, crewHead, branches, branchesBeforeLand, originBefore, originAfter: originRefs(w), pushPr: itemsOf(w, 'push-pr'), land: land.json }
}

/** Every commit message of every ref of the repo (`git log --all --format=%B`), and every ref name (heads, archive, tags). */
export function commitMessages(w: World): string {
  return git(w.repo, ['log', '--all', '--format=%B'])
}
export const refNames = (w: World): string => git(w.repo, ['for-each-ref', '--format=%(refname)'])

/** The text of every file under `dir` whose name ends in one of `exts`, recursively; used to look for a title fragment in the session's records. */
export function textsUnder(dir: string, exts: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`
      if (e.isDirectory()) walk(p)
      else if (exts.some((x) => e.name.endsWith(x))) out[p] = readFileSync(p, 'utf8')
    }
  }
  walk(dir)
  return out
}
