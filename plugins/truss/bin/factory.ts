// truss ADR-0009 Decision 1: the factory CLI. Run as `node <plugin>/bin/factory.ts <command> [flags]`. Every command
// prints one JSON object on one line; exit 0 = done, 1 = a gate or expectation refused, 2 = usage or I/O error
// ({"error": "..."}). Node built-ins and relative paths only.
// 0.31.0 item 5: this file is the thin dispatcher: the command table, main, the CLI flags around it and the re-exports. Each
// command group lives in bin/factory/<group>.ts (architecture.md, "Factory modules"); no module there imports this file.
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'
import { CliError, isObj, refuse, usage } from './core.ts'
import type { Flags, Obj } from './core.ts'
import { INBOX_COMMANDS } from './inbox.ts'
import { ATTACH_COMMANDS, COST_COMMANDS, recordSession } from './cost.ts'
import { QUEUE_COMMANDS } from './queue.ts'
import { WORKTYPE_COMMANDS } from './worktypes.ts'
import { cmdCheck } from './factory/check.ts'
import { cmdIntegrate, cmdMarkMerged, cmdOwnsCheck, cmdOwnsExtend, cmdSync, cmdTestsCheck } from './factory/crew.ts'
import { cmdDecide, cmdGoalCheckJob, goalCheckMain } from './factory/decide.ts'
import { cmdCrewDecision, cmdCrewLearned, cmdDecisionAck, cmdDecisionCheckpoint, cmdDecisionReplies, cmdDecisionReply, cmdDecisions, cmdKnowledgeCommit } from './factory/decisions.ts'
import { cmdDoctor } from './factory/doctor.ts'
import { cmdFinish, cmdLand } from './factory/finish.ts'
import { gatesRun } from './factory/gates.ts'
import { heavyJobMain, heavyMain } from './factory/heavy.ts'
import { cmdGatedMerge, cmdKnowledgeConfigGate, cmdKnowledgeLint, cmdKnowledgeMigrate, cmdRulesIndex, cmdStitch } from './factory/knowledge-cmds.ts'
import { cmdPersonaInstall } from './factory/personas.ts'
import { cmdApprove, cmdPlanArgs, cmdPlanCheck, cmdPlanWrite, cmdSettings } from './factory/plan.ts'
import { cmdAdmit, cmdReap } from './factory/resources.ts'
import { parseFlags } from './factory/shared.ts'
import { argsFileOut, checkArgsFile, cmdStart } from './factory/start.ts'

// ADR-0037: the shared helpers live in store.ts and are re-exported here, so existing imports keep working.
export { CliError, usage, refuse, flat, str, need, listOf, isObj, readText, readJson, parseLabel, repoPathOf, configOf } from './core.ts'
export type { Flags, Obj }
// The names the command modules exported from here before the split, so existing imports keep working.
export { loadPlan, savePlan, settingsOf, knowledgeCfgOf, crewWorktree, baseOf, appendEvent, appendDecision, readRoles, roleDefaults } from './factory/shared.ts'
export type { RunAgent, WfRun } from './factory/runs.ts'
export { runOf, runsOf, SYNTHETIC_MODEL, transcriptFacts, newestMtime, STALE_MS, isLive, reportsOf, replannedFrom, countedQc, uxReworks, spentOf, directionOf, labelFromOf, factorySpawned } from './factory/runs.ts'
export { personaDrafts } from './factory/plan.ts'
export { ENV_PATTERNS, envFailure, envVerdict, installMissingDeps } from './factory/check.ts'
export { unparsedTrailers } from './factory/crew.ts'
export { membersOf, uxSaysOff, uxOn } from './factory/start.ts'
export type { StartProbe } from './factory/warnings.ts'
export { sessionStart, sessionStartOnce } from './factory/warnings.ts'
export { HEAVY_WAIT_MS, HEAVY_WAIT_MAX_MS, heavyWaitMs, slotWaitMs, heavySlotsOf, pidAlive } from './factory/resources.ts'
export { HEAVY_ATTACH_MS, heavyMain, heavyJobMain } from './factory/heavy.ts'
export { GATE_STEPS, gateMet } from './factory/gates.ts'
export type { GateStep } from './factory/gates.ts'
export { mergeHeadVerdict } from './factory/finish.ts'
export { roleAudit, sessionAudit } from './factory/audit.ts'
export { OLD_WF_BRANCH, OLD_WF_PATH, OLD_WF_IDLE_MS, ARCHIVE_PREFIX, ARCHIVE_KEEP_MS, SCRATCH_DIRS, worktreeChanges } from './factory/retire.ts'
export { isSessionDirUnderCommon, cmdDecide, cmdGoalCheckJob, goalCheckMain } from './factory/decide.ts'

// ==== main ====

