// Card title and live line in ui-state (ADR-0029 section 3): the .meta.json description, the `activity` field from the
// transcript tail, and the project manager's goals/<slug>.md fallback. Public seam only: createStore over temp dirs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.dirname(path.dirname(here))
const rawFixture = path.join(uiDir, 'contract', 'fixtures', 'real-data')
const SESSION = '00000000-0000-4000-8000-000000000001'
const PREAMBLE = 'x The computed task text follows:\n'

const { createStore } = (await import(pathToFileURL(path.join(uiDir, 'server', 'state', 'index.ts')).href)) as any
const { readGoalTask } = (await import(pathToFileURL(path.join(uiDir, 'server', 'state', 'goal-task.ts')).href)) as any

const projectKey = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-')
const brief = (task: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: PREAMBLE + '  ' + task } }) + '\n'
const asst = (...blocks: unknown[]) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: blocks } }) + '\n'
const tool = (name: string, input: unknown) => ({ type: 'tool_use', id: 't', name, input })
const AGENT = 'a0000000000000e1'

function makeEnv() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'truss-card-')))
  const repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' })
  const trussDir = path.join(repo, '.git', 'truss', SESSION)
  fs.cpSync(path.join(rawFixture, 'truss', SESSION), trussDir, { recursive: true })
  const claudeDir = path.join(base, 'claude')
  const subagents = path.join(claudeDir, 'projects', projectKey(repo), SESSION, 'subagents')
  fs.mkdirSync(subagents, { recursive: true })
  const ev = { v: 1, ts: '2026-11-04T09:40:00.000Z', event: 'spawn', crew: 'docs-crew', agent: 'probe-e1', agentId: AGENT, type: 'general-purpose', model: null, effort: null, by: 'build-crew' }
  fs.appendFileSync(path.join(trussDir, 'events.jsonl'), JSON.stringify(ev) + '\n')
  return { base, repo, trussDir, claudeDir, subagents }
}
type Env = ReturnType<typeof makeEnv>

async function withEnv(fn: (env: Env, open: (pollMs?: number) => any) => void | Promise<void>) {
  const env = makeEnv()
  const stores: any[] = []
  const open = (pollMs = 60000) => {
    const s = createStore({ repo: env.repo, trussDir: env.trussDir, pollMs, claudeDir: env.claudeDir })
    stores.push(s)
    return s
  }
  try {
    await fn(env, open)
  } finally {
    for (const s of stores) s.close()
    fs.rmSync(env.base, { recursive: true, force: true })
  }
}

function members(store: any): Record<string, any> {
  const out: Record<string, any> = {}
  for (const c of store.snapshot().state.run.crews) for (const m of [...(c.projectManager ? [c.projectManager] : []), ...c.members]) out[m.agentId] = m
  return out
}
const meta = (env: Env, description: string) => fs.writeFileSync(path.join(env.subagents, `agent-${AGENT}.meta.json`), JSON.stringify({ agentType: 'x', description }))
const transcript = (env: Env, body: string) => fs.writeFileSync(path.join(env.subagents, `agent-${AGENT}.jsonl`), body)

test('title: a meta description with whitespace is the task, ahead of the brief line', async () => {
  await withEnv((env, open) => {
    transcript(env, brief('Brief line.'))
    meta(env, 'Apply ruled old-spec updates')
    assert.equal(members(open())[AGENT].task, 'Apply ruled old-spec updates')
  })
})

test('title: a bare-label description is ignored and the brief line is used', async () => {
  await withEnv((env, open) => {
    transcript(env, brief('Brief line.'))
    meta(env, 'arch-current-runner-7')
    assert.equal(members(open())[AGENT].task, 'Brief line.')
  })
})

const titleEv = (env: Env, label: string, title: string) =>
  fs.appendFileSync(path.join(env.trussDir, 'events.jsonl'), JSON.stringify({ v: 1, ts: '2026-11-04T09:39:00.000Z', event: 'title', crew: 'docs-crew', agent: label, label, title }) + '\n')

test('title: a bare-label description with a recorded title takes the title, ahead of the brief line', async () => {
  await withEnv((env, open) => {
    transcript(env, brief('Brief line.'))
    meta(env, 'arch-current-qc')
    titleEv(env, 'arch-current-qc', 'QC arch-current')
    assert.equal(members(open())[AGENT].task, 'QC arch-current')
  })
})

test('title: a descriptive meta description beats a recorded title; a title for another label is ignored', async () => {
  await withEnv((env, open) => {
    transcript(env, brief('Brief line.'))
    titleEv(env, 'arch-current-qc', 'QC arch-current')
    meta(env, 'Apply ruled old-spec updates')
    assert.equal(members(open())[AGENT].task, 'Apply ruled old-spec updates')
    meta(env, 'other-label')
    assert.equal(members(open())[AGENT].task, 'Brief line.')
  })
})

