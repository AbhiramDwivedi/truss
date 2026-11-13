// @ts-nocheck
// Truss 0.29.0, hygiene: R-96 (inbox timing test not flaky), R-97 (citations by symbol or tolerant of drift), R-98 (5.5 prices).
// The acceptance test greps the case titles below; do not reword them.
//
// Run with: node --test tests/hygiene-029.check.ts
// The load case runs only when TRUSS_HYGIENE_LOAD_RUNS is set (the acceptance test sets it to 20).

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { REAL_FACTORY, mkRepo, mkTrussDir, runCli, tmp } from './fixtures/workflow-run/harness.ts'
import { citationFailures } from './release-026.check.ts'

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(PLUGIN, '..', '..')
const flat = (p) => String(p).replace(/\\/g, '/')

// ---- R-97: line citations -------------------------------------------------------------------------------------------
const storeLine = () => {
  const n = readFileSync(path.join(PLUGIN, 'bin', 'store.ts'), 'utf8').split('\n').findIndex((l) => /^const OWNERLESS_MS\b/.test(l)) + 1
  assert.ok(n > 0, 'OWNERLESS_MS is gone from store.ts')
  return n
}

test('a citation that names its symbol still resolves after the cited lines move', () => {
  const real = storeLine()
  const moved = real + 40 // the symbol's lines drifted: the citation's number is stale, its name is right
  assert.deepEqual(citationFailures('seed', `A lock with no owner counts as stale after 3 s (\`OWNERLESS_MS\`, \`bin/store.ts:${moved}\`).`), [], 'a moved citation that names its symbol must not fail')
  assert.deepEqual(citationFailures('seed', `A lock with no owner counts as stale after 3 s (\`OWNERLESS_MS\`, \`bin/store.ts:${real}\`).`), [], 'the right line still passes')
})

test('a citation whose symbol is gone still fails the release check', () => {
  const real = storeLine()
  const gone = citationFailures('seed', `A lock with no owner counts as stale (\`NO_SUCH_SYMBOL_HYGIENE\`, \`bin/store.ts:${real}\`).`)
  assert.equal(gone.length, 1, 'a symbol that is in no line of the file must fail')
  assert.match(gone[0], /NO_SUCH_SYMBOL_HYGIENE/)
  const moved = citationFailures('seed', `A lock with no owner counts as stale (\`NO_SUCH_SYMBOL_HYGIENE\`, \`bin/store.ts:${real + 40}\`).`)
  assert.equal(moved.length, 1, 'a moved citation to a missing symbol must fail too')
})

function docFiles() {
  const out = []
  const list = (dir, re) => {
    const d = path.join(ROOT, dir)
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) if (e.isFile() && re.test(e.name)) out.push(flat(`${dir}/${e.name}`))
  }
  list('plugins/truss/docs', /\.md$/) // not docs/adr/: historic ADR citations are a non-goal
  for (const e of readdirSync(path.join(ROOT, 'plugins/truss/skills'), { withFileTypes: true })) {
    if (e.isDirectory() && existsSync(path.join(ROOT, 'plugins/truss/skills', e.name, 'SKILL.md'))) out.push(`plugins/truss/skills/${e.name}/SKILL.md`)
  }
  out.push('plugins/truss/README.md', 'docs/features.md')
  list('docs/knowledge', /\.md$/)
  return out
}

test('every path:line citation in the plugin docs and skills resolves on this tree', () => {
  const docs = docFiles()
  assert.ok(docs.length > 10, `found only ${docs.length} docs`)
  const fails = docs.flatMap((d) => citationFailures(d, readFileSync(path.join(ROOT, d), 'utf8').replace(/\r/g, '')))
  assert.deepEqual(fails, [], `${fails.length} citation(s) do not resolve:\n${fails.join('\n')}`)
})

