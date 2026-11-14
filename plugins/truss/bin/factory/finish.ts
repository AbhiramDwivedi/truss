// The finish and land commands: the merge gate and merging a crew. Moved unchanged from bin/factory.ts (0.31.0 item 5).
// Never imports factory.ts, whose top-level await would make an import cycle.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { headVerdict, latestQc, NO_HEAD_REASON, NO_PASS_REASON, PATCH_COMMAND, patchIdOf, planAtLeastV2, qcFails, qcRuling, runStart } from '../../hooks/register.ts'
import type { QcRuling } from '../../hooks/register.ts'
import { CliError, configOf, flat, isObj, need, parseLabel, readJson, refuse, str, usage } from '../core.ts'
import type { Flags, Obj } from '../core.ts'
import { refreshLease, releaseLease, takeLease } from '../lock.ts'
import { ltcCrewGate } from '../guard.ts'
import { crewCost } from '../cost.ts'
import { ledgerAppend } from '../ledger.ts'
import { goalOf } from '../../hooks/intake.ts'
import { logPassed, recordEscalations, recordRun, sessionAudit } from './audit.ts'
import type { Audit } from './audit.ts'
import { cmdCheck } from './check.ts'
import { concludeFrontmatterMerge } from '../fragments.ts'
import { cmdOwnsCheck } from './crew.ts'
import { setCrewState } from './decisions.ts'
import { cmdKnowledgeLint, gateGit, knowledgeConfigRefusal } from './knowledge-cmds.ts'
import { retireBranch, retireWorktree, sweepMembers, worktreesOf } from './retire.ts'
import type { RetireCtx, RetireWhy } from './retire.ts'
import { retro } from './retro-mods.ts'
import { countedQc, factorySpawned, isLive, jsonLines, reportsOf, runOf } from './runs.ts'
import { crewWorktree, dirOf, intOr, PLUGIN, repoOf, run } from './cli.ts'
import { loadPlan, patchPlan } from './plan-file.ts'
import { settingsFor } from './settings.ts'
import { appendDecision, appendEvent } from './log.ts'
import { rolesWithTypes } from './roles.ts'

// The merge step's head rule (ADR-0009 step 3), failing closed. headVerdict is fail-open for the stop gate (it passes an undefined head
// or patch, and a plan below v2), so this refuses first when the QC, head or patch is missing, whatever the plan version, and then
// asks headVerdict about a v2 view of the plan. Returns {block} to refuse, undefined when the PASS stands.
export function mergeHeadVerdict(plan: any, qc: QcRuling | undefined, head: string | undefined, patch: string | undefined): { block: string } | undefined {
  if (qc === undefined || qc.verdict !== 'PASS' || qc.unscoped > 0) return { block: NO_PASS_REASON }
  if (qc.head === undefined || qc.patch === undefined) return { block: NO_HEAD_REASON }
  if (head === undefined || patch === undefined) return { block: 'Refused: patch id unavailable: the merged head or its patch id could not be computed.' }
  return headVerdict(planAtLeastV2(plan) ? plan : { ...(isObj(plan) ? plan : {}), version: 2 }, qc, head, patch)
}

// The patch id of base...head by PATCH_COMMAND, or undefined when the diff or patch-id fails or is empty.
function patchOf(wt: string, base: string, head: string): string | undefined {
  const [diffCmd, idCmd] = PATCH_COMMAND.split(' | ').map((s) => s.replace('<base>', base).replace('<head>', head).split(' '))
  if (diffCmd === undefined || idCmd === undefined) return undefined
  const d = spawnSync(diffCmd[0] as string, diffCmd.slice(1), { cwd: wt, encoding: 'utf8', maxBuffer: 1 << 29 })
  if (d.error || d.status !== 0) return undefined
  const p = spawnSync(idCmd[0] as string, idCmd.slice(1), { cwd: wt, input: d.stdout, encoding: 'utf8', maxBuffer: 1 << 26 })
  if (p.error || p.status !== 0) return undefined
  return patchIdOf(p.stdout)
}