const CORE_COMMANDS: Record<string, (f: Flags) => Obj> = {
  'crew-decision': cmdCrewDecision, 'decision-reply': cmdDecisionReply, 'decision-replies': cmdDecisionReplies, 'decision-ack': cmdDecisionAck, 'decision-checkpoint': cmdDecisionCheckpoint,
  'knowledge-lint': cmdKnowledgeLint, 'knowledge-config-gate': cmdKnowledgeConfigGate, 'gated-merge': cmdGatedMerge, 'knowledge-migrate': cmdKnowledgeMigrate, 'rules-index': cmdRulesIndex, stitch: cmdStitch,
  'knowledge-commit': cmdKnowledgeCommit, 'crew-learned': cmdCrewLearned, decisions: cmdDecisions,
  settings: cmdSettings, 'plan-args': cmdPlanArgs, 'plan-write': cmdPlanWrite, 'plan-check': cmdPlanCheck, approve: cmdApprove, start: (f) => (checkArgsFile(f), argsFileOut(f, cmdStart(f))),
  sync: cmdSync, check: cmdCheck, integrate: cmdIntegrate, 'mark-merged': cmdMarkMerged, 'owns-check': cmdOwnsCheck, 'owns-extend': cmdOwnsExtend, 'tests-check': cmdTestsCheck, finish: cmdFinish, land: cmdLand, doctor: cmdDoctor,
  admit: cmdAdmit, reap: cmdReap, decide: cmdDecide, 'goal-check-job': cmdGoalCheckJob, 'persona-install': cmdPersonaInstall,
  heavy: () => {
    throw usage('heavy is async: run it from the command line')
  },
  gates: () => {
    throw usage('gates is async: run it from the command line')
  },
  'goal-check': () => {
    throw usage('goal-check is async: run it from the command line')
  },
}
// A plugin module's command key never replaces a core command or another module's: main refuses and names the keys.
const PLUGIN_COMMANDS: Record<string, (f: Flags) => Obj>[] = [INBOX_COMMANDS, COST_COMMANDS, QUEUE_COMMANDS, WORKTYPE_COMMANDS]
const SHADOWED: string[] = []
const COMMANDS: Record<string, (f: Flags) => Obj> = { ...CORE_COMMANDS }
for (const group of PLUGIN_COMMANDS) {
  for (const [k, fn] of Object.entries(group)) {
    if (Object.hasOwn(COMMANDS, k)) SHADOWED.push(k)
    else COMMANDS[k] = fn
  }
}

// `decision-reply <id> ack|change [--note T]` takes two words before or among its flags: each word that is not a flag or a flag's
// value becomes the next of `names` as a flag.
function positionalsToFlags(argv: string[], names: string[]): string[] {
  const out: string[] = []
  let n = 0
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a.startsWith('--')) {
      out.push(a)
      const next = argv[i + 1]
      if (!a.includes('=') && next !== undefined && !next.startsWith('--')) out.push(argv[++i] as string)
    } else if (n < names.length) {
      out.push(`--${names[n++]}`, a)
    } else {
      out.push(a)
    }
  }
  return out
}

// A session that runs a state-changing command on a run dir named after another session has resumed that run: record it, so the cost
// meter sweeps its transcripts too (recordSession, sessionsOf in cost.ts). Claude Code sets CLAUDE_CODE_SESSION_ID in a Bash call's
// environment, and a subagent or Workflow inherits the parent session's id, whose transcripts hold the agents' too. Never fails the command.
function attach(command: string, f: Flags): void {
  const dir = typeof f.dir === 'string' ? f.dir : undefined
  if (!ATTACH_COMMANDS.includes(command) || dir === undefined || !path.isAbsolute(dir)) return
  try {
    recordSession(dir, process.env.CLAUDE_CODE_SESSION_ID, command)
  } catch {
    // a record that cannot be written leaves the meter as it was before 0.31.0: the run dir's own session only
  }
}

// Runs one command and returns what it printed and its exit code.
export function main(argv: string[]): { body: Obj; code: number } {
  try {
    const [command, ...rest] = argv
    if (SHADOWED.length > 0) throw refuse({ error: `a plugin command key shadows a core command: ${SHADOWED.join(', ')}` })
    const fn = command === undefined ? undefined : COMMANDS[command]
    if (fn === undefined) throw usage(`unknown command: ${command ?? '(none)'}; commands: ${Object.keys(COMMANDS).join(', ')}`)
    const argv2 = command === 'decision-reply' ? positionalsToFlags(rest, ['id', 'reply']) : command === 'resolve' || command === 'mark-applied' ? positionalsToFlags(rest, ['id']) : rest
    const flags = parseFlags(argv2)
    attach(command as string, flags)
    return { body: fn(flags), code: 0 }
  } catch (e) {
    if (e instanceof CliError) return { body: e.body, code: e.code }
    return { body: { error: e instanceof Error ? e.message : String(e) }, code: 2 }
  }
}

