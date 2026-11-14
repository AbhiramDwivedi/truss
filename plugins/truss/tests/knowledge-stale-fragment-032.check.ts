// Bug I: a crew that shares a rule writes a fragment under `.claude/rules.d/<area>/<crew>.md` with its own `sources` and
// `verified`. knowledge-lint --base must treat a source the changed fragment re-checks as covered, not stale.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertOneLine, git, mkEnv, putFile } from './fixtures/workflow-run/harness.ts'

const t = (name, fn) => test(name, { timeout: 90000 }, fn)
const fm = (o) => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n')}\n---\n`
const FRAG = '.claude/rules.d/src/stage-events.md'
const RULE = '.claude/rules/src.md'
const commit = (repo, files, msg = 'edit') => {
  for (const [rel, text] of Object.entries(files)) putFile(repo, rel, text)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', msg])
  return git(repo, ['rev-parse', 'HEAD'])
}
// a repo whose rule lists src/a.ts and src/b.ts, with `extra` committed at base; returns the env and the base sha
function world(extra = {}) {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' }, files: { 'src/a.ts': 'export {}\n', 'src/b.ts': 'export {}\n', 'AGENTS.md': '# Index\n\n- `.claude/rules/src.md`\n' } })
  const base = commit(env.repo, { [RULE]: `${fm({ paths: ['src/**'], sources: ['src/a.ts', 'src/b.ts'], verified: git(env.repo, ['rev-parse', 'HEAD']) })}\n- a rule\n`, ...extra }, 'base')
  return { env, base }
}
const lintStale = (env, base) => {
  const r = env.run('knowledge-lint', {}, [`--base=${base}`])
  assert.equal(r.status === 0 || r.status === 1, true, r.stdout + r.stderr)
  return assertOneLine(r).failures.filter((f) => f.check === 'stale')
}

t('stale passes when a changed fragment of the rule re-checks the touched source', () => {
  const { env, base } = world()
  commit(env.repo, { 'src/a.ts': 'export const a = 1\n', 'src/b.ts': 'export const b = 1\n', [FRAG]: `${fm({ sources: ['src/a.ts', 'src/b.ts'], verified: base })}\n- crew note\n` })
  assert.deepEqual(lintStale(env, base), [])
})

t('stale still fails when the fragment does not list the touched source', () => {
  const { env, base } = world()
  commit(env.repo, { 'src/a.ts': 'export const a = 1\n', 'src/b.ts': 'export const b = 1\n', [FRAG]: `${fm({ sources: ['src/a.ts'], verified: base })}\n- crew note\n` })
  const f = lintStale(env, base)
  assert.equal(f.length, 1)
  assert.equal(f[0].path, RULE)
  assert.match(f[0].message, /changed in this diff but `verified` did not/)
})

t("stale still fails when the fragment's verified did not change", () => {
  const { env, base } = world({ [FRAG]: `${fm({ sources: ['src/a.ts', 'src/b.ts'], verified: 'abc1234' })}\n- crew note\n` })
  commit(env.repo, { 'src/a.ts': 'export const a = 1\n', [FRAG]: `${fm({ sources: ['src/a.ts', 'src/b.ts'], verified: 'abc1234' })}\n- crew note, edited\n` })
  assert.deepEqual(lintStale(env, base).map((f) => f.path), [RULE])
})
