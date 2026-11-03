// @ts-nocheck
// finish warns when a merge changes the plugin's workflows/stage.js or plan.js (the Workflow gate keeps matching the copy the
// session loaded), as it does for agents/*.md (ADR-0024 item 24). Drives bin/factory.ts through the CLI only, like factory-fixes6.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as reg from '../hooks/register.ts'
import {
  addCrewWorktree, appendEvent, crew, factorySpawn, git, head, mkRepo, mkRun, mkTrussDir, planObj, putFile, qcReport, runCli, tmp, writePlan,
} from './fixtures/workflow-run/harness.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\\/g, '/').replace(/\/$/, '')
const HOUR = 3_600_000
const CFG = { merge: 'sequential', target: 'main' }
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`
const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v !== null && typeof v === 'object' ? Object.values(v).flatMap(strings) : [])

/** A repo that holds the plugin at plugins/truss, a crew s that appends a line to each given plugin-relative file, and a finish-ready run. */
function world(changed: string[]) {
  const repo = mkRepo({ config: CFG })
  for (const sub of ['bin', 'hooks', 'docs', 'workflows', 'resources', 'retro', 'agents']) if (existsSync(`${ROOT}/${sub}`)) cpSync(`${ROOT}/${sub}`, `${repo}/plugins/truss/${sub}`, { recursive: true })
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'plugin'])
  const dir = mkTrussDir()
  const transcripts = tmp('fsw-tr-')
  writePlan(dir, planObj([crew('s', { owns: ['plugins/truss/**'], status: 'running' })], { approvedAt: '2026-10-01T00:00:00.000Z' }))
  appendEvent(dir, factorySpawn('s', new Date(Date.now() - 3 * HOUR).toISOString()))
  const wt = addCrewWorktree(repo, 's')
  for (const f of changed) putFile(wt, `plugins/truss/${f}`, `${readFileSync(`${wt}/plugins/truss/${f}`, 'utf8')}\n// a line the crew added\n`, `change ${f}`)
  if (changed.length === 0) putFile(wt, 'plugins/truss/notes.txt', 'unrelated\n', 'unrelated')
  const base = git(wt, ['merge-base', 'main', 'HEAD'])
  const hd = head(wt)
  const [diffCmd, idCmd] = reg.PATCH_COMMAND.split(' | ').map((s) => s.replace('<base>', base).replace('<head>', hd).split(' '))
  const dres = spawnSync(diffCmd[0], diffCmd.slice(1), { cwd: wt, encoding: 'utf8' })
  const patch = reg.patchIdOf(spawnSync(idCmd[0], idCmd.slice(1), { cwd: wt, input: dres.stdout, encoding: 'utf8' }).stdout)
  mkdirSync(`${dir}/checks`, { recursive: true })
  writeFileSync(`${dir}/checks/s-1.json`, JSON.stringify({ command: 'true', exit: 1, head: hd, tail: '' }))
  const run = mkRun(transcripts, 'wf_1', [
    { label: 's-builder', agentType: 'general-purpose', metaModel: 'sonnet', model: 'claude-sonnet-5-5', effort: 'medium', result: 'built it' },
    { label: 's-qc', agentType: 'truss:qc-engineer', metaModel: 'opus', model: 'claude-opus-5-5', effort: 'medium', result: qcReport({ head: hd, patch }) },
  ])
  const resFile = `${dir}/result.json`
  writeFileSync(resFile, JSON.stringify([{ slug: 's', state: 'passed', head: hd, base, qc: 's-qc' }]))
  return { repo, dir, run, resFile, factory: `${repo}/plugins/truss/bin/factory.ts` }
}

function finish(changed: string[]): string[] {
  const w = world(changed)
  const r = runCli(w.factory, 'finish', ['--dir', w.dir, '--repo', w.repo, '--transcript', w.run.dir, '--result', w.resFile], w.repo)
  assert.equal(r.status, 0, say(r))
  assert.deepEqual(r.json.merged, ['s'], say(r))
  return strings(r.json)
}

const scriptWarnings = (all: string[], name: string): string[] => all.filter((s) => s.includes(`workflows/${name}`))

for (const name of ['stage.js', 'plan.js']) {
  test(`script warning: a merge changing workflows/${name} yields one warning naming it`, () => {
    const all = finish([`workflows/${name}`])
    const mine = scriptWarnings(all, name)
    assert.equal(mine.length, 1, JSON.stringify(all))
    assert.ok(mine[0].includes(`the Workflow gate still matches the ${name} this session loaded`), mine[0])
    assert.ok(mine[0].includes('ADR-0024 item 24'), mine[0])
  })
}

test('control: a merge changing only an agents/*.md file yields the agent warning and no script warning', () => {
  const all = finish(['agents/writer.md'])
  assert.equal(all.filter((s) => s.includes('agents/writer.md') && s.includes('this session keeps')).length, 1, JSON.stringify(all))
  assert.deepEqual(all.filter((s) => s.includes('the Workflow gate still matches')), [])
})

test('control: a merge changing neither yields no agent or script warning', () => {
  const all = finish([])
  assert.deepEqual(all.filter((s) => s.includes('the Workflow gate still matches') || s.includes('this session keeps')), [])
})
