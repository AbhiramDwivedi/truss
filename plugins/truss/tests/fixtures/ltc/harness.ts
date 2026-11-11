// @ts-nocheck
// Shared world for tests/ltc-guard.check.ts (contract-025 section 3, ADR-0034): a temp git repo with a session dir at <repo>/.git/truss/<sid>,
// the real factory CLI as child processes, a notify recorder that captures each inbox code, and a typed '/truss:inbox approve <id> <code>'
// line in a fixture main transcript for a client resolve. Node built-ins only; temp dirs are realpath-ed; no shell is run by a test.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as reg from '../../../hooks/register.ts'
import { REAL_PLUGIN, addCrewWorktree, appendEvent, crew, factorySpawn, flat, git, head, mkRepo, mkRun, planObj, pluginCopy, putFile, qcReport, runCli, writeGoal, writePlan, writeReport } from '../workflow-run/harness.ts'

export { assertOneLine, crew, flat, git, head, planObj, qcReport } from '../workflow-run/harness.ts'

const RECORDER = `${REAL_PLUGIN}/tests/fixtures/inbox/recorder.ts`
export const ID_RE = /E-[0-9]{8}-[0-9a-f]{6}/

const temps: string[] = []
process.on('exit', () => {
  for (const t of temps) {
    try {
      rmSync(t, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
  }
})
/** A fresh temp dir with symlinks resolved (macOS /var) and forward slashes, removed at exit. */
export function mk(prefix: string): string {
  const d = flat(realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix))))
  temps.push(d)
  return d
}

export const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`

export type World = { repo: string; common: string; shared: string; inboxFile: string; sid: string; dir: string; troot: string; notifyOut: string; factory: string }

const notifyCmd = (script: string, ...args: string[]): string => [process.execPath, script, ...args].map((a) => `"${flat(a)}"`).join(' ')

/** A temp git repo (merge sequential, target main, notify = the recorder), a session dir <repo>/.git/truss/<sid> and an empty transcripts root. */
export function mkWorld(config: Record<string, unknown> = {}, files: Record<string, string> = {}): World {
  const notifyOut = `${mk('ltc-notify-')}/rec.jsonl`
  const repo = flat(realpathSync(mkRepo({ config: { merge: 'sequential', target: 'main', notify: notifyCmd(RECORDER, notifyOut), ...config }, files })))
  const common = `${repo}/.git`
  const sid = `sess-${randomUUID().slice(0, 8)}`
  const dir = `${common}/truss/${sid}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/events.jsonl`, '')
  writeFileSync(`${dir}/decisions.md`, '')
  return { repo, common, shared: `${common}/truss/shared`, inboxFile: `${common}/truss/shared/inbox.jsonl`, sid, dir, troot: mk('ltc-tr-'), notifyOut, factory: `${pluginCopy()}/bin/factory.ts` }
}

/** Runs `factory <command> ...args --repo R --dir D` as a real process; positionals go first in `args`. */
export function cli(w: World, command: string, args: string[] = [], extraEnv: Record<string, string> = {}) {
  return runCli(w.factory, command, [...args, '--repo', w.repo, '--dir', w.dir], w.repo, { TRUSS_TRANSCRIPTS_ROOT: w.troot, ...extraEnv })
}

export const decisionsOf = (w: World): string => readFileSync(`${w.dir}/decisions.md`, 'utf8')
export const opsOf = (w: World): any[] => (existsSync(w.inboxFile) ? readFileSync(w.inboxFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

/** The long-term-cost items of the inbox, folded by the real `inbox` command. */
export function ltcItems(w: World): any[] {
  const r = cli(w, 'inbox', ['--kind', 'long-term-cost'])
  assert.equal(r.status, 0, say(r))
  return r.json.items
}

/** The code the notify recorder received for `id` (the row on its stdin holds the code). */
export function codeOf(w: World, id: string): string {
  const rows = existsSync(w.notifyOut) ? readFileSync(w.notifyOut, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(JSON.parse(l).stdin)) : []
  const row = rows.find((x) => x.id === id)
  assert.ok(row && typeof row.code === 'string', `the notify recorder holds no row with a code for ${id}: ${JSON.stringify(rows.map((x) => x.id))}`)
  return row.code
}

const typedLine = (content: string, ts: string): string =>
  JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content }, uuid: randomUUID(), timestamp: ts })

/** The client types `/truss:inbox <decision> <id> <code>` in this session: one main-thread human line, newer than the item's open op. */
export function clientTypes(w: World, id: string, decision: string, extra = ''): string {
  const code = codeOf(w, id)
  const open = opsOf(w).find((o) => o.op === 'open' && o.id === id)
  assert.ok(open, `no open op for ${id}`)
  const ts = new Date(Date.parse(open.ts) + 1000).toISOString()
  const file = `${w.troot}/proj-ltc/${w.sid}.jsonl`
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, typedLine(`/truss:inbox ${decision} ${id} ${code} ${extra ? extra + ' ' : ''}ok`, ts) + '\n')
  return code
}

/** A client resolve: the typed prompt, then `resolve <id> --decision d --by client --code c`. Asserts exit 0. */
export function clientResolves(w: World, id: string, decision = 'approve'): void {
  const code = clientTypes(w, id, decision)
  const r = cli(w, 'resolve', [id, '--decision', decision, '--by', 'client', '--code', code])
  assert.equal(r.status, 0, `resolve ${id}: ${say(r)}`)
}

// ---- plan-write ----

export const COSTLY = 'LONG-TERM-COST: a public REST route /v1/export | later: every client must keep calling it | reversal: costly'
export const CHEAP = 'LONG-TERM-COST: a renamed internal helper | later: one grep to find it | reversal: cheap'

/** A designer result: the plan blocks plus `lines`, one per line; `tag` makes the text (so its revision) differ. */
export function designerResult(lines: string[], tag = 'v1'): string {
  const plan = JSON.stringify(planObj([crew('a')], { approval: 'auto', approvedAt: null }), null, 2)
  return `Here is the plan (${tag}).\n\n${lines.join('\n')}\n\n\`\`\`\`json plan.json\n${plan}\n\`\`\`\`\n\n\`\`\`\`markdown plan.md\n# The plan (${tag})\n\nBody.\n\`\`\`\`\n`
}

