// A running crew's stage-workflow members show before the stage ends: the events log records them only at the end, but
// each member's meta/transcript file is already under subagents/workflows/<wf id>/. Public seam only: createStore.
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
const WF = 'wf_abc123-def'
const { createStore } = (await import(pathToFileURL(path.join(uiDir, 'server', 'state', 'index.ts')).href)) as any

const projectKey = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-')

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'truss-live-')))
  const repo = path.join(base, 'repo')
  fs.mkdirSync(repo)
  execFileSync('git', ['init', '-q', repo], { stdio: 'pipe' })
  const trussDir = path.join(repo, '.git', 'truss', SESSION)
  fs.cpSync(path.join(rawFixture, 'truss', SESSION), trussDir, { recursive: true })
  const claudeDir = path.join(base, 'claude')
  const wfDir = path.join(claudeDir, 'projects', projectKey(repo), SESSION, 'subagents', 'workflows', WF)
  fs.mkdirSync(wfDir, { recursive: true })
  return { base, repo, trussDir, claudeDir, wfDir }
}

const agent = (wfDir: string, id: string, description: string, agentType: string, tool?: string) => {
  fs.writeFileSync(path.join(wfDir, `agent-${id}.meta.json`), JSON.stringify({ agentType, description, model: 'sonnet' }))
  const line = tool ? JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: tool, input: { file_path: '/x/greet.sh' } }] } }) + '\n' : ''
  fs.writeFileSync(path.join(wfDir, `agent-${id}.jsonl`), line)
}

test('live workflow members: a running crew shows its workflow agents with task and activity before any spawn event', () => {
  const env = setup()
  try {
    fs.appendFileSync(path.join(env.trussDir, 'events.jsonl'), JSON.stringify({ v: 1, ts: '2026-11-04T09:39:00.000Z', event: 'title', crew: 'build-crew', agent: 'build-crew-tester', label: 'build-crew-tester', title: 'write-test' }) + '\n')
    agent(env.wfDir, 'a111', 'build-crew-tester', 'kit:test-writer', 'Edit')
    agent(env.wfDir, 'a222', 'build-crew-builder', 'kit:builder')
    agent(env.wfDir, 'a333', 'other-crew-builder', 'kit:builder')
    const s2 = createStore({ repo: env.repo, trussDir: env.trussDir, pollMs: 60000, claudeDir: env.claudeDir })
    try {
      const crew = s2.snapshot().state.run.crews.find((c: any) => c.slug === 'build-crew')
      const byName = Object.fromEntries(crew.members.map((m: any) => [m.name, m]))
      assert.equal(byName['build-crew-tester'].task, 'write-test')
      assert.equal(byName['build-crew-tester'].activity, 'Edit: greet.sh')
      assert.equal(byName['build-crew-tester'].type, 'kit:test-writer')
      assert.ok(byName['build-crew-builder'], 'a member with no title still shows')
      assert.equal(byName['other-crew-builder'], undefined, 'another crew label is not this crew')
      const merged = s2.snapshot().state.run.crews.find((c: any) => c.slug === 'docs-crew')
      assert.ok(!merged.members.some((m: any) => m.agentId === 'a111'), 'a merged crew gets no live members')
    } finally {
      s2.close()
    }
  } finally {
    fs.rmSync(env.base, { recursive: true, force: true })
  }
})

test('live workflow members: a member the events log already holds by agentId is not shown twice', () => {
  const env = setup()
  try {
    agent(env.wfDir, 'a111', 'build-crew-tester', 'kit:test-writer')
    const ev = { v: 1, ts: '2026-11-04T09:40:00.000Z', event: 'spawn', crew: 'build-crew', agent: 'build-crew-tester', agentId: 'a111', type: 'kit:test-writer', model: null, effort: null, by: `workflow:${WF}` }
    fs.appendFileSync(path.join(env.trussDir, 'events.jsonl'), JSON.stringify(ev) + '\n')
    const store = createStore({ repo: env.repo, trussDir: env.trussDir, pollMs: 60000, claudeDir: env.claudeDir })
    try {
      const crew = store.snapshot().state.run.crews.find((c: any) => c.slug === 'build-crew')
      assert.equal(crew.members.filter((m: any) => m.agentId === 'a111').length, 1)
    } finally {
      store.close()
    }
  } finally {
    fs.rmSync(env.base, { recursive: true, force: true })
  }
})
