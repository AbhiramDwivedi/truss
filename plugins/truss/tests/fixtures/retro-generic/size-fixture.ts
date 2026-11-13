// Generates, in a mkdtemp dir, a truss dir the size of 0.31.0's wave 4 (R-130): 1981 event lines, 5900 usage lines and 6 crews, plus
// 9 transcript jsonl files of at least 8.5 MB in total under a transcript root (one main transcript and eight subagent files in its
// session dir), which the counting step must never open. `makeSizeFixture()` makes its own dir. Erasable TypeScript, Node built-ins only.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const SIZE_EVENTS = 1981
export const SIZE_USAGE = 5900
export const SIZE_CREWS = 6
export const TRANSCRIPT_FILES = 9
export const TRANSCRIPT_MIN_BYTES = 8_500_000
export const SIZE_SID = 'sid-size'

const MIN = 60000
const T0 = Date.parse('2026-11-12T12:00:00Z')
const CREWS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']
const AGENTS_PER_CREW = 109 // 6 crews x 109 agents x 3 events + 6 stops + 7 refusals = 1981 event lines
const ROWS_PER_AGENT = 9 // 6 x 109 x 9 = 5886 usage rows, plus 14 main-session rows = 5900

const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const iso = (ms: number): string => new Date(ms).toISOString()

const git = (repo: string, args: string[]): void => {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', '-C', repo, ...args], { windowsHide: true, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

export type SizeFixture = {
  root: string
  repo: string
  dir: string
  /** the transcript root the child process gets as HOME/.claude/projects and TRUSS_TRANSCRIPTS_ROOT */
  transcriptRoot: string
  home: string
  sessionDir: string
  transcripts: string[]
  cleanup: () => void
}

export function makeSizeFixture(): SizeFixture {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'retro-size-')))
  const repo = path.join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q', '-b', 'main'])
  for (const [k, v] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false'], ['maintenance.auto', 'false'], ['gc.auto', '0']]) git(repo, ['config', k!, v!])
  for (let i = 0; i < 3; i++) {
    writeFileSync(path.join(repo, `file${i}.txt`), `line ${i}\n`)
    git(repo, ['add', '-A', '--', '.'])
    git(repo, ['commit', '-q', '--no-verify', '-m', `commit ${i}`])
  }
  const dir = path.join(repo, '.git', 'truss', SIZE_SID)
  mkdirSync(dir, { recursive: true })

  const events: { ms: number; row: Record<string, unknown> }[] = []
  const usage: Record<string, unknown>[] = []
  let msg = 0
  const row = (agentId: string | null, ms: number, big: number) =>
    usage.push({ v: 1, ts: iso(ms), sid: SIZE_SID, agentId, model: 'model-a', speed: 'standard', msgId: `msg_${String(++msg).padStart(8, '0')}`, in: 2, out: 200 + (msg % 50), think: 0, cr: 20000 + big, cw5m: 0, cw1h: 1000, web: 0 })
  CREWS.forEach((crew, ci) => {
    const start = T0 + ci * 20 * MIN
    events.push({ ms: start, row: { v: 1, ts: iso(start), event: 'spawn', crew, agent: crew, agentId: null, type: 'workflow-crew', model: 'opus', effort: 'medium', by: 'factory' } })
    for (let j = 0; j < AGENTS_PER_CREW; j++) {
      const ms = start + 2 * MIN + Math.round(j * 1.5 * MIN)
      const agent = `${crew}-agent-${j}`
      const agentId = `${crew}-a${j}`
      events.push({ ms, row: { v: 1, ts: iso(ms), event: 'spawn', crew, agent, agentId, type: j % 4 === 0 ? 'truss:qc-engineer' : 'kit:builder', model: 'sonnet', effort: 'medium', by: `workflow:wf_${crew}` } })
      events.push({ ms: ms + 1, row: { v: 1, ts: iso(ms + 1), event: 'title', crew, agent, label: agent, title: `Work item ${j} of ${crew}` } })
      for (let r = 0; r < ROWS_PER_AGENT; r++) row(agentId, ms + r * MIN, j * 10)
      const end = ms + ROWS_PER_AGENT * MIN
      events.push({ ms: end, row: { v: 1, ts: iso(end), event: 'report', crew, agent, marker: null } })
    }
    const stop = start + 175 * MIN
    events.push({ ms: stop, row: { v: 1, ts: iso(stop), event: 'tag', crew, agent: crew, tag: 'BLOCKED', run: `wf_${crew}` } })
  })
  for (let i = 0; i < 7; i++) {
    const ms = T0 + (i + 1) * 7 * MIN
    events.push({ ms, row: { v: 1, ts: iso(ms), event: 'refusal', crew: 'main', agent: 'main', tool: 'Edit', source: 'truss', category: 'the main thread does not edit repo files while a run is active', program: null, shape: [] } })
  }
  for (let i = 0; i < 14; i++) row(null, T0 + i * 11 * MIN, 0)
  events.sort((a, b) => a.ms - b.ms)
  usage.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  writeFileSync(path.join(dir, 'events.jsonl'), jsonl(events.map((e) => e.row)))
  writeFileSync(path.join(dir, 'usage.jsonl'), jsonl(usage))

  // 9 transcript files of about 1 MiB each, in the layout Claude Code uses: <root>/<project>/<sid>.jsonl and <root>/<project>/<sid>/subagents/agent-N.jsonl
  const home = path.join(root, 'home')
  const transcriptRoot = path.join(home, '.claude', 'projects')
  const project = path.join(transcriptRoot, repo.replace(/[^A-Za-z0-9]/g, '-'))
  const sessionDir = path.join(project, SIZE_SID)
  mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true })
  const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(980) } }) + '\n'
  const chunk = line.repeat(Math.ceil((1024 * 1024) / line.length))
  const transcripts = [path.join(project, `${SIZE_SID}.jsonl`)]
  for (let i = 1; i < TRANSCRIPT_FILES; i++) transcripts.push(path.join(sessionDir, 'subagents', `agent-${i}.jsonl`))
  for (const t of transcripts) writeFileSync(t, chunk)
  return { root, repo, dir, transcriptRoot, home, sessionDir, transcripts, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