/** A plan run whose designer (label truss-designer) and checkers (truss-checker-N) returned the given texts; returns the run dir. */
export function planRun(w: World, runId: string, designer: string, checkers: string[] = []): string {
  const agents = [{ id: 'adesign', label: 'truss-designer', agentType: 'truss:design-engineer', metaModel: 'opus', result: designer }]
  checkers.forEach((c, i) => agents.push({ id: `achk${i + 1}`, label: `truss-checker-${i + 1}`, agentType: 'truss:checking-engineer', metaModel: 'opus', result: c }))
  return mkRun(mk('ltc-runs-'), runId, agents).dir
}

/** `plan-write` of a designer result (and checker results) through the real CLI. */
export function planWrite(w: World, runId: string, designer: string, checkers: string[] = []) {
  return cli(w, 'plan-write', ['--transcript', planRun(w, runId, designer, checkers), '--label', 'truss-designer'])
}

// ---- crews ----

/** The patch id of base..head, as the QC proof line names it. */
export function patchId(cwd: string, base: string, hd: string): string {
  const [diffCmd, idCmd] = reg.PATCH_COMMAND.split(' | ').map((s) => s.replace('<base>', base).replace('<head>', hd).split(' '))
  const d = spawnSync(diffCmd[0], diffCmd.slice(1), { cwd, encoding: 'utf8', windowsHide: true })
  const p = spawnSync(idCmd[0], idCmd.slice(1), { cwd, input: d.stdout, encoding: 'utf8', windowsHide: true })
  return reg.patchIdOf(p.stdout)
}

export type CrewWorld = { w: World; slug: string; wt: string; head: string; base: string; land: () => any; finish: () => any; merged: () => boolean }

/**
 * A running crew that owns everything, one worktree with `files` committed (one commit each, after a plain src file), and the way to merge it:
 * `land()` for a solo or lean crew, `finish()` for a full crew (a QC agent result `qcLines` appended to a PASS report, as stage.js hands it back).
 * Files a crew changes (a manifest) are committed on main first, through mkWorld's `files`.
 */
export function crewWorld(w: World, o: { slug?: string; process: 'solo' | 'lean' | 'full'; qc?: boolean; files?: Record<string, string>; qcLines?: string[] }): CrewWorld {
  const slug = o.slug ?? 'a'
  const over: Record<string, unknown> = { status: 'running', owns: ['**'] }
  if (o.process === 'solo') Object.assign(over, { process: 'solo', workType: 'docs' })
  if (o.process === 'lean') Object.assign(over, { process: 'lean', qc: o.qc === true, red: false })
  writePlan(w.dir, planObj([crew(slug, over)], { version: 4, approvedAt: '2026-10-01T00:00:00.000Z' }))
  writeGoal(w.dir, slug)
  if (o.process === 'full') appendEvent(w.dir, factorySpawn(slug, new Date(Date.now() - 3 * 3600_000).toISOString()))
  const wt = addCrewWorktree(w.repo, slug)
  putFile(wt, `src/${slug}/a.ts`, `${slug}\n`, `work ${slug}`)
  for (const [rel, text] of Object.entries(o.files ?? {})) putFile(wt, rel, text, `add ${rel}`)
  const hd = head(wt)
  const base = git(wt, ['merge-base', 'main', 'HEAD'])
  const qcText = qcReport({ head: hd, patch: patchId(wt, base, hd) }) + (o.qcLines ?? []).join('\n') + '\n'
  const cw: CrewWorld = { w, slug, wt, head: hd, base, land: () => undefined, finish: () => undefined, merged: () => spawnSync('git', ['merge-base', '--is-ancestor', hd, 'refs/heads/main'], { cwd: w.repo, windowsHide: true }).status === 0 }
  if (o.process === 'lean' && o.qc === true) writeReport(w.dir, slug, 'qc-1', qcText)
  if (o.process === 'full') {
    mkdirSync(`${w.dir}/checks`, { recursive: true })
    writeFileSync(`${w.dir}/checks/${slug}-1.json`, JSON.stringify({ command: 'true', exit: 1, head: hd, tail: '' }))
    const qc = { label: `${slug}-qc`, agentType: 'truss:qc-engineer', metaModel: 'opus', model: 'claude-opus-5-5', effort: 'medium', result: qcText }
    const run = mkRun(mk('ltc-runs-'), 'wf_ltc00000-aaa', [qc])
    const resFile = `${w.dir}/result.json`
    writeFileSync(resFile, JSON.stringify([{ slug, state: 'passed', head: hd, base, qc: `${slug}-qc` }]))
    cw.finish = () => cli(w, 'finish', ['--transcript', run.dir, '--result', resFile])
  }
  cw.land = () => cli(w, 'land', ['--slug', slug])
  return cw
}
