// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0026 items 45, 47, 52 and 57 (crew agents-fixes5): the monitor step rule read as behaviour,
// the acceptance-test and send-back wording, and the stress engineer's scratch rule.
// Agent and skill files are read relative to import.meta.url, so a base-copy run reads the base text.
//
// Run with: node --test tests/factory-fixes5-agents.check.ts
//
// THE EVALUATOR (monitorStep below) reads agents/resource-monitor.md. Builder: write the text to these phrasings.
// A "block" is a bullet or numbered line plus its continuation lines, up to the next bullet, numbered line or
// blank line. The "Go down one" block is the block holding the words `Go down one`; the "Go up one" block holds
// `Go up one`. Backticks are ignored everywhere.
//  1. Multiplier of minFreeMB, in each of the two blocks, first match wins. Accepted, directly before `minFreeMB`:
//       `twice`                       (2)
//       `<word> times`                (one, two, three, four, five, six, ten)
//       `<number> times`              (3 times, 2.5 times)
//       `<number> x` or `<number> ×` or `<number> *`   (3 x, 3x, 3 *)
//     and, after it, `minFreeMB x <number>` / `minFreeMB * <number>` / `minFreeMB × <number>`.
//     So "above three times minFreeMB (3 x, 6144 MB at the default)" reads as 3. No multiplier in a block: the
//     evaluator throws, and every case that needs it fails.
//  2. Down conditions on the "Go down one" block: freeMB below the multiplier x minFreeMB; load1 above cpus
//     (the block names `load1` and `cpus`); and the pressure bars. A bar is the first number found within 60
//     characters after the word `memPressure` (or `swapUsedPct`) in that block, e.g. "`memPressure`, where
//     present, is above 10, or `swapUsedPct`, where present, is above 70". Down fires when the field is present
//     and strictly above the bar. The bar search for one field stops where the other field's name begins.
//  3. Up conditions on the "Go up one" block: freeMB strictly above the multiplier x minFreeMB, and load1, where
//     present, below half of cpus. The pressure guard is read from the same block: it must name both
//     `memPressure` and `swapUsedPct` (bars from the first number after each name when given, else the bars of
//     the "Go down one" block), or say `neither of those` / `none of those` / `neither of the down conditions`
//     / `no down condition` (then the down bars apply). With a guard, up needs memPressure <= its bar and
//     swapUsedPct <= its bar, absent fields skipping the condition. A block with no guard lets pressure through,
//     so i57 6 fails.
//  4. The i38 hold is applied by the evaluator as the text states it: no step down while running exceeds the
//     current value. The up rule ignores running.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const agentText = (name) => readFileSync(new URL(`../agents/${name}.md`, import.meta.url), 'utf8')
const SKILL = readFileSync(new URL('../skills/run/SKILL.md', import.meta.url), 'utf8')

// ---- the evaluator ----

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10 }
const NUM = '(\\d+(?:\\.\\d+)?)'