// The lowest-numbered D/checks/<slug>-<n>.json that has no `env` key: the red record. A run that failed on the environment
// proves nothing about the code, so it is passed over. undefined when none.
export function redRecord(dir: string, slug: string): Obj | undefined {
  const d = `${dir}/checks`
  if (!existsSync(d)) return undefined
  const re = new RegExp(`^${slug.replace(/[^a-z0-9-]/g, '\\$&')}-(\\d+)\\.json$`)
  const found = readdirSync(d).flatMap((n) => {
    const m = re.exec(n)
    return m?.[1] === undefined ? [] : [{ n: Number(m[1]), name: n }]
  }).sort((x, y) => x.n - y.n)
  for (const f of found) {
    let v
    try {
      v = JSON.parse(readFileSync(`${d}/${f.name}`, 'utf8'))
    } catch {
      return undefined
    }
    if (!isObj(v)) return undefined
    if (v.env === undefined) return v
  }
  return undefined
}

type Outcome ={ merged?: true; left?: { path: string; branch: string; why: string }[]; rework?: string; blocked?: string; refused?: string; lint?: Obj[] }

// 0.32.0 bug F: the knowledge-lint failures that block a merge. A failure counts as new unless it says `new: false`, as stage.js
// `isNewFinding` counts it; predating failures and warnings never block.
function newLintFailures(failures: unknown): Obj[] {
  return Array.isArray(failures) ? failures.filter((x): x is Obj => isObj(x) && x.new !== false) : []
}
/** A passed Workflow result's new knowledge-lint failures; none when it has no `knowledgeLint` or the lint did not run. */
function resultLintFailures(res: Obj): Obj[] {
  const l = res.knowledgeLint
  return isObj(l) && l.ran === true ? newLintFailures(l.failures) : []
}
const lintWhy = (fresh: Obj[]): string => `knowledge-lint: ${fresh.length} new failure${fresh.length === 1 ? '' : 's'}: ${fresh.map((x) => `[${String(x.check)}] ${String(x.path)}: ${String(x.message)}`).join('; ')}`