// gates runs some steps through main, so it gets main from here rather than importing this file.
export const gatesMain = (argv: string[]): Promise<{ body: Obj; code: number }> => gatesRun(argv, main)

const isMain = ((): boolean => {
  try {
    return process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href
  } catch {
    return false
  }
})()
// ADR-0022 U5 (item 22): the `truss-status: <short JSON>` line `--status-line` adds after the result. It holds only the
// booleans ok, merged and admitted, head as a string, env cut to 200 characters, ran from heavy.ran, and pending (with ageMs and
// budgetMs) from heavy.
export function statusLine(body: Obj): string {
  const s: Obj = {}
  for (const k of ['ok', 'merged', 'admitted', 'checkpoint']) if (typeof body[k] === 'boolean') s[k] = body[k]
  if (typeof body.head === 'string') s.head = body.head
  if (typeof body.env === 'string') s.env = body.env.slice(0, 200)
  if (isObj(body.heavy) && typeof body.heavy.ran === 'boolean') s.ran = body.heavy.ran
  // 0.31.0 item 2: a heavy run still going in the background, which the same line collects when run again
  // with the job's age and give-up budget (heavyMain), which stage.js polls against
  if (isObj(body.heavy) && body.heavy.pending === true) {
    s.pending = true
    for (const k of ['ageMs', 'budgetMs']) if (typeof body.heavy[k] === 'number') s[k] = body.heavy[k]
  }
  // ADR-0046 item 1: a gates result also carries each step's met and the step that stopped it
  if (isObj(body.gates)) {
    s.gates = Object.fromEntries(Object.entries(body.gates).filter(([, v]) => typeof v === 'boolean'))
    s.stopped = typeof body.stopped === 'string' ? body.stopped : null
  }
  return `truss-status: ${JSON.stringify(s)}`
}
// Takes the boolean --status-line flag out of argv (for heavy, only before its `--`, so the command after it is untouched).
export function takeStatusFlag(argv: string[]): { on: boolean; argv: string[] } {
  const cut = argv.indexOf('--')
  const head = cut < 0 ? argv : argv.slice(0, cut)
  const rest = cut < 0 ? [] : argv.slice(cut)
  return { on: head.includes('--status-line'), argv: [...head.filter((a) => a !== '--status-line'), ...rest] }
}
// ADR-0046 item 1: `--reap-first <slug>` reaps that crew's `<slug>-check` process groups (as `reap --slug <slug> --label
// <slug>-check`) before the command runs, so stage.js folds the reap after a member into its next factory call instead of
// spending a runner spawn on it. For heavy it is taken only before the `--`. Only a failed reap rides on the body (as reapedFirst), so the command's own output is unchanged.
export function takeReapFlag(argv: string[]): { slug: string | null; argv: string[] } {
  const cut = argv.indexOf('--')
  const i = argv.indexOf('--reap-first')
  if (i < 0 || (cut >= 0 && i > cut)) return { slug: null, argv }
  return { slug: argv[i + 1] ?? '', argv: [...argv.slice(0, i), ...argv.slice(i + 2)] }
}
export function reapFirst(argv: string[], slug: string): Obj {
  try {
    const cut = argv.indexOf('--')
    const f = parseFlags((cut < 0 ? argv : argv.slice(0, cut)).slice(1))
    return cmdReap({ ...f, slug, label: `${slug}-check` })
  } catch (e) {
    return { error: e instanceof CliError ? JSON.stringify(e.body) : e instanceof Error ? e.message : String(e) }
  }
}
if (isMain) {
  const { on, argv: plain } = takeStatusFlag(process.argv.slice(2))
  const { slug: reapSlug, argv } = takeReapFlag(plain)
  const first = reapSlug === null ? null : reapFirst(argv, reapSlug)
  const { body, code } = argv[0] === 'heavy' ? await heavyMain(argv.slice(1)) : argv[0] === 'heavy-job' ? await heavyJobMain(argv.slice(1)) : argv[0] === 'gates' ? await gatesMain(argv.slice(1)) : argv[0] === 'goal-check' ? await goalCheckMain(argv.slice(1)) : main(argv)
  if (first && !Array.isArray(first.reaped)) body.reapedFirst = first
  // ADR-0032: persona-install refuses with one stderr line (and no stdout), not the JSON error object the other commands print
  if (argv[0] === 'persona-install' && code !== 0) process.stderr.write(`persona-install: ${typeof body.error === 'string' ? body.error : JSON.stringify(body)}\n`.replace(/\n(?=.)/g, ' '))
  else process.stdout.write(JSON.stringify(body) + '\n' + (on ? statusLine(body) + '\n' : ''))
  process.exitCode = code
}
