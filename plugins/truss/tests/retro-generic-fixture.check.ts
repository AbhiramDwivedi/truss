// The scrubbed wave-4 fixture (tests/fixtures/retro-generic): no home path, uuid or flagged name in the committed
// bundle, the counts the retro's numbers come from, and a loader that replays the recorded commits into a real repo.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { scrub } from '../retro/scrub.ts'
import { loadWave4, readWave4Git, readWave4Run } from './fixtures/retro-generic/load.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(HERE, 'fixtures', 'retro-generic')
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const lines = (s: string): number => s.split('\n').filter((l) => l !== '').length

test('retro-generic fixture: the bundle holds no home path, uuid-shaped id or flagged name', () => {
  const names = [
    ...(spawnSync('git', ['config', 'user.name'], { windowsHide: true, encoding: 'utf8' }).stdout ?? '').split(/\s+/),
    ...(process.env.TRUSS_SCRUB_NAMES ?? '').split(','),
  ].filter((n) => n.length >= 4)
  const bundle = readWave4Run().files
  const texts: [string, string][] = [...Object.entries(bundle), ['wave4-git.json', readFileSync(path.join(FIX, 'wave4-git.json'), 'utf8')]]
  for (const [name, text] of texts) {
    assert.deepEqual(scrub(text, names), [], `${name}: scrub hit`)
    assert.doesNotMatch(text, UUID, `${name}: uuid-shaped id`)
    assert.doesNotMatch(text, /\/(?:home|Users)\/(?!<name>)/, `${name}: posix home path`)
    assert.doesNotMatch(text, /[A-Za-z]:\\{1,2}Users\\/i, `${name}: windows home path`)
  }
  const cli = path.join(HERE, '..', 'retro', 'cli.ts')
  const r = spawnSync(process.execPath, [cli, 'scrub', path.join(FIX, 'wave4-run.json'), path.join(FIX, 'wave4-git.json')], { windowsHide: true, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('retro-generic fixture: the bundle keeps wave 4 counts of events, usage lines and crews', () => {
  const f = readWave4Run().files
  assert.equal(lines(f['events.jsonl']!), 1981)
  assert.equal(lines(f['usage.jsonl']!), 5900)
  for (const k of ['decisions.md', 'plan.json']) assert.ok(k in f, `${k} is in the bundle`)
  const crews = new Set(Object.keys(f).filter((k) => k.startsWith('crews/')).map((k) => k.split('/')[1]))
  assert.equal(crews.size, 6)
  assert.ok(Object.keys(f).some((k) => /^stage-result-.*\.json$/.test(k)))
  assert.ok(Object.keys(f).some((k) => /^checks\/.*\.json$/.test(k)))
  for (const [k, text] of Object.entries(f)) if (/^reports\/.*-qc.*\.md$/.test(k)) assert.ok(lines(text) <= 1, `${k} is cut to its first line`)
  const first = JSON.parse(f['events.jsonl']!.split('\n')[0]!)
  assert.match(first.ts, /^2026-11-12T12:19:38\.734Z$/)
})

test('retro-generic fixture: loadWave4 builds a repo whose git log holds the recorded commits', { timeout: 280_000 }, () => {
  const data = readWave4Git()
  assert.ok(data.commits.length > 0)
  const w = loadWave4()
  try {
    const run = (args: string[]): string => {
      const r = spawnSync('git', ['-c', 'core.quotepath=off', '-C', w.repo, ...args], { windowsHide: true, encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
      return r.stdout
    }
    assert.equal(run(['config', 'gc.auto']).trim(), '0')
    assert.equal(run(['config', 'maintenance.auto']).trim(), 'false')
    const log = run(['log', '--reverse', '--format=%cI%x09%s']).split('\n').filter((l) => l !== '')
    assert.equal(log.length, data.commits.length)
    assert.deepEqual(
      log.map((l) => l.slice(l.indexOf('\t') + 1)),
      data.commits.map((c) => c.subject),
    )
    const ms = (iso: string): number => Date.parse(iso)
    assert.deepEqual(
      log.map((l) => ms(l.slice(0, l.indexOf('\t')))),
      data.commits.map((c) => ms(c.ts)),
    )
    const last = Object.keys(data.sizes).find((p) => data.sizes[p]! > 0)!
    assert.equal(readFileSync(path.join(w.repo, last), 'utf8').split('\n').length - 1, data.sizes[last])
    assert.ok(readFileSync(path.join(w.dir, 'events.jsonl'), 'utf8').length > 0)
    assert.equal(path.basename(w.dir), 'sid-wave4')
    assert.equal(path.dirname(path.dirname(w.dir)), path.join(w.repo, '.git'))
  } finally {
    w.cleanup()
  }
})