// ---- R-96: the whole inbox.check.ts file under CPU load ---------------------------------------------------------------
const LOAD_RUNS = Number(process.env.TRUSS_HYGIENE_LOAD_RUNS ?? 0)
test('inbox.check.ts passes 20 of 20 consecutive whole-file runs under artificial CPU load', { skip: LOAD_RUNS > 0 ? false : 'set TRUSS_HYGIENE_LOAD_RUNS=20 to run', timeout: 4 * 60 * 60 * 1000 }, async () => {
  const busy = []
  try {
    for (let i = 0; i < os.cpus().length; i++) busy.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true }))
    assert.ok(busy.every((c) => typeof c.pid === 'number'), 'the busy-loop children started')
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    // One run is ~36 s on an idle host and the acceptance command is one call capped at 600 s, so the runs go in waves of WAVE
    // concurrent whole-file runs: the load is the busy loops plus the other runs of the wave, heavier than one run alone.
    const WAVE = 5
    const runOnce = (run: number) => new Promise<void>((resolve, reject) => {
      const c = spawn(process.execPath, ['--test', path.join(PLUGIN, 'tests', 'inbox.check.ts')], { cwd: ROOT, env, windowsHide: true })
      let out = ''
      c.stdout.on('data', (d) => { out += d })
      c.stderr.on('data', (d) => { out += d })
      c.on('error', reject)
      c.on('close', (status, signal) => (status === 0 ? resolve() : reject(new Error(`inbox.check.ts failed on run ${run} of ${LOAD_RUNS} under load (status ${status}, signal ${signal}):\n${out.split('\n').slice(-60).join('\n')}`))))
    })
    for (let first = 1; first <= LOAD_RUNS; first += WAVE) {
      await Promise.all(Array.from({ length: Math.min(WAVE, LOAD_RUNS - first + 1) }, (_, i) => runOnce(first + i)))
    }
  } finally {
    for (const c of busy) {
      try { process.kill(c.pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
})

// ---- R-98: the Claude 5.5 family is priced ----------------------------------------------------------------------------
test('factory cost prices claude-opus-5-5, claude-sonnet-5-5 and claude-haiku-5-5 usage rows with nothing unpriced', () => {
  const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] // named here, never derived from the config
  const repoCfg = JSON.parse(readFileSync(path.join(ROOT, '.claude', 'truss.json'), 'utf8'))
  const config = { architecture: 'docs/architecture.md', adr: 'docs/adr', ...(repoCfg.pricing === undefined ? {} : { pricing: structuredClone(repoCfg.pricing) }) }
  const repo = realpathSync(mkRepo({ config }))
  const dir = realpathSync(mkTrussDir())
  const root = realpathSync(tmp('hygiene-tr-'))
  try {
    const sid = path.basename(dir)
    mkdirSync(`${root}/-work-proj`, { recursive: true })
    const file = `${root}/-work-proj/${sid}.jsonl`
    writeFileSync(file, '')
    MODELS.forEach((model, i) => {
      const usage = { input_tokens: 1000000, output_tokens: 500000, cache_read_input_tokens: 1000000, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, server_tool_use: { web_search_requests: 0 }, speed: 'standard' }
      appendFileSync(file, `${JSON.stringify({ type: 'assistant', timestamp: `2026-11-10T06:00:0${i}.000Z`, message: { id: `msg_h${i}`, model, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage } })}\n`)
    })
    const r = runCli(REAL_FACTORY, 'cost', ['--dir', dir, '--repo', repo], repo, { TRUSS_TRANSCRIPTS_ROOT: root })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.deepEqual(r.json?.unpriced, [], `unpriced models: ${JSON.stringify(r.json?.unpriced)}`)
    assert.equal(typeof r.json?.session?.usd, 'number', `session usd is ${JSON.stringify(r.json?.session?.usd)}`)
    assert.ok(r.json.session.usd > 0)
  } finally {
    for (const p of [repo, dir, root]) rmSync(p, { recursive: true, force: true })
  }
})

// ---- QC findings: stale knowledge text and stale retro citations (regression cases) -----------------------------------
test('product-decisions.md does not call the Haiku 5.5 prompt tier inexpressible while the config prices it', () => {
  const cfg = JSON.parse(readFileSync(path.join(ROOT, '.claude', 'truss.json'), 'utf8'))
  const tier = cfg.pricing?.['claude-haiku-5-5']?.longContext
  assert.ok(tier && tier.abovePromptTokens === 100000, 'the repo config prices the Haiku 5.5 tier through longContext')
  const text = readFileSync(path.join(ROOT, 'docs', 'knowledge', 'product-decisions.md'), 'utf8')
  const line = text.split('\n').find((l) => l.startsWith('- Pricing:')) ?? ''
  assert.ok(line, 'the Pricing line exists')
  assert.doesNotMatch(line, /cannot express|known limit/, 'the Pricing line still says the tier cannot be expressed')
  assert.doesNotMatch(line, /derived from the general 0\.1x rule|lists no per-model write price/, 'the Pricing line contradicts features.md, which takes the rates from the claude-api skill pricing page')
})

test('retro SKILL.md cites typedText and OUTPUT_TAG at the lines they have in bin/inbox.ts', () => {
  const src = readFileSync(path.join(PLUGIN, 'bin', 'inbox.ts'), 'utf8').split('\n')
  const at = (re) => src.findIndex((l) => re.test(l)) + 1
  const fnLine = at(/^function typedText\b/)
  const tagLine = at(/^const OUTPUT_TAG\b/)
  assert.ok(fnLine > 0 && tagLine > 0, 'typedText and OUTPUT_TAG exist in inbox.ts')
  const skill = readFileSync(path.join(PLUGIN, 'skills', 'retro', 'SKILL.md'), 'utf8')
  const fn = /`typedText` in `bin\/inbox\.ts:(\d+)(?:-(\d+))?`/.exec(skill)
  const tag = /`OUTPUT_TAG`, `bin\/inbox\.ts:(\d+)`/.exec(skill)
  assert.ok(fn && tag, 'the retro skill cites both symbols with a bin/inbox.ts line')
  assert.ok(Number(fn[1]) <= fnLine && fnLine <= Number(fn[2] ?? fn[1]), `typedText is at ${fnLine}, the skill cites ${fn[1]}-${fn[2] ?? fn[1]}`)
  assert.equal(Number(tag[1]), tagLine, `OUTPUT_TAG is at ${tagLine}, the skill cites ${tag[1]}`)
})