// Merge step for one crew whose newest QC is a clean PASS (ADR-0009 steps 1 to 5). Fails closed: any doubt is a refusal.
// `gates` (ADR-0031 land) switches the red and QC gates by the crew's booleans; absent, both are on (finish, a full crew).
// `runId` names the run in the retire event of the crew's own branch (land has none: 'land').
function mergeCrew(f: Flags, dir: string, repo: string, target: string, crew: Obj, ruling: QcRuling | undefined, audits: Audit[], fails: number, gates?: { process: string; qc: boolean; red: boolean }, runId = 'land', leaseToken?: string): Outcome {
  const needRed = gates?.red ?? true
  const needQc = gates?.qc ?? true
  const slug: string = crew.slug
  const wt = crewWorktree(repo, slug)
  const plan = loadPlan(dir)
  // step 1: gates
  const named = audits.filter((a) => a.slug === slug)
  if (named.length > 0) return { refused: `audit: ${named.map((a) => `${a.label} (${a.why})`).join('; ')}` }
  if (!existsSync(wt)) return { refused: `no crew worktree at ${wt}` }
  try {
    cmdOwnsCheck({ ...f, dir, repo, slug })
  } catch (e) {
    return { refused: e instanceof CliError && Array.isArray(e.body.outside) ? `owns-check: outside ${(e.body.outside as string[]).join(', ')}` : `owns-check failed: ${(e as Error).message}` }
  }
  // the gate reads refs/heads/<target> throughout and fails closed: a remote-tracking name such as origin/main is refused up front, with the fix
  if (run(repo, ['rev-parse', '--verify', '-q', `refs/heads/${target}^{commit}`]).status !== 0) return { refused: `target ${target} is not a local branch (refs/heads/${target} does not resolve); set \`target\` in .claude/truss.json to a local branch (\`git branch --list\` names them), or make one from it with \`git branch <local-name> ${target}\` and set \`target\` to <local-name>` }
  // contract-025 section 3 (finding #22): every crew, solo and qc:false included, passes the long-term cost gate; its QC text is the newest QC file, if any
  const since = runStart(plan) ?? 0
  const qcFiles = reportsOf(dir, slug).map((r) => (/^qc(-\d+)?\.md$/.test(r.name) ? { ...r, name: `${slug}-${r.name}` } : r))
  // a base or head that does not resolve would hand the gate '' and no triggers: refuse instead
  const ltcBase = gateGit(wt, ['merge-base', `refs/heads/${target}`, `refs/heads/truss-${slug}`])
  if (ltcBase.status !== 0 || ltcBase.out === '') return { refused: `long-term cost gate: git merge-base refs/heads/${target} refs/heads/truss-${slug} failed${ltcBase.err === '' ? '' : `: ${ltcBase.err.split('\n')[0]}`}` }
  const ltcHead = gateGit(wt, ['rev-parse', '--verify', `refs/heads/truss-${slug}`])
  if (ltcHead.status !== 0 || ltcHead.out === '') return { refused: `long-term cost gate: git rev-parse refs/heads/truss-${slug} failed${ltcHead.err === '' ? '' : `: ${ltcHead.err.split('\n')[0]}`}` }
  // ADR-0035: from the commits alone, before anything else can open a client item or touch a branch
  const cfgRefusal = knowledgeConfigRefusal(wt, ltcBase.out, ltcHead.out)
  if (cfgRefusal !== undefined) return { refused: cfgRefusal }
  const gate = ltcCrewGate(repo, dir, slug, { qcText: latestQc(slug, qcFiles, since)?.text ?? null, base: ltcBase.out, head: ltcHead.out })
  if (gate.refused !== undefined) return { refused: gate.refused }
  const allowance = intOr(plan.reworkAllowance, 2, 0)
  if (fails > allowance) return { refused: `rework allowance spent: ${fails} QC FAILs, allowance ${allowance}` }
  const red = needRed ? redRecord(dir, slug) : undefined
  if (needRed && (red === undefined || !Number.isInteger(red.exit) || red.exit === 0)) return { refused: 'no red record: the lowest-numbered checks file is missing or has exit 0' }
  if (run(wt, ['rev-parse', `refs/heads/truss-${slug}`]).out !== run(wt, ['rev-parse', 'HEAD']).out) return { refused: `the crew worktree is not on branch truss-${slug}` }
  // 0.32.0 bug F: a direct crew (land) has no Workflow result, so land runs the knowledge lint on the crew worktree itself, against
  // the fork point, and refuses on a new failure. A lint that cannot run (a usage error) does not block, as a result with ran false.
  if (gates !== undefined) {
    let fresh: Obj[] = []
    try {
      fresh = newLintFailures(cmdKnowledgeLint({ repo, dir, slug }).failures)
    } catch (e) {
      if (!(e instanceof CliError)) throw e
    }
    if (fresh.length > 0) return { refused: lintWhy(fresh), lint: fresh }
  }
  // step 2: resolve the target once, fully qualified (a same-named tag must not win), and merge that commit in, never a rebase
  const targetRef = `refs/heads/${target}`
  const resolved = run(repo, ['rev-parse', '--verify', `${targetRef}^{commit}`])
  if (resolved.status !== 0 || resolved.out === '') return { refused: `target branch ${target} does not resolve` }
  const oldSha = resolved.out
  const m = run(wt, ['merge', '--no-edit', oldSha])
  // 0.31.0 item 4 (architecture.md, "Doc fragments"): a conflict confined to YAML frontmatter resolves itself; any other conflict is the crew's rework
  if (m.status !== 0 && !concludeFrontmatterMerge(wt).concluded) {
    const conflict = run(wt, ['diff', '--name-only', '--diff-filter=U']).out !== ''
    run(wt, ['merge', '--abort'])
    return conflict ? { rework: 'conflict' } : { refused: `git merge ${target} failed: ${m.err || m.out}` }
  }
  // step 3: the patch is always computed on the merged head, against the target head just merged in
  const head = run(wt, ['rev-parse', 'HEAD']).out
  const base = run(wt, ['merge-base', oldSha, 'HEAD']).out
  // ADR-0035: what lands must not loosen the target, whatever each side looked like alone
  const landing = knowledgeConfigRefusal(wt, oldSha, head)
  if (landing !== undefined) return { refused: landing }
  const patch = !needQc || head === '' || base === '' ? undefined : patchOf(wt, base, head)
  if (needQc && (ruling === undefined || ruling.head === undefined || ruling.patch === undefined || head === '' || patch === undefined)) return { refused: 'patch id unavailable' }
  if (needQc && mergeHeadVerdict(plan, ruling, head, patch) !== undefined) return { rework: 'reqc' }
  if (needRed || (needQc && head !== ruling?.head)) {
    try {
      cmdCheck({ dir, slug, cwd: wt, expect: 'green' })
    } catch {
      return { rework: 'reqc' }
    }
  }
  // R-89: the acceptance test above can outlast LEASE_STALE_MS, and a blocked thread refreshes nothing, so a second finisher may have
  // taken the lease and merged. A finisher that no longer holds its lease never moves the target.
  if (leaseToken !== undefined && !refreshLease(dir, `finisher-${slug}`, leaseToken)) return { refused: 'finisher lease lost' }
  // step 4: fast-forward the target
  const onTarget = worktreesOf(repo).find((w) => w.branch === target)
  if (onTarget !== undefined) {
    const dirty = run(onTarget.path, ['status', '--porcelain', '--untracked-files=no']).out
    if (dirty !== '') return { blocked: `target checked out dirty: ${dirty.split('\n')[0]?.trim().replace(/^\S+\s+/, '')}` }
    if (run(onTarget.path, ['rev-parse', 'HEAD']).out !== oldSha) return { rework: 'target moved' }
    if (run(onTarget.path, ['merge', '--ff-only', head]).status !== 0) return { rework: 'target moved' }
  } else if (run(repo, ['update-ref', targetRef, head, oldSha]).status !== 0) return { rework: 'target moved' }
  // step 5: record, then clean up
  const fresh = patchPlan(dir, (fresh) => {
    const entry = fresh.crews.find((c: Obj) => isObj(c) && c.slug === slug)
    if (entry !== undefined) entry.status = 'merged'
  })
  if (gates !== undefined) appendDecision(dir, `crew ${slug} merged into ${target} at ${head} | land: process ${gates.process}, qc ${gates.qc}, red ${gates.red}${red !== undefined ? `, red record exit ${red.exit}` : ''}${needQc && ruling !== undefined ? `, QC PASS on ${ruling.head}` : ''}`)
  else appendDecision(dir, `crew ${slug} merged into ${target} at ${head} | QC PASS on ${ruling?.head}, red record exit ${red?.exit}, patch ${patch}, acceptance test green on the merged head`)
  // contract-025 section 4: the merge is final by now, so a ledger failure is a decision line, never a refusal
  try {
    const cost = crewCost(dir, repo, slug)
    ledgerAppend(repo, { v: 1, ts: new Date().toISOString(), kind: 'merge', session: path.basename(dir), crew: slug, goal: goalOf(crew), workType: typeof crew.workType === 'string' ? crew.workType : null, process: gates?.process ?? crew.process ?? 'full', qc: needQc, red: needRed, target, base, head, costUsd: cost.usd, ...(cost.usd === null && cost.why !== undefined ? { costWhy: cost.why } : {}) })
  } catch (e) {
    appendDecision(dir, `ledger row for crew ${slug} not written | ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`)
  }
  const own = new Set(fresh.crews.filter(isObj).map((c: Obj) => `truss-${c.slug}`))
  for (const w of worktreesOf(repo)) {
    if (w.path === wt || w.branch === undefined || own.has(w.branch) || !w.branch.startsWith(`truss-${slug}-`)) continue
    if (run(repo, ['merge-base', '--is-ancestor', `refs/heads/${w.branch}`, `refs/heads/truss-${slug}`]).status === 0) run(repo, ['worktree', 'remove', w.path])
  }
  // the crew's own worktree and branch truss-<slug> are retired now: the target holds the branch, so nothing is archived
  const x: RetireCtx = { dir, repo, target, mainTop: worktreesOf(repo)[0]?.path ?? repo }
  const crewWt = worktreesOf(repo).find((w) => w.branch === `truss-${slug}`)
  const kept = crewWt !== undefined ? retireWorktree(x, crewWt, { crew: slug, run: runId, why: 'merged' }) : retireBranch(x, `truss-${slug}`, { crew: slug, run: runId, why: 'merged', worktree: null })
  // ADR-0021 Decision 7 and ADR-0030: the run's member worktrees are retired by sweepMembers once every crew has had its turn
  return kept !== undefined && crewWt !== undefined ? { merged: true, left: [{ path: crewWt.path, branch: `truss-${slug}`, why: kept }] } : { merged: true }
}

