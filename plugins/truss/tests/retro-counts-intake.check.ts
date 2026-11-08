// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// Retro counts' per-goal `goals` key, truss ADR-0010 (mid-run intake) section 6 and line 87, plus the pm's
// `sweep keep|drop` log lines counted as ordinary decisions (truss 0.9.2). Ported from the Python
// test_contract_retro_intake.py and test_sweep_lines.py. Fixtures are built in a tempdir (plan.json and decisions.md)
// and the CLI is run by subprocess; only the printed JSON is checked. Expected counts are worked out by hand.
// Run with: node --test tests/retro-counts-intake.check.ts
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { mktmp, NR, retro, write } from './retro-counts-lib.ts'

const ENTRY_KEYS = ['id', 'goal', 'addedAt', 'crews', 'estAgents', 'status', 'decisions'].sort()

const GOALS = [
  { id: 'alpha', goal: 'add the alpha feature', addedAt: '2026-10-28T10:00:00Z', approval: 'auto', approvedAt: '2026-10-28T10:01:00Z' },
  { id: 'beta-two', goal: 'fix the beta bug', addedAt: '2026-10-28T11:30:00Z', approval: 'client', approvedAt: null },
]
// run: a, b, c (no goal, "run", non-string goal). alpha: d, e. beta-two: f.
const CREWS = [
  { slug: 'a', stage: 0, estAgents: 2, status: 'merged' },
  { slug: 'b', goal: 'run', stage: 0, estAgents: 3, status: 'merged' },
  { slug: 'c', goal: 5, stage: 1, estAgents: 1 },
  { slug: 'd', goal: 'alpha', stage: 0, estAgents: 4, status: 'merged' },
  { slug: 'e', goal: 'alpha', stage: 1, estAgents: 5, status: 'running' },
  { slug: 'f', goal: 'beta-two', stage: 0, estAgents: 6 },
]

const plan = (goals: unknown = null, crews: unknown = null, version = 3) => {
  const p: Record<string, unknown> = {
    version, goal: 'ship the thing', approval: 'client', approvedAt: '2026-10-27T09:00:00Z',
    agentCap: 10, reworkAllowance: 2, crews: crews ?? CREWS,
  }
  if (goals !== null) p.goals = goals
  return p
}
const line = (text: string, hhmm = '10:00') => `- ${hhmm} | ${text} | because | checker: none | followed\n`

let tmp: string
beforeEach(() => {
  tmp = mktmp('retro-intake-')
})

const run = (planObj: unknown, decisions: string) => {
  const d = join(tmp, 'session')
  if (planObj !== null) write(d, 'plan.json', JSON.stringify(planObj))
  write(d, 'decisions.md', `# Decisions\n${decisions}`)
  return retro(d)
}
const goalsById = (out) => {
  assert.ok('goals' in out)
  assert.ok(Array.isArray(out.goals))
  return Object.fromEntries(out.goals.map((g) => [g.id, g]))
}
const tuple = (g) => [g.crews, g.estAgents, g.status]

describe('entries', () => {
  test('run first, then plan goals in order', () => {
    assert.deepEqual(run(plan(GOALS), line('untagged')).goals.map((g) => g.id), ['run', 'alpha', 'beta-two'])
  })

  test('every entry has exactly the seven keys', () => {
    const out = run(plan(GOALS), line('untagged'))
    assert.ok('goals' in out)
    for (const g of out.goals) assert.deepEqual(Object.keys(g).sort(), ENTRY_KEYS, g.id)
  })

  test('the run entry goal and addedAt', () => {
    const g = goalsById(run(plan(GOALS), '')).run
    assert.equal(g.goal, 'ship the thing')
    assert.equal(g.addedAt, NR)
  })

  test('plan goal entries take goal and addedAt from the plan', () => {
    const by = goalsById(run(plan(GOALS), ''))
    assert.equal(by.alpha.goal, 'add the alpha feature')
    assert.equal(by.alpha.addedAt, '2026-10-28T10:00:00Z')
    assert.equal(by['beta-two'].goal, 'fix the beta bug')
    assert.equal(by['beta-two'].addedAt, '2026-10-28T11:30:00Z')
  })
})

