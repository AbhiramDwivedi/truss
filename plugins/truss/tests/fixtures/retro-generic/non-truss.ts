// A small project that is not a truss run (R-128, "any project"): its own events.jsonl and usage.jsonl, a plain git history with no
// Truss-Crew trailers, no plan.json and no truss plugin. The history has one file that is edited in most commits and grows large, and
// the usage rows have a long idle gap, so a generic retro has something to find. `makeNonTruss()` makes its own mkdtemp dir.
// Erasable TypeScript, Node built-ins only.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const PLAIN_SID = 'sid-plain'
const MIN = 60000
const T0 = Date.parse('2026-11-10T09:00:00Z')
const iso = (ms: number): string => new Date(ms).toISOString()
const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

const git = (repo: string, args: string[], date?: string): void => {
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env
  const r = spawnSync('git', ['-c', 'core.quotepath=off', '-C', repo, ...args], { windowsHide: true, encoding: 'utf8', env })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

export type NonTruss = { root: string; repo: string; dir: string; cleanup: () => void }

export function makeNonTruss(): NonTruss {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'retro-plain-')))
  const repo = path.join(root, 'shop')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  for (const [k, v] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false'], ['maintenance.auto', 'false'], ['gc.auto', '0']]) git(repo, ['config', k!, v!])
  writeFileSync(path.join(repo, 'README.md'), '# shop\n')
  // src/billing.ts is edited in every commit and grows to 900 lines; its test file follows it
  for (let i = 0; i < 12; i++) {
    const lines = Array.from({ length: 80 + i * 75 }, (_, n) => `export const v${i}_${n} = ${n}`)
    writeFileSync(path.join(repo, 'src', 'billing.ts'), lines.join('\n') + '\n')
    writeFileSync(path.join(repo, 'src', 'billing.test.ts'), `// pass ${i}\n`)
    if (i % 5 === 0) writeFileSync(path.join(repo, 'README.md'), `# shop\n\nrelease ${i}\n`)
    git(repo, ['add', '-A', '--', '.'])
    git(repo, ['commit', '-q', '--no-verify', '-m', `billing: change ${i}`], iso(T0 + i * 40 * MIN))
  }
  const dir = path.join(repo, '.git', 'truss', PLAIN_SID)
  mkdirSync(dir, { recursive: true })
  const ev: Record<string, unknown>[] = [
    { v: 1, ts: iso(T0), event: 'spawn', crew: 'main', agent: 'main', agentId: null, type: 'main', model: 'opus', effort: 'medium', by: 'factory' },
    { v: 1, ts: iso(T0 + MIN), event: 'spawn', crew: 'main', agent: 'billing-builder', agentId: 'p1', type: 'general-purpose', model: 'opus', effort: 'medium', by: 'main' },
    { v: 1, ts: iso(T0 + 3 * 60 * MIN), event: 'spawn', crew: 'main', agent: 'billing-fixer', agentId: 'p2', type: 'general-purpose', model: 'opus', effort: 'medium', by: 'main' },
  ]
  for (let i = 0; i < 6; i++) {
    ev.push({ v: 1, ts: iso(T0 + (10 + i * 5) * MIN), event: 'refusal', crew: 'main', agent: 'main', tool: 'Edit', source: 'project', category: 'edit of a file outside the allowed paths', program: null, shape: [] })
  }
  ev.push({ v: 1, ts: iso(T0 + 4 * 60 * MIN), event: 'report', crew: 'main', agent: 'billing-fixer', marker: null })
  ev.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  writeFileSync(path.join(dir, 'events.jsonl'), jsonl(ev))
  // two bursts of work with a 2 h gap between them
  const rows: Record<string, unknown>[] = []
  let n = 0
  const use = (agentId: string | null, ms: number) =>
    rows.push({ v: 1, ts: iso(ms), sid: PLAIN_SID, agentId, model: 'model-a', speed: 'standard', msgId: `msg_${String(++n).padStart(8, '0')}`, in: 3, out: 400, think: 0, cr: 900000, cw5m: 0, cw1h: 20000, web: 0 })
  for (let i = 0; i <= 30; i++) use('p1', T0 + MIN + i * MIN)
  for (let i = 0; i <= 25; i++) use('p2', T0 + 3 * 60 * MIN + i * MIN)
  for (let i = 0; i < 8; i++) use(null, T0 + i * 20 * MIN)
  rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  writeFileSync(path.join(dir, 'usage.jsonl'), jsonl(rows))
  return { root, repo, dir, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