// ADR-0026 item 56: when the repo finish merged into is the plugin's own repo, one warning per plugin agents/*.md the merges
// changed (target head before..after): this session keeps the agent definition it loaded until a restart, silently.
// Each names the item-24 fallback. Read-only git; any git failure gives no warning.
function agentFileWarnings(repo: string, before: string, target: string): string[] {
  const top = (cwd: string): string | undefined => {
    const r = run(cwd, ['rev-parse', '--show-toplevel'])
    if (r.status !== 0 || r.out === '') return undefined
    try {
      return flat(realpathSync(r.out))
    } catch {
      return flat(r.out)
    }
  }
  let pluginTop: string | undefined
  let repoTop: string | undefined
  try {
    pluginTop = top(PLUGIN)
    repoTop = top(repo)
  } catch {
    return []
  }
  if (pluginTop === undefined || pluginTop !== repoTop) return []
  const rel = path.posix.relative(pluginTop, flat(realpathSync(PLUGIN)))
  const agents = rel === '' ? 'agents' : `${rel}/agents`
  const workflows = rel === '' ? 'workflows' : `${rel}/workflows`
  const d = run(repo, ['diff', '--name-only', before, `refs/heads/${target}`, '--', `${agents}/`, `${workflows}/stage.js`, `${workflows}/plan.js`])
  if (d.status !== 0) return []
  const out: string[] = []
  for (const p of d.out.split('\n')) {
    for (const name of ['stage.js', 'plan.js']) {
      if (p === `${workflows}/${name}`) out.push(`the merge changed workflows/${name}; the Workflow gate still matches the ${name} this session loaded, so the repo path is refused until a restart; restart the session, or run a scratchpad copy of the loaded plugin's ${name} for crews already under way (ADR-0024 item 24)`)
    }
    if (!p.startsWith(`${agents}/`) || !/^[^/]+\.md$/.test(p.slice(agents.length + 1))) continue
    const file = `agents/${p.slice(agents.length + 1)}`
    const type = `truss:${file.slice('agents/'.length, -'.md'.length)}`
    out.push(`the merge changed ${file}; this session keeps the ${type} definition it loaded until a restart, so restart the session, or spawn the role as general-purpose with ${file} inlined in its prompt (ADR-0024 item 24)`)
  }
  return out
}