describe('crews, estAgents, status', () => {
  test('per goal', () => {
    const by = goalsById(run(plan(GOALS), ''))
    assert.deepEqual(tuple(by.run), [3, 6, { merged: 2, unset: 1 }])
    assert.deepEqual(tuple(by.alpha), [2, 9, { merged: 1, running: 1 }])
    assert.deepEqual(tuple(by['beta-two']), [1, 6, { unset: 1 }])
  })

  test('goal absent, "run" and non-string all count to run', () => {
    const crews = [
      { slug: 'a', stage: 0, estAgents: 1, status: 'merged' },
      { slug: 'b', goal: 'run', stage: 0, estAgents: 1, status: 'merged' },
      { slug: 'c', goal: ['x'], stage: 0, estAgents: 1, status: 'merged' },
    ]
    const by = goalsById(run(plan(GOALS, crews), ''))
    assert.deepEqual(tuple(by.run), [3, 3, { merged: 3 }])
    assert.deepEqual(tuple(by.alpha), [0, 0, {}])
  })
})

describe('decisions', () => {
  test('count the last run only', () => {
    const log =
      '## Run 2026-10-27T09:00:00Z | first\n' +
      line('[alpha] early one') + line('[alpha] early two') + line('[beta-two] early') + line('untagged early') +
      '## Run 2026-10-28T09:00:00Z | second\n' +
      line('[alpha] late one') + line('[beta-two] late one') + line('[beta-two] late two') +
      line('[beta-two] late three') + line('untagged late')
    const by = goalsById(run(plan(GOALS), log))
    assert.equal(by.alpha.decisions, 1)
    assert.equal(by['beta-two'].decisions, 3)
    assert.equal(by.run.decisions, 1)
  })

  test('no heading counts the whole log', () => {
    const log = line('[alpha] one') + line('[alpha] two') + line('[beta-two] three') + line('plain')
    const by = goalsById(run(plan(GOALS), log))
    assert.equal(by.alpha.decisions, 2)
    assert.equal(by['beta-two'].decisions, 1)
    assert.equal(by.run.decisions, 1)
  })

  test('an unknown tag and untagged count to run', () => {
    const log = line('[ghost] unknown id') + line('[other-thing] also unknown') + line('no tag') + line('[alpha] known')
    const by = goalsById(run(plan(GOALS), log))
    assert.equal(by.run.decisions, 3)
    assert.equal(by.alpha.decisions, 1)
    assert.equal(by['beta-two'].decisions, 0)
  })

  test('malformed tags are untagged', () => {
    const log =
      line('[Alpha] upper case') + line('[alpha]no space') + line('[alpha-] trailing dash') +
      line('[-alpha] leading dash') + line('[alpha beta] inner space') + line('x [alpha] not first') +
      line('[alpha] good')
    const by = goalsById(run(plan(GOALS), log))
    assert.equal(by.alpha.decisions, 1)
    assert.equal(by.run.decisions, 6)
  })

  test('a run tag counts to run', () => {
    // `run` is the reserved id and never a plan goal; a [run] tag is not in the plan, so it is the run's.
    const by = goalsById(run(plan(GOALS), line('[run] explicit') + line('[alpha] a')))
    assert.equal(by.run.decisions, 1)
    assert.equal(by.alpha.decisions, 1)
  })

  test('entry decisions sum to the last run decisions total', () => {
    const log =
      '## Run 2026-10-27T09:00:00Z | first\n' + line('[alpha] x') +
      '## Run 2026-10-28T09:00:00Z | second\n' +
      line('[alpha] a') + line('[beta-two] b') + line('[ghost] c') + line('d')
    const out = run(plan(GOALS), log)
    assert.ok('goals' in out)
    assert.equal(out.goals.reduce((n, g) => n + g.decisions, 0), out.runs.at(-1).decisions.total)
  })
})

describe('absence', () => {
  test('no goals key without goals in the plan', () => {
    assert.ok(!('goals' in run(plan(null, null, 2), line('[alpha] x'))))
  })

  test('no goals key with an empty goals array', () => {
    assert.ok(!('goals' in run(plan([]), line('[alpha] x'))))
  })

  test('no goals key without a plan file', () => {
    assert.ok(!('goals' in run(null, line('[alpha] x'))))
  })
})

describe('sweep lines', () => {
  test('sweep lines count as followed decisions', () => {
    const d = join(tmp, 'sweep')
    write(
      d,
      'decisions.md',
      '## Run 2026-10-29T10:00:00Z | g\n' +
        '- 10:01 | sweep drop: README omits id | doc drift | checker-5 | followed\n' +
        '- 10:02 | sweep keep: remove_tree hides an OSError | a leak goes unseen | checker-5 | followed\n',
    )
    const r = retro(d).runs[0]
    assert.equal(r.decisions.total, 2)
    assert.equal(r.decisions.followed, 2)
    assert.equal(r.recommendations.total, 0)
    assert.equal(r.freeform, 0)
  })
})