test('title: without a meta file the brief line is used as before', async () => {
  await withEnv((env, open) => {
    transcript(env, brief('Brief line.'))
    assert.equal(members(open())[AGENT].task, 'Brief line.')
  })
})

test('activity: Bash gives its description; Read gives the basename; the last tool_use wins', async () => {
  await withEnv((env, open) => {
    transcript(env, brief('t') + asst(tool('Bash', { description: 'Run the unit tests', command: 'npm test' })))
    assert.equal(members(open())[AGENT].activity, 'Bash: Run the unit tests')
    transcript(env, brief('t') + asst(tool('Bash', { command: 'ls -la\nmore' })) + asst({ type: 'text', text: 'ok' }, tool('Read', { file_path: '/a/b/c.ts' })))
    assert.equal(members(open())[AGENT].activity, 'Read: c.ts')
    transcript(env, brief('t') + asst(tool('Bash', { command: 'ls -la\nmore' })))
    assert.equal(members(open())[AGENT].activity, 'Bash: ls -la')
  })
})

test('activity: Grep gives the pattern, other tools just the name, the line is cut to 120', async () => {
  await withEnv((env, open) => {
    transcript(env, brief('t') + asst(tool('Grep', { pattern: 'foo.*bar' })))
    assert.equal(members(open())[AGENT].activity, 'Grep: foo.*bar')
    transcript(env, brief('t') + asst(tool('TodoWrite', { todos: [] })))
    assert.equal(members(open())[AGENT].activity, 'TodoWrite')
    transcript(env, brief('t') + asst(tool('Bash', { command: 'x'.repeat(500) })))
    assert.equal(members(open())[AGENT].activity.length, 120)
  })
})

test('activity: no tool_use gives null, and so does a missing transcript', async () => {
  await withEnv((env, open) => {
    transcript(env, brief('t') + asst({ type: 'text', text: 'thinking' }))
    assert.equal(members(open())[AGENT].activity, null)
    fs.rmSync(path.join(env.subagents, `agent-${AGENT}.jsonl`))
    assert.equal(members(open())[AGENT].activity, null)
  })
})

test('activity: a transcript that grows is re-read and the value updates', async () => {
  await withEnv(async (env, open) => {
    transcript(env, brief('t') + asst(tool('Read', { file_path: '/x/first.ts' })))
    const store = open(20)
    assert.equal(members(store)[AGENT].activity, 'Read: first.ts')
    fs.appendFileSync(path.join(env.subagents, `agent-${AGENT}.jsonl`), asst(tool('Edit', { file_path: '/x/second.ts' })))
    for (let i = 0; i < 100 && members(store)[AGENT].activity !== 'Edit: second.ts'; i++) await new Promise((r) => setTimeout(r, 30))
    assert.equal(members(store)[AGENT].activity, 'Edit: second.ts')
  })
})

const PROJECT_MANAGER = 'a000000000000010' // docs-crew's project manager in the fixture
const goal = (env: Env, text: string) => {
  fs.mkdirSync(path.join(env.trussDir, 'goals'), { recursive: true })
  fs.writeFileSync(path.join(env.trussDir, 'goals', 'docs-crew.md'), text)
}

test('projectManager: the first line after the # Goal: heading is the task; the heading and slug never are', async () => {
  await withEnv((env, open) => {
    goal(env, '# Goal: docs-crew\n\n   \nWrite the docs.\n\nStage: 1\n')
    assert.equal(members(open())[PROJECT_MANAGER].task, 'Write the docs.')
  })
})

test('projectManager: a missing goal file leaves the task as before', async () => {
  await withEnv((env, open) => {
    const t = members(open())[PROJECT_MANAGER].task
    assert.ok(t === null || (t !== 'docs-crew' && !t.startsWith('# Goal')))
  })
})

test('projectManager: a goal file with only a heading gives null from the reader', async () => {
  await withEnv((env) => {
    goal(env, '# Goal: docs-crew\n\n\n')
    assert.equal(readGoalTask(env.trussDir, 'docs-crew'), null)
    goal(env, '# Goal: docs-crew\n' + 'y'.repeat(500))
    assert.equal(readGoalTask(env.trussDir, 'docs-crew').length, 200)
  })
})

test('projectManager: a non-plain slug reads nothing', async () => {
  await withEnv((env) => {
    goal(env, '# Goal: docs-crew\nSecret.\n')
    fs.writeFileSync(path.join(env.trussDir, 'outside.md'), '# Goal: x\nLeaked.\n')
    for (const slug of ['', '.', '..', '../outside', 'a/b', 'a\\b', 'docs-crew\0']) assert.equal(readGoalTask(env.trussDir, slug), null, JSON.stringify(slug))
    assert.equal(readGoalTask(env.trussDir, 'docs-crew'), 'Secret.')
  })
})