// ADR-0031 item 6: the merge gate for a direct (solo or lean) crew. mergeCrew's steps, the red and QC gates switched by the crew's booleans.
export function cmdLand(f: Flags): Obj {
  const repo = repoOf(f)
  const slug = need(f, 'slug')
  const settings = settingsFor(f, repo)
  if (settings.merge === 'single') throw usage('single merge mode runs on the project manager path')
  const dir = dirOf(f)
  const plan = loadPlan(dir)
  const crew = plan.crews.find((c: Obj) => isObj(c) && c.slug === slug)
  if (crew === undefined) throw usage(`no crew ${slug} in the plan`)
  const no = (why: string): CliError => refuse({ merged: false, slug, why })
  if (crew.status !== 'running') throw no(`${slug} is not running (status ${String(crew.status)})`)
  const process = crew.process
  if (process !== 'solo' && process !== 'lean') throw no(`${slug} has process ${process === undefined ? 'absent' : String(process)}, not solo or lean; a full crew merges through finish`)
  const qc = process === 'lean' && crew.qc === true
  const red = process === 'lean' && crew.red === true
  let ruling: QcRuling | undefined
  let fails = 0
  if (qc) {
    const since = runStart(plan) ?? 0
    // the PM saves the hand-back as <slug>-qc[-k].md (finish's name) or, under reports/<slug>/, as qc[-k].md
    const files = reportsOf(dir, slug).map((r) => (/^qc(-\d+)?\.md$/.test(r.name) ? { ...r, name: `${slug}-${r.name}` } : r))
    const newest = latestQc(slug, files, since)
    ruling = newest === undefined ? undefined : qcRuling(newest.text)
    if (ruling === undefined || ruling.verdict !== 'PASS') throw no('qc: the newest QC file is not a PASS')
    if (ruling.unscoped > 0) throw no('qc: the QC PASS has an UNSCOPED finding')
    fails = qcFails(slug, countedQc(dir, slug, files), since)
  }
  const r = mergeCrew(f, dir, repo, settings.target, crew, ruling, [], fails, { process, qc, red })
  if (r.merged) return { merged: true, slug, process, qc, red, head: run(repo, ['rev-parse', '--verify', `refs/heads/${settings.target}`]).out, ...(r.left !== undefined && r.left.length > 0 ? { leftWorktrees: r.left } : {}) }
  if (r.lint !== undefined) throw refuse({ merged: false, slug, why: r.refused ?? 'knowledge-lint', failures: r.lint })
  throw no(r.rework ?? r.blocked ?? r.refused ?? 'refused')
}