function block(text, marker) {
  const lines = text.replace(/`/g, '').split('\n')
  const at = lines.findIndex((l) => l.includes(marker))
  assert.ok(at >= 0, `resource-monitor.md has no "${marker}" line`)
  const out = [lines[at]]
  for (let i = at + 1; i < lines.length; i++) {
    if (/^\s*$/.test(lines[i]) || /^\s*(-|\*|\d+\.)\s/.test(lines[i])) break
    out.push(lines[i])
  }
  return out.join(' ')
}

function multiplier(b, which) {
  const before = new RegExp(`(twice|\\b(one|two|three|four|five|six|ten|${NUM}) times|\\b${NUM} ?[x×*])\\s*(?:the\\s+)?minFreeMB`, 'i').exec(b)
  const after = new RegExp(`minFreeMB\\s*[x×*]\\s*${NUM}`, 'i').exec(b)
  let m = null
  if (before && (!after || before.index <= after.index)) {
    const w = before[1].toLowerCase()
    if (w === 'twice') m = 2
    else if (before[2] && WORDS[before[2].toLowerCase()] !== undefined) m = WORDS[before[2].toLowerCase()]
    else m = Number(before[3] ?? before[4] ?? NaN)
  } else if (after) m = Number(after[1])
  assert.ok(Number.isFinite(m) && m > 0, `the "${which}" block states no multiplier of minFreeMB: ${b}`)
  return m
}

function bar(b, name, other) {
  const at = b.indexOf(name)
  if (at < 0) return null
  let seg = b.slice(at + name.length, at + name.length + 60)
  const cut = seg.indexOf(other)
  if (cut >= 0) seg = seg.slice(0, cut)
  const m = new RegExp(NUM).exec(seg)
  return m ? Number(m[1]) : null
}

function rules() {
  const text = agentText('resource-monitor')
  const dn = block(text, 'Go down one')
  const up = block(text, 'Go up one')
  const downBars = { mem: bar(dn, 'memPressure', 'swapUsedPct'), swap: bar(dn, 'swapUsedPct', 'memPressure') }
  let guard = null
  if (/memPressure/.test(up) && /swapUsedPct/.test(up)) {
    guard = { mem: bar(up, 'memPressure', 'swapUsedPct') ?? downBars.mem, swap: bar(up, 'swapUsedPct', 'memPressure') ?? downBars.swap }
  } else if (/\b(neither of (those|the down)|none of those|no down condition)/i.test(up)) guard = { ...downBars }
  return { down: multiplier(dn, 'Go down one'), up: multiplier(up, 'Go up one'), downBars, guard }
}

// r = { freeMB, minFreeMB, cpus, load1?, memPressure?, swapUsedPct?, running, cur, max }
function monitorStep(r) {
  const k = rules()
  const hasPressureBars = k.downBars.mem !== null && k.downBars.swap !== null
  const pressureDown =
    hasPressureBars && ((r.memPressure !== undefined && r.memPressure > k.downBars.mem) || (r.swapUsedPct !== undefined && r.swapUsedPct > k.downBars.swap))
  const downFires = r.freeMB < k.down * r.minFreeMB || (r.load1 !== undefined && r.load1 > r.cpus) || pressureDown
  const guardOk = k.guard
    ? !((r.memPressure !== undefined && k.guard.mem !== null && r.memPressure > k.guard.mem) || (r.swapUsedPct !== undefined && k.guard.swap !== null && r.swapUsedPct > k.guard.swap))
    : true
  const upFires = r.freeMB > k.up * r.minFreeMB && (r.load1 === undefined || r.load1 < r.cpus / 2) && guardOk
  const down = downFires && !(r.running > r.cur)
  let next = r.cur
  if (down) next = Math.max(1, r.cur - 1)
  else if (upFires && !downFires) next = Math.min(r.max, r.cur + 1)
  return { next, downFires, upFires, rules: k }
}

const MIN = 2048
const reading = (o) => ({ minFreeMB: MIN, cpus: 4, running: 0, cur: 1, max: 4, ...o })

// ---- i45 ----

test('i45 1: freeMB 3.5 x minFreeMB with load1 below cpus/2 goes up one', () => {
  const r = monitorStep(reading({ freeMB: 3.5 * MIN, load1: 0.5, cur: 1 }))
  assert.equal(r.next, 2)
  assert.equal(r.rules.up, 3, 'the up multiplier is three')
})

test('i45 2: each logged idle reading goes up from 1', () => {
  for (const [freeMB, load1] of [[8189, 0.49], [8152, 0.68], [8178, 1.5]]) {
    const r = monitorStep(reading({ freeMB, load1, cur: 1, running: 0 }))
    assert.equal(r.next, 2, `freeMB ${freeMB} load1 ${load1} did not go up`)
  }
})

test('control 1: i45 freeMB 2.5 x minFreeMB with low load keeps the value (between the down and up points)', () => {
  const r = monitorStep(reading({ freeMB: 2.5 * MIN, load1: 0.2, cur: 2 }))
  assert.equal(r.next, 2)
  assert.equal(r.downFires, false)
})

// ---- i57 (monitor rule) ----

test('i57 5: the monitor steps down on memPressure 12 with plenty of free memory, and on swapUsedPct 75', () => {
  const k = rules()
  assert.equal(k.downBars.mem, 10, 'the memPressure bar on the Go down one line is 10')
  assert.equal(k.downBars.swap, 70, 'the swapUsedPct bar on the Go down one line is 70')
  const idle = { freeMB: 20000, load1: 0.1, cur: 3, running: 0 }
  assert.equal(monitorStep(reading({ ...idle, memPressure: 12 })).next, 2)
  assert.equal(monitorStep(reading({ ...idle, swapUsedPct: 75 })).next, 2)
  // strictly above the bar; absent fields skip the conditions
  assert.equal(monitorStep(reading({ ...idle, memPressure: 10, swapUsedPct: 70 })).downFires, false)
  assert.equal(monitorStep(reading(idle)).downFires, false)
  // the i38 hold still applies to the pressure down conditions
  assert.equal(monitorStep(reading({ ...idle, memPressure: 12, running: 5 })).next, 3)
})

test('i57 6: memPressure 12 blocks an up step that freeMB and load alone would allow', () => {
  const idle = { freeMB: 20000, load1: 0.1, cur: 1, running: 0 }
  const plain = monitorStep(reading(idle))
  assert.equal(plain.upFires, true, 'without pressure the same reading goes up')
  assert.equal(monitorStep(reading({ ...idle, memPressure: 12 })).upFires, false, 'memPressure 12 must block the up step')
  assert.equal(monitorStep(reading({ ...idle, swapUsedPct: 75 })).upFires, false, 'swapUsedPct 75 must block the up step')
  assert.equal(monitorStep(reading({ ...idle, memPressure: 5, swapUsedPct: 20 })).upFires, true)
})

// ---- i47 ----

test('i47 1: design-engineer.md says an acceptance test pins behaviour by a title and its ok or not-ok outcome, or an assertion result, and never greps literal text', () => {
  const text = agentText('design-engineer')
  const lines = text.split('\n').filter((l) => /literal text/i.test(l))
  assert.ok(lines.length > 0, 'no line speaks of the literal text of a file')
  const ok = lines.some(
    (l) => /\bnever\b[^.\n]*\bgreps?\b/i.test(l) && /\btitles?\b/i.test(l) && /\bnot[ -]ok\b/i.test(l) && /\bassertion/i.test(l) && /\b(source|test) file/i.test(l),
  )
  assert.ok(ok, `no single line gives the full rule: ${lines.join(' | ')}`)
})

test('i47 2: checking-engineer.md names a spelling pin as a reason to send the plan back', () => {
  const text = agentText('checking-engineer')
  const ok = text.split('\n').some((l) => /\bspelling\b/i.test(l) && /\bpins?\b/i.test(l) && /\b(send|sends|sent)\b[^.\n]{0,40}\bback\b/i.test(l))
  assert.ok(ok, 'no line names a spelling pin beside sending the plan back')
})

test('i47 3: skills/run/SKILL.md gives the spelling-pin send-back reason beside "gameable", in the step 3 sentence and in the review paragraph', () => {
  const lines = SKILL.split('\n')
  const near = (l) => {
    const g = l.search(/gameable/i)
    if (g < 0) return false
    return [...l.matchAll(/spelling/gi)].some((m) => Math.abs(m.index - g) < 250)
  }
  const step3 = lines.find((l) => /^3\. Run `Workflow\(\{ scriptPath/.test(l) && /Workflow\(plan\.js\)/.test(l))
  const review = lines.find((l) => /^Send the plan back only|Send the plan back only for a gameable/.test(l) || /Send the plan back only for a gameable/.test(l))
  assert.ok(step3 && review, 'the step 3 sentence or the review paragraph moved')
  assert.ok(/gameable/.test(SKILL), '"gameable" stays')
  assert.ok(near(step3), 'the step 3 sentence has no spelling pin beside "gameable"')
  assert.ok(near(review), 'the review paragraph has no spelling pin beside "gameable"')
})

// ---- i52 ----

test('i52 1: stress-engineer.md puts every probe and fixture in its own fresh mkdtemp directory, nothing at a fixed name in the shared scratchpad, and overwrites no file it did not create', () => {
  const text = agentText('stress-engineer')
  assert.match(text, /\bfresh\b[^\n]{0,60}mkdtemp|mkdtemp[^\n]{0,60}\bfresh\b/i, 'every probe and fixture goes in a fresh mkdtemp directory')
  assert.match(text, /\bfixed (name|path|file name)/i, 'nothing goes at a fixed name in the shared scratchpad')
  assert.match(text, /scratchpad/i)
  assert.match(text, /overwrit\w*[^\n]{0,60}(didn't|did not|have not|haven't) create|(didn't|did not) create[^\n]{0,60}overwrit/i, 'it overwrites no file it did not create')
})

// ---- i52 controls: the trussFile seams, passing on base ----

const REGISTER = new URL('../hooks/register.ts', import.meta.url)
const REAL_STAGE = fileURLToPath(new URL('../workflows/stage.js', import.meta.url))
const ROLES = {
  designer: { agentType: 'truss:design-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  checker: { agentType: 'truss:checking-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  planner: { agentType: 'truss:planning-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  tester: { agentType: 'general-purpose', model: 'sonnet', effort: 'medium', isolation: 'worktree' },
  builder: { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'worktree' },
  resolver: { agentType: 'general-purpose', model: 'sonnet', effort: 'medium', isolation: 'none' },
  writer: { agentType: 'truss:writer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  rca: { agentType: 'general-purpose', model: 'opus', effort: 'medium', isolation: 'none' },
  stress: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  qc: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  runner: { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'none' },
}
const stageTruss = () => ({ kind: 'stage', roles: ROLES, crews: [{ slug: 'a' }] })
const runningPlan = (version) => ({
  version, goal: 'g', approval: 'auto', approvedAt: '2026-10-29T00:00:00Z', maxParallelCrews: 4, reworkAllowance: 2,
  crews: [{ slug: 'a', stage: 1, status: 'running', verdict: 'extend' }],
})

async function withDir(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fixes5-agents-')))
  try {
    await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('control 2: i52 expandTrussFile accepts a trussFile given through a symlinked spelling of the truss dir', async () => {
  const mod = await import(REGISTER.href)
  await withDir(async (root) => {
    const truss = join(root, 'truss')
    mkdirSync(truss)
    const link = join(root, 'link')
    // 'junction' on Windows: a directory link that needs no symlink privilege; the type is ignored elsewhere
    symlinkSync(truss, link, 'junction')
    writeFileSync(join(truss, 'a.json'), JSON.stringify({ truss: stageTruss() }))
    const read = (p) => readFileSync(p, 'utf8')
    // the truss dir and the trussFile use the same symlinked spelling
    const viaLink = await mod.expandTrussFile({ trussFile: join(link, 'a.json') }, link, read)
    assert.equal(viaLink.deny, undefined, viaLink.deny)
    assert.deepEqual(viaLink.args.truss, stageTruss())
  })
})

test('control 3: i52 the handler expands a trussFile for stage.js under a version-1 plan', async () => {
  const mod = await import(REGISTER.href)
  await withDir(async (root) => {
    const common = join(root, 'git')
    const sessionId = 's1'
    const truss = mod.trussDir(common, undefined, sessionId)
    mkdirSync(truss, { recursive: true })
    writeFileSync(mod.planPath(truss), JSON.stringify(runningPlan(1)))
    const $ = {
      process: { run: async () => ({ exitCode: 0, stdout: `${common}\n`, stderr: '' }) },
      session: { cwd: async () => root, id: async () => sessionId },
      env: { get: async () => undefined },
      clock: { after: () => ({ cancel() {} }) },
      ui: { log: () => {} },
      fs: {
        exists: async (p) => existsSync(p),
        read: async (p) => readFileSync(p, 'utf8'),
        stat: async (p) => ({ realPath: realpathSync(p) }),
        write: async () => {},
      },
      state: { get: async () => ({ value: undefined, version: 0 }), set: async () => ({ isSet: true, version: 1 }) },
    }
    let handler
    const on = (...a) => {
      if (a[1] && typeof a[1] === 'object' && a[1].tool === 'Workflow') handler = a[a.length - 1]
      const chain = { catch: () => chain }
      return chain
    }
    mod.register(on)
    assert.ok(handler, 'the Workflow handler was not registered')
    const file = join(truss, 'stage-args.json')
    writeFileSync(file, JSON.stringify({ truss: stageTruss() }))
    const nexts = []
    const next = async (ev) => {
      nexts.push(ev)
      return { passed: ev }
    }
    const r = await handler($, { tool: 'Workflow', scriptPath: REAL_STAGE, args: { trussFile: file } }, next)
    assert.equal(r.deny, undefined, r.deny)
    assert.equal(nexts.length, 1)
    assert.deepEqual(nexts[0].args.truss, stageTruss())
    assert.ok(!('trussFile' in nexts[0].args))
  })
})