// R-89: one finisher per crew. Leases (finisher-<slug>) are taken before a crew is written, refreshed between crews and before each merge,
// and released on every return and throw.
export function cmdFinish(f: Flags): Obj {
  const held = new Map<string, string>()
  try {
    return finishRun(f, held)
  } finally {
    for (const [slug, token] of held) releaseLease(dirOf(f), `finisher-${slug}`, token)
  }
}
function finishRun(f: Flags, held: Map<string, string>): Obj {
  const repo = repoOf(f)
  need(f, 'transcript')
  const settings = settingsFor(f, repo)
  if (settings.merge === 'single') throw usage('single merge mode runs on the project manager path')
  const dir = dirOf(f)
  const tdir = flat(need(f, 'transcript')).replace(/\/+$/, '')
  const resultPath = str(f, 'result')
  let results: Obj[] | undefined
  if (resultPath !== undefined) {
    const v = readJson(flat(resultPath))
    if (!Array.isArray(v)) throw usage('--result must hold the JSON array stage.js returned')
    results = v.filter(isObj)
  }
  const plan = loadPlan(dir)
  // ADR-0022 R4: the run's roles table, truss.json roles laid on, so the ux audit names the mapped ux agentType
  const roles = rolesWithTypes(PLUGIN, [], configOf(repo).roles)
  const wfRun = runOf(tdir)
  const allCrews: Obj[] = plan.crews.filter((c: Obj) => isObj(c) && typeof c.slug === 'string' && c.status === 'running' && factorySpawned(dir, c.slug) !== undefined)
  const liveFinisher: Obj[] = []
  for (const c of allCrews) {
    if (results !== undefined && !results.some((r) => r.slug === c.slug) && !wfRun.agents.some((a) => parseLabel(a.label)?.slug === c.slug)) continue
    if (results === undefined && !wfRun.agents.some((a) => parseLabel(a.label)?.slug === c.slug)) continue
    const got = takeLease(dir, `finisher-${String(c.slug)}`)
    if (got === null) liveFinisher.push({ slug: c.slug, why: 'finisher live' })
    else held.set(String(c.slug), got.token)
  }
  const factoryCrews = allCrews.filter((c) => !liveFinisher.some((l) => l.slug === c.slug))
  const factorySlugs = new Set(factoryCrews.map((c) => c.slug as string))
  const inRun = factoryCrews.filter((c) => wfRun.agents.some((a) => parseLabel(a.label)?.slug === c.slug))
  const out = { merged: [] as string[], rework: [] as Obj[], blocked: [] as Obj[], refused: [] as Obj[], audit: [] as Obj[], incomplete: [] as string[], stopped: [] as Obj[], leftWorktrees: [] as Obj[], warnings: [] as string[] }
  out.refused.push(...liveFinisher)
  const finishWith = (): Obj => {
    const body = {
      merged: out.merged, rework: out.rework, blocked: out.blocked, refused: out.refused, audit: out.audit, incomplete: out.incomplete, stopped: out.stopped,
      ...(out.leftWorktrees.length > 0 ? { leftWorktrees: out.leftWorktrees } : {}), ...(out.warnings.length > 0 ? { warnings: out.warnings } : {}),
    }
    if (out.refused.length > 0 || out.rework.length > 0 || out.blocked.length > 0 || out.audit.length > 0) throw refuse(body)
    return body
  }

  // every running crew whose result is not `passed`, or that the run holds with no result at all, is listed so the PM
  // can't miss it; why is the stop text's first line (the full text is in the result file). It never changes the exit code.
  for (const c of results === undefined ? [] : factoryCrews) {
    const res = results.find((r) => r.slug === c.slug)
    if (res === undefined && !inRun.includes(c)) continue
    if (res !== undefined) setCrewState(dir, String(c.slug), res.state === 'passed' ? 'finished' : 'stopped')
    if (res === undefined) out.stopped.push({ slug: c.slug, tag: null, at: null, why: 'no result for this crew in --result' })
    else if (res.state !== 'passed') {
      const first = String(res.text ?? '').replace(/\r/g, '').split('\n').find((l) => l.trim() !== '')?.trim()
      const why = first === undefined ? `state ${String(res.state)}` : first.length > 300 ? `${first.slice(0, 299)}…` : first
      out.stopped.push({ slug: c.slug, tag: typeof res.tag === 'string' ? res.tag : null, at: typeof res.at === 'string' ? res.at : null, why })
    }
  }

  if (results === undefined) {
    // no result: the liveness rule first, writing nothing while it fails
    const now = Date.now()
    for (const c of inRun) if (isLive(factorySpawned(dir, c.slug)?.ts ?? now, tdir, now)) out.refused.push({ slug: c.slug, why: 'run may be live' })
    if (out.refused.length > 0) return finishWith()
  }

  // ADR-0012 Decision 10: the extract is kept with the truss dir; a failed write is one decision line and changes nothing else
  try {
    const parts = tdir.split('/')
    const session = parts.length >= 3 && parts[parts.length - 2] === 'workflows' && parts[parts.length - 3] === 'subagents' ? parts.slice(0, -3).join('/') : tdir
    const { cat, ex } = retro()
    ex.writeExtract(dir, ex.extractSession(session, cat.loadCatalog(`${PLUGIN}/retro/catalog.json`)))
  } catch (e) {
    const what = `retro extract failed: ${(e as Error).message}`
    const had = existsSync(`${dir}/decisions.md`) ? readFileSync(`${dir}/decisions.md`, 'utf8') : ''
    if (!had.includes(what)) appendDecision(dir, what)
  }

  const passed: Audit[] = []
  const audits = recordRun(dir, wfRun, factorySlugs, roles, passed)
  logPassed(dir, passed.splice(0))
  for (const a of audits) out.audit.push({ label: a.label, why: a.why })
  recordEscalations(dir, wfRun, inRun, results, plan)

  if (results === undefined) {
    const have = existsSync(`${dir}/events.jsonl`) ? jsonLines(`${dir}/events.jsonl`) : []
    for (const c of inRun) {
      if (!have.some((e) => e.event === 'incomplete' && e.crew === c.slug && e.run === wfRun.id)) appendEvent(dir, { event: 'incomplete', crew: c.slug, agent: c.slug, run: wfRun.id })
      out.incomplete.push(c.slug)
    }
    return finishWith()
  }

  // session audit: while an entry stands, nothing merges
  const log = existsSync(`${dir}/decisions.md`) ? readFileSync(`${dir}/decisions.md`, 'utf8') : ''
  // a waiver counts only with its evidence: `audit waived: <run id> | <evidence> | ...`, written by the program manager or the client
  const waived = new Set([...log.matchAll(/^- [^|]*\|\s*audit waived: ([A-Za-z0-9._-]+)\s*\|[^|\n]*[^|\s][^|\n]*\|/gm)].map((m) => m[1] as string))
  const stand = sessionAudit(dir, path.dirname(tdir), wfRun.id, new Set(plan.crews.filter((c: Obj) => isObj(c) && factorySpawned(dir, c.slug) !== undefined).map((c: Obj) => c.slug as string)), waived, passed)
  logPassed(dir, passed)
  for (const a of stand) if (!out.audit.some((x) => x.label === a.label && x.why === a.why)) out.audit.push({ label: a.label, why: a.why })
  if (stand.length > 0) {
    const what = `session audit stands, nothing merged: ${stand.map((a) => `${a.label} (${a.why})`).join('; ')}`
    if (!log.includes(what)) appendDecision(dir, `${what} | the program manager rules on the evidence: a decision line "audit waived: <run id> | <evidence>" or the offending run goes`)
    for (const c of inRun) out.refused.push({ slug: c.slug, why: 'session audit' })
    return finishWith()
  }

  const since = runStart(plan) ?? 0
  const targetBefore = run(repo, ['rev-parse', '-q', '--verify', `refs/heads/${settings.target}`])
  for (const c of inRun) {
    const res = results.find((r) => r.slug === c.slug)
    if (res === undefined || res.state !== 'passed') continue
    for (const [slug, token] of held) refreshLease(dir, `finisher-${slug}`, token)
    const files = reportsOf(dir, c.slug)
    const newest = latestQc(c.slug, files, since)
    const ruling = newest === undefined ? undefined : qcRuling(newest.text)
    if (ruling === undefined || ruling.verdict !== 'PASS' || ruling.unscoped > 0) continue
    // 0.32.0 bug F: a PASS does not merge past a new knowledge-lint failure; the crew goes back through `start --resume merge-ready`,
    // whose QC loop re-lints and sends the knowledge writer the failing lines (stage.js lintClean)
    const lint = resultLintFailures(res)
    if (lint.length > 0) {
      out.rework.push({ slug: c.slug, why: 'knowledge-lint', failures: lint })
      continue
    }
    const r = mergeCrew(f, dir, repo, settings.target, c, ruling, audits, qcFails(c.slug, countedQc(dir, c.slug, files), since), undefined, wfRun.id, held.get(String(c.slug)))
    if (r.merged) {
      out.merged.push(c.slug)
      out.leftWorktrees.push(...(r.left ?? []))
    }
    else if (r.rework !== undefined) out.rework.push({ slug: c.slug, why: r.rework })
    else if (r.blocked !== undefined) out.blocked.push({ slug: c.slug, why: r.blocked })
    else out.refused.push({ slug: c.slug, why: r.refused ?? 'refused' })
  }
  if (out.merged.length > 0 && targetBefore.status === 0) out.warnings.push(...agentFileWarnings(repo, targetBefore.out, settings.target))
  // ADR-0030: retire the member worktrees and branches of every crew that is terminal now
  const terminal = new Map<string, RetireWhy>()
  for (const c of loadPlan(dir).crews) if (isObj(c) && typeof c.slug === 'string' && c.status === 'dropped') terminal.set(c.slug, 'dropped')
  for (const r of out.refused) if (typeof r.slug === 'string' && String(r.why).startsWith('rework allowance spent')) terminal.set(r.slug, 'failed')
  for (const s of out.merged) terminal.set(s, 'merged')
  const mainTop = worktreesOf(repo)[0]?.path ?? repo
  out.leftWorktrees.push(...sweepMembers({ dir, repo, target: settings.target, mainTop }, tdir, wfRun.id, terminal, out.merged))
  // each merged crew's sweep reports what it left; a later crew's sweep may have removed it, and the same one is listed per pass.
  // Report each still-present worktree once.
  const present = new Set(worktreesOf(repo).map((w) => w.path))
  const seen = new Set<string>()
  out.leftWorktrees = out.leftWorktrees.filter((l) => {
    if (!present.has(l.path) || seen.has(l.path)) return false
    seen.add(l.path)
    return true
  })
  return finishWith()
}
