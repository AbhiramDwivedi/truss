// @ts-nocheck
// truss ADR-0035, factory side: path-scoped knowledge. Written from the contract before the change.
//   1. the glob dialect (tests/fixtures/glob-vectors.json, shared with stage.js) and the frontmatter reader
//   2. `knowledge-lint`: dead-glob, bad-glob, missing-source, stale, unreachable, over-budget, persona-calls, always-loaded-calls;
//      --base, --slug (base, baseFallback, the worktree's config) and `new`
//   3. `knowledge-migrate` (dry run and --apply) and `rules-index`
//   4. the owns exemption gains the rules dir, the knowledge dir, the agents index and the product-decisions file
//   5. the stage-args keys (start, plan-args), the poPrompt line and the schema keys
// Run with: node --test tests/knowledge-lint.check.ts

import assert from 'node:assert/strict'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { globError, globMatch, globToRegExp, parseFrontmatter, countLines, featurePaths } from '../bin/knowledge.ts'
import { addCrewWorktree, assertOneLine, assertUsageError, crew, git, mkEnv, mkRepo, mkTrussDir, planObj, putFile, runCli, tmp, validate, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const t = (name, fn) => test(name, { timeout: 90000 }, fn)
const SCHEMA = JSON.parse(readFileSync(`${PLUGIN}/docs/truss-config.schema.json`, 'utf8'))

// ---------------------------------------------------------------- the glob dialect and the frontmatter reader

t('glob 1: the shared vectors hold (at least 25, covering **, *, ?, dotfiles, no-slash, trailing slash and non-ASCII)', () => {
  const vectors = JSON.parse(readFileSync(`${PLUGIN}/tests/fixtures/glob-vectors.json`, 'utf8'))
  assert.ok(vectors.length >= 25)
  for (const v of vectors) {
    assert.deepEqual(Object.keys(v).sort(), ['glob', 'match', 'path'])
    assert.equal(globMatch(v.glob, v.path), v.match, `${JSON.stringify(v.glob)} vs ${JSON.stringify(v.path)}`)
  }
  const globs = vectors.map((v) => v.glob).join('\n')
  for (const part of ['**/', '/**', '/**/', '?', '/.', '/\n', 'ファイル']) assert.ok(globs.includes(part) || /[^\x00-\x7f]/.test(globs), `vectors cover ${JSON.stringify(part)}`)
})

t('glob 2: a Windows path is matched as a posix one', () => {
  assert.equal(globMatch('src/**', 'src\\a\\b.ts'), true)
  assert.equal(globMatch('src\\*.ts', 'src\\a.ts'), true)
})

t('front 1: the reader takes inline and block lists, quoted strings, CRLF and a BOM; no block gives undefined', () => {
  const text = '\ufeff---\r\npaths:\r\n  - "src/**"\r\n  - lib/*.ts\r\nsources: [a/b.ts, "c d/e.ts"]\r\nverified: abc1234\r\nname: x\r\n---\r\nbody\r\n'
  const fm = parseFrontmatter(text)
  assert.deepEqual(fm.data, { paths: ['src/**', 'lib/*.ts'], sources: ['a/b.ts', 'c d/e.ts'], verified: 'abc1234', name: 'x' })
  assert.equal(fm.end, 8)
  assert.equal(parseFrontmatter('no block\n'), undefined)
  assert.equal(parseFrontmatter('---\nunclosed: 1\n'), undefined)
  assert.deepEqual(parseFrontmatter('---\nsources: [a.ts,\n  b.ts]\n---\n').data.sources, ['a.ts', 'b.ts'])
  assert.equal(countLines('a\r\nb\r\n'), 2)
  assert.equal(countLines('a\nb'), 2)
})

t('front 2: the feature-map path detector is conservative: a backticked token with a slash and an extension, nothing else', () => {
  const text = 'Entry `src/a.ts` and `bin/factory.ts <cmd>` and `node x/y.js` and `docs/` and `README.md` and `https://x.io/a.html` and `src/*.ts` and `/abs/p.ts` and `a/b.c`'
  assert.deepEqual(featurePaths(text), ['src/a.ts', 'a/b.c'])
})

// ---------------------------------------------------------------- knowledge-lint

const fm = (o) => `---\n${Object.entries(o).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n')}\n---\n`
const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n') + '\n'
const BASE_FILES = { 'src/a.ts': 'export {}\n', 'src/b/c.ts': 'export {}\n', 'AGENTS.md': '# Index\n\n- [auth](docs/knowledge/auth.md)\n- `.claude/rules/src.md`\n' }
const GOOD = {
  ...BASE_FILES,
  '.claude/rules/src.md': `${fm({ paths: ['src/**'], sources: ['src/a.ts'], verified: 'HEADSHA' })}\n- a rule\n`,
  'docs/knowledge/auth.md': `${fm({ sources: ['src/b'], verified: 'HEADSHA' })}\n# Auth\n`,
}
// a repo with `files` committed; `cfg` is .claude/truss.json
function world(files, cfg) {
  const env = mkEnv({ config: cfg ?? { merge: 'sequential', target: 'main' }, files })
  return env
}
const lint = (env, extra = []) => {
  const r = env.run('knowledge-lint', {}, extra)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  return assertOneLine(r)
}
const checks = (list) => list.map((f) => `${f.check}:${f.path}`).sort()
const CLEAN = { ok: true, failures: [], warnings: [], predatingCount: 0, warningCount: 0 }
const commit = (repo, files, msg = 'edit') => {
  for (const [rel, text] of Object.entries(files)) putFile(repo, rel, text)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', msg])
  return git(repo, ['rev-parse', 'HEAD'])
}
// the world with every verified sha replaced by the repo's real head
function goodWorld(over = {}, cfg) {
  const env = world(GOOD, cfg)
  const sha = git(env.repo, ['rev-parse', 'HEAD'])
  const files = { ...GOOD, ...over }
  for (const k of Object.keys(files)) files[k] = files[k] === null ? null : files[k].replaceAll('HEADSHA', sha)
  const changed = Object.fromEntries(Object.entries(files).filter(([k, v]) => v !== GOOD[k] && v !== null))
  if (Object.keys(changed).length || sha) commit(env.repo, Object.fromEntries(Object.entries({ ...files }).filter(([, v]) => v !== null)), 'good')
  return { env, sha, head: git(env.repo, ['rev-parse', 'HEAD']) }
}

t('lint 1: a clean layout is ok, with empty failures and warnings; the output is one JSON line and the exit is 0', () => {
  const { env } = goodWorld()
  const j = lint(env)
  assert.deepEqual(j, CLEAN)
})

t('lint 2: dead-glob fails a rule whose paths glob matches no tracked file, and passes a live one', () => {
  const { env } = goodWorld({ '.claude/rules/gone.md': `${fm({ paths: ['nothing/**', 'src/**'] })}\n- r\n`, 'AGENTS.md': '- `.claude/rules/src.md`\n- `.claude/rules/gone.md`\n- [auth](docs/knowledge/auth.md)\n' })
  const j = lint(env)
  assert.equal(j.ok, false)
  assert.deepEqual(checks(j.failures), ['dead-glob:.claude/rules/gone.md'])
  assert.match(j.failures[0].message, /nothing\/\*\*/)
  assert.ok(!j.failures[0].message.includes('src/**'))
})

t('lint 3: missing-source fails a sources path that is not tracked (a file, a directory prefix and a glob count when they match); untracked and uncommitted files are not tracked', () => {
  const { env } = goodWorld({
    '.claude/rules/src.md': `${fm({ paths: ['src/**'], sources: ['src/a.ts', 'src/b', 'src/**/*.ts', 'src/missing.ts', 'nowhere/*.ts'] })}\n- r\n`,
  })
  putFile(env.repo, 'src/untracked.ts', 'x\n')
  writeFileSync(`${env.repo}/docs/knowledge/auth.md`, `${fm({ sources: ['src/untracked.ts'], verified: 'x' })}\n# Auth\n`)
  const j = lint(env)
  assert.deepEqual(checks(j.failures), ['missing-source:.claude/rules/src.md', 'missing-source:.claude/rules/src.md', 'missing-source:docs/knowledge/auth.md'])
  const msgs = j.failures.map((f) => f.message).join('\n')
  assert.match(msgs, /src\/missing\.ts/)
  assert.match(msgs, /nowhere\/\*\.ts/)
  assert.match(msgs, /src\/untracked\.ts/)
  assert.ok(!/"src\/a\.ts"|"src\/b"/.test(msgs))
})

t('lint 4: missing-source also fails a backticked code path in the feature map that is not tracked; spaces, no extension, no slash and placeholders are ignored', () => {
  const map = '# Features\n\n## Auth\n\nEntry `src/a.ts`, `src/gone.ts`, run `node src/nope.js`, see `docs/`, `README.md`, `src/<x>.ts`.\n'
  const { env } = goodWorld({ 'docs/features.md': map })
  const j = lint(env)
  assert.deepEqual(checks(j.failures), ['missing-source:docs/features.md'])
  assert.match(j.failures[0].message, /src\/gone\.ts/)
  assert.ok(!/nope|<x>/.test(j.failures[0].message))
})

t('lint 5: unreachable fails a knowledge doc linked from neither the feature map nor the agents index, and a rule missing from the index; links are markdown links or backticked paths, relative or repo-relative', () => {
  const { env } = goodWorld({
    'docs/knowledge/lonely.md': `${fm({})}\n# L\n`,
    'docs/knowledge/viamap.md': `${fm({})}\n# M\n`,
    'docs/knowledge/viabacktick.md': `${fm({})}\n# B\n`,
    '.claude/rules/other.md': `${fm({ paths: ['src/**'] })}\n- r\n`,
    'docs/features.md': '# Features\n\n## X\n\nSee [map](knowledge/viamap.md) (relative to this file).\n',
    'AGENTS.md': '- [auth](docs/knowledge/auth.md)\n- `.claude/rules/src.md`\n- `docs/knowledge/viabacktick.md`\n',
  })
  const j = lint(env)
  assert.deepEqual(checks(j.failures), ['unreachable:.claude/rules/other.md', 'unreachable:docs/knowledge/lonely.md'])
})

t('lint 6: with no agents index, rule files are not checked for a listing; knowledge docs still need the feature map', () => {
  const { env } = goodWorld({ 'AGENTS.md': null, 'docs/features.md': '# F\n\n[auth](knowledge/auth.md)\n' })
  git(env.repo, ['rm', '-q', 'AGENTS.md'])
  git(env.repo, ['commit', '-q', '-m', 'rm index'])
  const j = lint(env)
  assert.deepEqual(j, CLEAN)
})

t('lint 7: over-budget fails the always-loaded files (agents index, persona, persona Standards, rule) past their budgets and passes at the budget; the message says how to fix it', () => {
  const persona = (n, standards) => `${fm({ name: 'dev', description: 'd', model: 'sonnet' })}\n## Standards\n\n${Array.from({ length: standards }, (_, i) => `- rule ${i}`).join('\n')}\n\n${n > 0 ? lines(n) : ''}`
  const at = goodWorld({
    'AGENTS.md': `- [auth](docs/knowledge/auth.md)\n- \`.claude/rules/src.md\`\n${lines(58)}`,
    '.claude/agents/dev.md': persona(0, 15),
    '.claude/rules/src.md': `${fm({ paths: ['src/**'] })}${lines(40 - 3)}`,
  })
  assert.equal(countLines(readFileSync(`${at.env.repo}/AGENTS.md`, 'utf8')), 60)
  assert.equal(countLines(readFileSync(`${at.env.repo}/.claude/rules/src.md`, 'utf8')), 40)
  assert.deepEqual(lint(at.env), CLEAN)

  const over = goodWorld({
    'AGENTS.md': `- [auth](docs/knowledge/auth.md)\n- \`.claude/rules/src.md\`\n${lines(59)}`,
    '.claude/agents/dev.md': persona(130, 16),
    '.claude/rules/src.md': `${fm({ paths: ['src/**'] })}${lines(38)}`,
  })
  const j = lint(over.env)
  assert.equal(j.ok, false)
  assert.deepEqual(checks(j.failures), ['over-budget:.claude/agents/dev.md', 'over-budget:.claude/agents/dev.md', 'over-budget:.claude/rules/src.md', 'over-budget:AGENTS.md'])
  const by = (p) => j.failures.filter((f) => f.path === p).map((f) => f.message).join(' | ')
  assert.match(by('AGENTS.md'), /61 lines, budget 60/)
  assert.match(by('.claude/rules/src.md'), /41 lines, budget 40/)
  assert.match(by('.claude/agents/dev.md'), /16 Standards items, budget 15/)
  assert.match(by('.claude/agents/dev.md'), /move area rules to \.claude\/rules\/<area>\.md/)
  assert.match(by('.claude/rules/src.md'), /fold entries into/)
})

t('lint 8: over-budget on a doc line count and on a feature entry is a warning, not a failure', () => {
  const entry = '## Big\n\nl1\nl2\nl3\nl4\nl5\nl6\n'
  const { env } = goodWorld({
    'docs/knowledge/auth.md': `${fm({})}${lines(150)}`,
    'docs/features.md': `# Features\n\n${entry}\n## Small\n\nok\n`,
  })
  const j = lint(env)
  assert.equal(j.ok, true)
  assert.deepEqual(checks(j.warnings), ['over-budget:docs/features.md', 'over-budget:docs/knowledge/auth.md'])
  assert.match(j.warnings.find((w) => w.path === 'docs/features.md').message, /"Big" is 7 lines, budget 6/)
})

t('lint 9: knowledgeBudgets in truss.json override the defaults, per key; a bad value falls back', () => {
  const { env } = goodWorld({ 'AGENTS.md': `- [auth](docs/knowledge/auth.md)\n- \`.claude/rules/src.md\`\n${lines(10)}` }, { merge: 'sequential', target: 'main', knowledgeBudgets: { agentsIndex: 8, rule: 'x', doc: 2 } })
  const j = lint(env)
  assert.deepEqual(checks(j.failures), ['over-budget:AGENTS.md'])
  assert.match(j.failures[0].message, /12 lines, budget 8/)
  assert.deepEqual(checks(j.warnings), ['over-budget:docs/knowledge/auth.md'].filter(() => countLines(readFileSync(`${env.repo}/docs/knowledge/auth.md`, 'utf8')) > 2))
})

t('lint 10: line counts tolerate CRLF (a CRLF file is not over budget by a stray CR, and counts the same as LF)', () => {
  const body = Array.from({ length: 60 }, (_, i) => (i === 0 ? '- [auth](docs/knowledge/auth.md)' : i === 1 ? '- `.claude/rules/src.md`' : `l${i}`)).join('\r\n') + '\r\n'
  const { env } = goodWorld({ 'AGENTS.md': body })
  assert.deepEqual(lint(env), CLEAN)
  const { env: env2 } = goodWorld({ 'AGENTS.md': body + 'extra\r\n' })
  assert.deepEqual(checks(lint(env2).failures), ['over-budget:AGENTS.md'])
})

t('lint 11: persona-calls fails a persona that holds product-call entries (a Product calls section, loose question entries) and points to knowledge-migrate; a pointer line alone passes', () => {
  const PERSONA = (body) => `${fm({ name: 'product-owner', description: 'd', model: 'sonnet' })}\n${body}`
  const bad = goodWorld({ '.claude/agents/product-owner.md': PERSONA('Judge fit.\n\n## Product calls\n\n- Q: skip login? A: yes. Reason: pilot. Decided by: PM\n- Q: export csv? A: no (overruled by main session)\n') })
  const j = lint(bad.env)
  assert.equal(j.ok, false)
  assert.deepEqual(checks(j.failures), ['persona-calls:.claude/agents/product-owner.md'])
  assert.match(j.failures[0].message, /factory knowledge-migrate/)
  assert.match(j.failures[0].message, /2 product-call entries/)
  const loose = goodWorld({ '.claude/agents/product-owner.md': PERSONA('## Domain\n\n- **Question:** keep history? -> yes\n') })
  assert.deepEqual(checks(lint(loose.env).failures), ['persona-calls:.claude/agents/product-owner.md'])
  const ok = goodWorld({ '.claude/agents/product-owner.md': PERSONA('Judge fit.\n\n## Standards\n\n- be strict\n\nProduct calls are recorded in `docs/knowledge/product-decisions.md`.\n') })
  assert.deepEqual(lint(ok.env), CLEAN)
})

t('lint 12: stale without --base is a warning: commits touched a source since verified; an unknown or missing verified is a warning too; a fresh doc is clean', () => {
  const { env, sha } = goodWorld()
  assert.deepEqual(lint(env), CLEAN)
  commit(env.repo, { 'src/b/c.ts': 'export const c = 1\n' })
  let j = lint(env)
  assert.equal(j.ok, true)
  assert.deepEqual(checks(j.warnings), ['stale:docs/knowledge/auth.md'])
  assert.match(j.warnings[0].message, /1 commit\(s\)/)
  commit(env.repo, { 'docs/knowledge/auth.md': `${fm({ sources: ['src/b'], verified: 'deadbeef00' })}\n# Auth\n`, '.claude/rules/src.md': `${fm({ paths: ['src/**'], sources: ['src/a.ts'] })}\n- a rule\n` })
  j = lint(env)
  assert.deepEqual(checks(j.warnings), ['stale:.claude/rules/src.md', 'stale:docs/knowledge/auth.md'])
  assert.match(j.warnings.find((w) => w.path === 'docs/knowledge/auth.md').message, /not a known commit/)
  assert.match(j.warnings.find((w) => w.path === '.claude/rules/src.md').message, /sources are set but `verified` is not/)
  assert.ok(sha)
})

t('lint 13: stale with --base is a failure when a source changed in base..HEAD and the doc verified did not; a changed verified or an untouched source passes', () => {
  const { env, head: base } = goodWorld()
  const head1 = commit(env.repo, { 'src/b/c.ts': 'export const c = 1\n', 'src/a.ts': 'export const a = 1\n' })
  let j = lint(env, [`--base=${base}`])
  assert.equal(j.ok, false)
  assert.deepEqual(checks(j.failures), ['stale:.claude/rules/src.md', 'stale:docs/knowledge/auth.md'])
  assert.deepEqual(j.failures.map((f) => f.new), [true, true])
  assert.deepEqual(j.warnings, [])
  commit(env.repo, { 'docs/knowledge/auth.md': `${fm({ sources: ['src/b'], verified: head1 })}\n# Auth\n` })
  j = lint(env, ['--base', base])
  assert.deepEqual(checks(j.failures), ['stale:.claude/rules/src.md'])
  commit(env.repo, { '.claude/rules/src.md': `${fm({ paths: ['src/**'], sources: ['src/a.ts'], verified: head1 })}\n- a rule\n` })
  assert.deepEqual(lint(env, [`--base=${base}`]), { ...CLEAN, base })
  const same = lint(env, [`--base=${git(env.repo, ['rev-parse', 'HEAD'])}`])
  assert.equal(same.ok, true)
})

t('lint 14: with --base every finding carries new: false when the same {check, path} already failed at base, true when the diff caused it; without --base new is true', () => {
  const { env, sha: base } = goodWorld({ '.claude/rules/src.md': `${fm({ paths: ['src/**', 'old/dead/**'] })}\n- r\n`, 'docs/knowledge/lonely.md': `${fm({})}\n# L\n` })
  const baseSha = git(env.repo, ['rev-parse', 'HEAD'])
  commit(env.repo, { '.claude/rules/new.md': `${fm({ paths: ['also/dead/**'] })}\n- r\n`, 'AGENTS.md': '- [auth](docs/knowledge/auth.md)\n- `.claude/rules/src.md`\n- `.claude/rules/new.md`\n', 'docs/knowledge/auth.md': `${fm({})}${lines(160)}` })
  const j = lint(env, [`--base=${baseSha}`])
  const flag = (c, p) => j.failures.concat(j.warnings).find((f) => f.check === c && f.path === p)?.new
  assert.equal(flag('dead-glob', '.claude/rules/src.md'), false, 'predates the crew')
  assert.equal(flag('unreachable', 'docs/knowledge/lonely.md'), false)
  assert.equal(flag('dead-glob', '.claude/rules/new.md'), true)
  assert.equal(flag('over-budget', 'docs/knowledge/auth.md'), true, 'a warning carries new too')
  for (const f of [...j.failures, ...j.warnings]) assert.equal(typeof f.new, 'boolean')
  assert.ok(base)
  const plain = lint(env)
  for (const f of [...plain.failures, ...plain.warnings]) assert.equal(f.new, true)
})

t('lint 15: exit 0 with ok false on findings; exit 2 and an error line on a usage error (an unknown --base, --base with no value, a non-repo)', () => {
  const { env } = goodWorld({ '.claude/rules/dead.md': `${fm({ paths: ['zzz/**'] })}\n- r\n` })
  const r = env.run('knowledge-lint')
  assert.equal(r.status, 0)
  assert.equal(assertOneLine(r).ok, false)
  assertUsageError(env.run('knowledge-lint', {}, ['--base=0123456789abcdef0123456789abcdef01234567']))
  assertUsageError(env.run('knowledge-lint', {}, ['--base']))
  assertUsageError(env.run('knowledge-lint', {}, ['--base=--upload-pack=x']))
  assertUsageError(runCli(env.factory, 'knowledge-lint', ['--repo', tmp('not-a-repo-')], tmp('cwd-')))
})

t('lint 16: knowledgeDir, rulesDir and agentsIndex are configurable; the lint reads the configured places', () => {
  const files = {
    'src/a.ts': 'x\n',
    'ctx/index.md': '- [t](topics/t.md)\n- `policy/src.md`\n',
    'ctx/topics/t.md': `${fm({ sources: ['src/a.ts'] })}\n# T\n`,
    'policy/src.md': `${fm({ paths: ['nope/**'] })}\n- r\n`,
  }
  const env = world(files, { merge: 'sequential', target: 'main', knowledgeDir: 'ctx/topics', rulesDir: 'policy', agentsIndex: 'ctx/index.md' })
  const j = lint(env)
  assert.deepEqual(checks(j.failures), ['dead-glob:policy/src.md'])
})

t('lint 17: a repo with no knowledge files at all is ok', () => {
  const env = world({ 'src/a.ts': 'x\n' })
  assert.deepEqual(lint(env), CLEAN)
})

t('lint 18: non-ASCII file names are matched, not quoted away (core.quotepath off)', () => {
  const { env } = goodWorld({ 'src/日本語/café.ts': 'x\n', '.claude/rules/src.md': `${fm({ paths: ['src/日本語/*.ts'], sources: ['src/日本語/café.ts'], verified: 'HEADSHA' })}\n- r\n` })
  const j = lint(env)
  assert.deepEqual([j.ok, j.failures], [true, []])
  assert.deepEqual(checks(j.warnings), ['stale:.claude/rules/src.md'], 'the file was added after verified, so only stale is said')
})

// ---------------------------------------------------------------- 0.24.0 review fixes

const PERSONA_OF = (name, body) => `${fm({ name, description: 'd', model: 'sonnet' })}\n${body}`
const STANDARDS = (n) => `## Standards\n\n${Array.from({ length: n }, (_, i) => `- rule ${i}`).join('\n')}\n`

t('lint 19: new keys on the subject too: a second dead glob in one rule, a second missing path in one feature map, a second persona call and a second budget kind on one persona are new; the same ones (a call re-wrapped) are not', () => {
  const callA = '- Q: skip login? A: yes. Decided by: PM\n'
  const { env } = goodWorld({
    '.claude/rules/src.md': `${fm({ paths: ['src/**', 'old/**'] })}\n- r\n`,
    'docs/features.md': '# Features\n\n## A\n\nEntry `src/a.ts`, `src/gone.ts`.\n',
    '.claude/agents/dev.md': PERSONA_OF('dev', `${STANDARDS(16)}\n## Product calls\n\n${callA}`),
    '.claude/agents/qa.md': PERSONA_OF('qa', `## Product calls\n\n- Q: export csv?   A: no.\n`),
  })
  const base = git(env.repo, ['rev-parse', 'HEAD'])
  commit(env.repo, {
    '.claude/rules/src.md': `${fm({ paths: ['src/**', 'old/**', 'new/**'] })}\n- r\n`,
    'docs/features.md': '# Features\n\n## A\n\nEntry `src/a.ts`, `src/gone.ts`, `src/gone2.ts`.\n',
    '.claude/agents/dev.md': PERSONA_OF('dev', `${STANDARDS(16)}\n## Product calls\n\n${callA}- Q: dark mode? A: later.\n\n${lines(130)}`),
    '.claude/agents/qa.md': PERSONA_OF('qa', `## Product calls\n\n- Q: export\n  csv? A: no.\n`),
  })
  const j = lint(env, [`--base=${base}`])
  const flags = (c, p, re) => j.failures.filter((f) => f.check === c && f.path === p && re.test(f.message)).map((f) => f.new)
  assert.deepEqual(flags('dead-glob', '.claude/rules/src.md', /"old\/\*\*"/), [false])
  assert.deepEqual(flags('dead-glob', '.claude/rules/src.md', /"new\/\*\*"/), [true], 'a second dead glob in the same rule')
  assert.deepEqual(flags('missing-source', 'docs/features.md', /"src\/gone\.ts"/), [false])
  assert.deepEqual(flags('missing-source', 'docs/features.md', /"src\/gone2\.ts"/), [true], 'a second dead path in the same feature map')
  assert.deepEqual(flags('persona-calls', '.claude/agents/dev.md', /2 product-call entries/), [true], 'a second call in the same persona')
  assert.deepEqual(flags('persona-calls', '.claude/agents/qa.md', /1 product-call entry/), [false], 'the same call, only re-wrapped')
  assert.deepEqual(flags('over-budget', '.claude/agents/dev.md', /Standards items/), [false])
  assert.deepEqual(flags('over-budget', '.claude/agents/dev.md', /lines, budget 120/), [true], 'a second budget kind on the same persona')
  assert.equal(j.predatingCount, 4)
})

t('lint 20: a heading that only mentions product calls (judging rules) is not persona-calls and migrate leaves it; a heading that is a log of calls is', () => {
  const judging = '## How I judge product calls\n\n- prefer the smaller scope\n- ask who the user is\n\n### Making product decisions\n\n- write the reason down\n'
  const { env } = goodWorld({ '.claude/agents/product-owner.md': PERSONA_OF('product-owner', judging) })
  assert.deepEqual(lint(env), CLEAN)
  assert.deepEqual(env.run('knowledge-migrate').json.moves, [])
  for (const head of ['## Product call log', '### Product decisions (crew)', '## **Product calls**', '## Crew product calls']) {
    const w = goodWorld({ '.claude/agents/product-owner.md': PERSONA_OF('product-owner', `${judging}\n${head}\n\n- skip login -> yes\n`) })
    const f = lint(w.env).failures
    assert.deepEqual(checks(f), ['persona-calls:.claude/agents/product-owner.md'], head)
    assert.match(f[0].message, /1 product-call entry/, head)
  }
})

t('lint 21: a rule file linked from the feature map is reachable even when the agents index does not list it', () => {
  const { env } = goodWorld({
    '.claude/rules/ui.md': `${fm({ paths: ['src/**'] })}\n- r\n`,
    'docs/features.md': '# Features\n\n## UI\n\nRules: [ui](../.claude/rules/ui.md).\n',
  })
  assert.deepEqual(lint(env), CLEAN)
  const { env: env2 } = goodWorld({ '.claude/rules/ui.md': `${fm({ paths: ['src/**'] })}\n- r\n` })
  assert.deepEqual(checks(lint(env2).failures), ['unreachable:.claude/rules/ui.md'])
})

t('lint 22: every new failure is listed; predating failures and warnings are capped at 20 each, with predatingCount and warningCount as the true totals', () => {
  const globs = (from, n) => Array.from({ length: n }, (_, i) => `dead${from + i}/**`)
  const entries = Array.from({ length: 25 }, (_, i) => `## E${i}\n\nl1\nl2\nl3\nl4\nl5\nl6\n`).join('\n')
  const { env } = goodWorld({ '.claude/rules/src.md': `${fm({ paths: ['src/**', ...globs(0, 25)] })}\n- r\n`, 'docs/features.md': `# F\n\n${entries}` })
  const base = git(env.repo, ['rev-parse', 'HEAD'])
  commit(env.repo, { '.claude/rules/src.md': `${fm({ paths: ['src/**', ...globs(0, 25), ...globs(100, 22)] })}\n- r\n` })
  const j = lint(env, [`--base=${base}`])
  assert.equal(j.ok, false)
  assert.equal(j.failures.filter((f) => f.new).length, 22, 'new failures are never capped')
  assert.equal(j.failures.filter((f) => !f.new).length, 20)
  assert.equal(j.predatingCount, 25)
  assert.equal(j.warnings.length, 20)
  assert.equal(j.warningCount, 25)
  for (const f of [...j.failures, ...j.warnings]) assert.deepEqual(Object.keys(f).sort(), ['check', 'message', 'new', 'path'])
  const plain = lint(env)
  assert.equal(plain.failures.length, 47, 'without --base every failure is new')
  assert.equal(plain.predatingCount, 0)
})

t('lint 23: --slug lints the crew worktree (working tree and HEAD) with the base at merge-base <target> HEAD; --base still wins; with no merge-base the red record head is the base; a bad slug is a usage error', () => {
  const { env } = goodWorld({ '.claude/rules/src.md': `${fm({ paths: ['src/**', 'old/**'] })}\n- r\n` })
  const forked = git(env.repo, ['rev-parse', 'HEAD'])
  const wt = addCrewWorktree(env.repo, 's')
  // the crew adds a dead glob of its own and has an uncommitted rule file
  commit(wt, { '.claude/rules/src.md': `${fm({ paths: ['src/**', 'old/**', 'crew/**'] })}\n- r\n` })
  putFile(wt, 'docs/knowledge/wip.md', `${fm({})}\n# W\n`)
  // the target moves on with a dead glob the crew then merges in
  commit(env.repo, { '.claude/rules/main.md': `${fm({ paths: ['main/**'] })}\n- r\n`, 'AGENTS.md': `${BASE_FILES['AGENTS.md']}- \`.claude/rules/main.md\`\n` })
  git(wt, ['merge', '-q', '--no-edit', 'main'])
  const flag = (j, p, re) => j.failures.find((f) => f.path === p && re.test(f.message))?.new
  const j = lint(env, ['--slug', 's'])
  assert.equal(flag(j, '.claude/rules/src.md', /"crew\/\*\*"/), true, 'the crew worktree is linted, not the main checkout')
  assert.equal(flag(j, '.claude/rules/src.md', /"old\/\*\*"/), false)
  assert.equal(flag(j, '.claude/rules/main.md', /"main\/\*\*"/), false, 'merged in from the target, so it predates the crew at merge-base')
  assert.ok(j.failures.some((f) => f.check === 'unreachable' && f.path === 'docs/knowledge/wip.md') === false, 'an untracked file is not linted')
  const main = lint(env)
  assert.ok(!main.failures.some((f) => /crew\/\*\*/.test(f.message)), 'without --slug the main checkout is linted')
  const given = lint(env, ['--slug', 's', `--base=${forked}`])
  assert.equal(flag(given, '.claude/rules/main.md', /"main\/\*\*"/), true, '--base is used when given')
  // no merge-base: the target does not resolve, so the head of the crew red record is the base
  writeFileSync(`${env.repo}/.claude/truss.json`, JSON.stringify({ merge: 'sequential', target: 'no-such-branch' }))
  assert.equal(lint(env, ['--slug', 's']).failures[0].check, 'config-unverified', 'no base at all is a failing result, not a usage error')
  putFile(env.dir, 'checks/s-1.json', JSON.stringify({ command: 'true', exit: 1, head: forked, tail: '' }) + '\n')
  const red = lint(env, ['--slug', 's'])
  assert.equal(flag(red, '.claude/rules/main.md', /"main\/\*\*"/), true)
  assert.equal(flag(red, '.claude/rules/src.md', /"old\/\*\*"/), false)
  assertUsageError(env.run('knowledge-lint', { slug: 'nope' }))
  assertUsageError(env.run('knowledge-lint', { slug: 'Bad Slug' }))
})

// ---------------------------------------------------------------- 0.24.0 review fixes, second round

const groups = (n, alts = ['a', 'b']) => `{${alts.join(',')}}`.repeat(n)

t('glob 3: brace expansion is bounded: more than 8 groups, or more than 256 alternatives, is invalid and matches nothing, and a 30-group glob is rejected in under 100 ms', () => {
  const t0 = performance.now()
  assert.equal(globMatch(`src/${groups(30)}.ts`, `src/${'a'.repeat(30)}.ts`), false)
  assert.match(globError(groups(30)), /more than 8 brace groups/)
  assert.ok(performance.now() - t0 < 100, `took ${performance.now() - t0} ms`)
  assert.equal(globError(groups(8)), undefined, '8 groups of 2 is exactly 256')
  assert.equal(globMatch(groups(8), 'abababab'), true)
  assert.match(globError(groups(9)), /more than 8 brace groups/)
  assert.match(globError(groups(3, ['a', 'b', 'c', 'd', 'e', 'f', 'g'])), /more than 256 alternatives/)
  assert.equal(globMatch(groups(3, ['a', 'b', 'c', 'd', 'e', 'f', 'g']), 'abc'), false)
  assert.equal(globToRegExp(groups(9)).test(''), false, 'an invalid glob does not match the empty path either')
  assert.equal(globError('{a,b}/{a,b}'), undefined)
  assert.equal(globError('{'.repeat(40)), undefined, 'literal braces are not groups')
})

t('lint 24: bad-glob fails an invalid paths or sources glob, instead of dead-glob or missing-source; new is keyed on the glob', () => {
  // quoted: a `,` splits an inline list
  const bad1 = `"src/${groups(22)}.ts"`
  const bad2 = `"src/${groups(3, ['a', 'b', 'c', 'd', 'e', 'f', 'g'])}"`
  const { env } = goodWorld({ '.claude/rules/src.md': `${fm({ paths: ['src/**', bad1], sources: ['src/a.ts', bad1] })}\n- r\n` })
  const base = git(env.repo, ['rev-parse', 'HEAD'])
  const j = lint(env)
  assert.deepEqual(checks(j.failures), ['bad-glob:.claude/rules/src.md', 'bad-glob:.claude/rules/src.md'])
  assert.match(j.failures.map((f) => f.message).join('\n'), /paths glob .*more than 8 brace groups/)
  assert.match(j.failures.map((f) => f.message).join('\n'), /sources glob .*more than 8 brace groups/)
  commit(env.repo, { '.claude/rules/src.md': `${fm({ paths: ['src/**', bad1, bad2], sources: ['src/a.ts', bad1] })}\n- r\n` })
  const k = lint(env, [`--base=${base}`])
  assert.deepEqual(k.failures.filter((f) => f.check === 'bad-glob').map((f) => [f.message.includes('256 alternatives'), f.new]).sort(), [[false, false], [false, false], [true, true]])
  assert.ok(!k.failures.some((f) => f.check === 'dead-glob' || f.check === 'missing-source'), 'never both')
})

t('lint 25: always-loaded-calls fails a product-call entry in CLAUDE.md, CLAUDE.local.md or AGENTS.md at any depth and in the agents index; a CLAUDE.md of imports and conventions passes; persona-calls stays for personas; knowledge-migrate moves them', () => {
  const CONVENTIONS = '# Project\n\n@AGENTS.md\n\n## Conventions\n\n- run `npm test` before a commit\n- product calls go to the product owner\n'
  const ok = goodWorld({ 'CLAUDE.md': CONVENTIONS })
  assert.deepEqual(lint(ok.env), CLEAN)
  const CALLS = '\n## Product calls\n\n- Q: skip login? A: yes. Decided by: PM\n- Q: export csv? A: no.\n'
  const bad = goodWorld({
    'CLAUDE.md': CONVENTIONS + CALLS,
    'pkg/web/AGENTS.md': '# Web\n\n- **Question:** dark mode? -> later\n',
    'pkg/api/CLAUDE.local.md': '# Api\n\n- use pnpm\n',
    '.claude/agents/product-owner.md': PERSONA_OF('product-owner', `Judge fit.\n${CALLS}`),
  })
  const j = lint(bad.env)
  assert.deepEqual(checks(j.failures), ['always-loaded-calls:CLAUDE.md', 'always-loaded-calls:pkg/web/AGENTS.md', 'persona-calls:.claude/agents/product-owner.md'])
  const claude = j.failures.find((f) => f.path === 'CLAUDE.md')
  assert.match(claude.message, /2 product-call entries in an always-loaded file/)
  assert.match(claude.message, /factory knowledge-migrate/)
  // the agents index is always loaded, wherever it is configured; new is keyed on the call
  const idx = world({ ...BASE_FILES, 'ctx/index.md': '# I\n\n## Product decisions\n\n- skip login -> yes\n' }, { merge: 'sequential', target: 'main', agentsIndex: 'ctx/index.md' })
  const base = git(idx.repo, ['rev-parse', 'HEAD'])
  assert.deepEqual(checks(lint(idx).failures), ['always-loaded-calls:ctx/index.md'])
  commit(idx.repo, { 'ctx/index.md': '# I\n\n## Product decisions\n\n- skip   login -> yes\n- dark mode -> later\n' })
  assert.deepEqual(lint(idx, [`--base=${base}`]).failures.map((f) => [f.check, f.new]), [['always-loaded-calls', true]])
  commit(idx.repo, { 'ctx/index.md': '# I\n\n## Product decisions\n\n- Skip login -> yes\n' })
  assert.deepEqual(lint(idx, [`--base=${base}`]).failures.map((f) => [f.check, f.new]), [['always-loaded-calls', false]])
  // migrate moves the CLAUDE.md and AGENTS.md entries too and leaves the conventions
  const m = bad.env.run('knowledge-migrate', { apply: true })
  assert.equal(m.status, 0, m.stderr)
  assert.deepEqual(m.json.moves.map((x) => x.from).sort(), ['.claude/agents/product-owner.md', 'CLAUDE.md', 'pkg/web/AGENTS.md'])
  const after = readFileSync(`${bad.env.repo}/CLAUDE.md`, 'utf8')
  assert.ok(after.startsWith(CONVENTIONS), after)
  assert.ok(!/skip login|Product calls\n/.test(after), after)
  assert.match(after, /Product calls are recorded in `docs\/knowledge\/product-decisions\.md`\.\n$/)
  assert.match(readFileSync(`${bad.env.repo}/docs/knowledge/product-decisions.md`, 'utf8'), /dark mode\? -> later/)
  assert.ok(!bad.env.run('knowledge-lint').json.failures.some((f) => /calls$/.test(f.check)))
})

t('lint 26: --slug says which base it used: base always, baseFallback true when the red record head stood in for the merge-base; with neither, the error names both attempts', () => {
  const { env } = goodWorld()
  const forked = git(env.repo, ['rev-parse', 'HEAD'])
  const wt = addCrewWorktree(env.repo, 's')
  commit(wt, { 'src/a.ts': 'export const a = 2\n' })
  const crewHead = git(wt, ['rev-parse', 'HEAD'])
  const mb = lint(env, ['--slug', 's'])
  assert.equal(mb.base, forked)
  assert.equal('baseFallback' in mb, false)
  assert.equal(lint(env, ['--slug', 's', `--base=${forked.slice(0, 10)}`]).base, forked, '--base is reported as the full sha')
  assert.equal('base' in lint(env), false, 'no base, no key')
  writeFileSync(`${env.repo}/.claude/truss.json`, JSON.stringify({ merge: 'sequential', target: 'no-such-branch' }))
  const failing = (j) => {
    assert.equal(j.ok, false)
    assert.equal(j.failures.length, 1, JSON.stringify(j.failures))
    assert.equal(j.failures[0].check, 'config-unverified')
    assert.equal(j.failures[0].new, true)
    return j.failures[0].message
  }
  const none = failing(lint(env, ['--slug', 's']))
  assert.match(none, /merge-base no-such-branch HEAD failed/)
  assert.match(none, /red record/)
  putFile(env.dir, 'checks/s-1.json', JSON.stringify({ command: 'true', exit: 1, head: '0123456789abcdef0123456789abcdef01234567', tail: '' }) + '\n')
  assert.match(failing(lint(env, ['--slug', 's'])), /merge-base no-such-branch HEAD failed.*red record head 0123456789abcdef.* is not a commit/)
  const good = readFileSync(`${env.repo}/.claude/truss.json`, 'utf8')
  writeFileSync(`${env.repo}/.claude/truss.json`, '{broken')
  assert.match(failing(lint(env, ['--slug', 's'])), /the target could not be read/)
  writeFileSync(`${env.repo}/.claude/truss.json`, good)
  putFile(env.dir, 'checks/s-1.json', JSON.stringify({ command: 'true', exit: 1, head: crewHead, tail: '' }) + '\n')
  const fb = lint(env, ['--slug', 's'])
  assert.equal(fb.base, crewHead)
  assert.equal(fb.baseFallback, true)
})

t('lint 27: with --slug the knowledge config comes from the base commit, never from the crew\'s truss.json or the main checkout\'s', () => {
  const { env } = goodWorld()
  const wt = addCrewWorktree(env.repo, 's')
  commit(wt, { '.claude/truss.json': JSON.stringify({ merge: 'sequential', target: 'main', rulesDir: 'policy' }), 'policy/x.md': `${fm({ paths: ['gone/**'] })}\n- r\n`, '.claude/rules/y.md': `${fm({ paths: ['also-gone/**'] })}\n- r\n`, 'main-rules/z.md': `${fm({ paths: ['main-gone/**'] })}\n- r\n` })
  // the main checkout's config differs from the base and must play no part
  writeFileSync(`${env.repo}/.claude/truss.json`, JSON.stringify({ merge: 'sequential', target: 'main', rulesDir: 'main-rules' }))
  const j = lint(env, ['--slug', 's'])
  // the crew's own truss.json moves rulesDir: that is a loosening, so the lint judges the crew with the base config instead
  assert.equal(j.ok, false)
  assert.ok(j.failures.some((f) => f.check === 'config-loosened' && /rulesDir changed/.test(f.message)), JSON.stringify(j.failures))
  assert.ok(j.failures.some((f) => f.check === 'dead-glob' && f.path === '.claude/rules/y.md'), 'the base rulesDir is used')
  assert.ok(!j.failures.some((f) => f.path === 'policy/x.md'), 'the crew\'s rulesDir is not used')
  assert.ok(!j.failures.some((f) => f.path === 'main-rules/z.md'), 'the main checkout\'s rulesDir is not used')
  assert.ok(!j.failures.some((f) => /policy|main-rules/.test(f.message)), 'a path value is not repeated in a message')
  // the working tree's copy is not read: removing it changes nothing
  unlinkSync(`${wt}/.claude/truss.json`)
  assert.deepEqual(lint(env, ['--slug', 's']).failures, j.failures)
})

t('lint 28: every new warning is listed; only predating warnings are capped at 20, and warningCount is the true total', () => {
  const entry = (i) => `## E${i}\n\nl1\nl2\nl3\nl4\nl5\nl6\n`
  const map = (from, n) => Array.from({ length: n }, (_, i) => entry(from + i)).join('\n')
  const { env } = goodWorld({ 'docs/features.md': `# F\n\n${map(0, 25)}` })
  const base = git(env.repo, ['rev-parse', 'HEAD'])
  commit(env.repo, { 'docs/features.md': `# F\n\n${map(0, 25)}\n${map(100, 22)}` })
  const j = lint(env, [`--base=${base}`])
  assert.equal(j.warnings.filter((w) => w.new).length, 22, 'new warnings are never capped')
  assert.equal(j.warnings.filter((w) => !w.new).length, 20)
  assert.equal(j.warningCount, 47)
  const plain = lint(env)
  assert.equal(plain.warnings.length, 47, 'without --base every warning is new')
  assert.equal(plain.warningCount, 47)
})

// ---------------------------------------------------------------- rules-index

t('rules-index 1: lists every tracked rule file with its paths globs, sorted; a rule with no paths lists an empty array; nested rules count, an untracked file does not; the output is one JSON line', () => {
  const env = world({
    '.claude/rules/b.md': `${fm({ paths: ['src/**', '"lib/*.ts"'] })}\n- r\n`,
    '.claude/rules/a.md': '---\npaths:\n  - docs/**\n---\n- r\n',
    '.claude/rules/c.md': 'no frontmatter\n',
    '.claude/rules/sub/d.md': `${fm({ paths: 'x/**' })}\n- r\n`,
    '.claude/rules/notes.txt': 'x\n',
  })
  putFile(env.repo, '.claude/rules/e.md', `${fm({ paths: ['e/**'] })}\n- r\n`)
  const r = env.run('rules-index')
  assert.equal(r.status, 0)
  assert.deepEqual(assertOneLine(r), {
    rules: [
      { path: '.claude/rules/a.md', paths: ['docs/**'] },
      { path: '.claude/rules/b.md', paths: ['src/**', 'lib/*.ts'] },
      { path: '.claude/rules/c.md', paths: [] },
      { path: '.claude/rules/sub/d.md', paths: ['x/**'] },
    ],
  })
  // ADR-0035 review: an untracked rule file in the main checkout is in no crew's worktree, so it stays out of the stage args too
  writePlan(env.dir, planObj([crew('s')]))
  writeGoal(env.dir, 's', {})
  assert.ok(!assertOneLine(env.run('start', { stage: 'next' })).truss.rules.some((r) => r.path === '.claude/rules/e.md'))
  assert.deepEqual(world({ 'a.txt': 'x\n' }).run('rules-index').json, { rules: [] })
  const custom = world({ 'pol/x.md': `${fm({ paths: ['a/**'] })}\n`, '.claude/rules/y.md': 'x\n' }, { merge: 'sequential', target: 'main', rulesDir: 'pol' })
  assert.deepEqual(custom.run('rules-index').json, { rules: [{ path: 'pol/x.md', paths: ['a/**'] }] })
})

// ---------------------------------------------------------------- knowledge-migrate

const PO = (body) => `${fm({ name: 'product-owner', description: 'Judges fit', model: 'sonnet' })}\n${body}`
const PO_BODY = 'You judge product fit.\n\n## Standards\n\n- be strict\n\n## Product calls\n\n- Q: skip login? A: yes. Reason: pilot.\n  Decided by: PM\n- Q: export csv? A: no.\n\n## Domain\n\nUsers are admins.\n'

t('migrate 1: without --apply it prints the moves and writes nothing', () => {
  const env = world({ '.claude/agents/product-owner.md': PO(PO_BODY) })
  const before = readFileSync(`${env.repo}/.claude/agents/product-owner.md`, 'utf8')
  const r = env.run('knowledge-migrate')
  assert.equal(r.status, 0, r.stderr)
  const j = assertOneLine(r)
  assert.equal(j.applied, false)
  assert.equal(j.moves.length, 1)
  assert.equal(j.moves[0].from, '.claude/agents/product-owner.md')
  assert.equal(j.moves[0].to, 'docs/knowledge/product-decisions.md')
  assert.equal(j.moves[0].entries.length, 2)
  assert.match(j.moves[0].entries[0], /skip login/)
  assert.match(j.moves[0].entries[0], /Decided by: PM/, 'a continuation line goes with its entry')
  assert.equal(readFileSync(`${env.repo}/.claude/agents/product-owner.md`, 'utf8'), before)
  assert.ok(!existsSync(`${env.repo}/docs/knowledge/product-decisions.md`))
  assert.equal(git(env.repo, ['status', '--porcelain']), '')
})

t('migrate 2: --apply moves the entries to the product-decisions file, leaves one pointer line and the frontmatter and other sections untouched, and never commits; a second run finds nothing', () => {
  const env = world({ '.claude/agents/product-owner.md': PO(PO_BODY) })
  const headBefore = git(env.repo, ['rev-parse', 'HEAD'])
  const r = env.run('knowledge-migrate', { apply: true })
  assert.equal(r.status, 0, r.stderr)
  const j = assertOneLine(r)
  assert.equal(j.applied, true)
  assert.equal(j.moves.length, 1)
  const persona = readFileSync(`${env.repo}/.claude/agents/product-owner.md`, 'utf8')
  assert.ok(persona.startsWith(PO('').trimEnd().replace(/\n+$/, '') + '\n'), 'the frontmatter is byte-identical')
  assert.ok(!/skip login|export csv|Product calls\n/.test(persona), persona)
  assert.match(persona, /## Standards\n\n- be strict\n/)
  assert.match(persona, /## Domain\n\nUsers are admins\./)
  assert.equal(persona.split('docs/knowledge/product-decisions.md').length - 1, 1, 'one pointer line')
  assert.match(persona, /Product calls are recorded in `docs\/knowledge\/product-decisions\.md`\.\n$/)
  const decisions = readFileSync(`${env.repo}/docs/knowledge/product-decisions.md`, 'utf8')
  assert.match(decisions, /^# Product decisions/)
  assert.match(decisions, /- Q: skip login\? A: yes\. Reason: pilot\.\n {2}Decided by: PM/)
  assert.match(decisions, /- Q: export csv\? A: no\./)
  assert.equal(git(env.repo, ['rev-parse', 'HEAD']), headBefore, 'never commits')
  const again = env.run('knowledge-migrate', { apply: true }).json
  assert.deepEqual(again.moves, [])
  assert.equal(readFileSync(`${env.repo}/docs/knowledge/product-decisions.md`, 'utf8'), decisions, 'idempotent')
  assert.equal(readFileSync(`${env.repo}/.claude/agents/product-owner.md`, 'utf8'), persona)
  // and the lint no longer reports persona-calls
  const l = env.run('knowledge-lint').json
  assert.ok(!l.failures.some((f) => f.check === 'persona-calls'))
})

t('migrate 3: entries go to an existing product-decisions file without duplicates; the configured productDecisions path is used; CRLF personas stay CRLF; a persona with no calls is left alone', () => {
  const env = world({
    '.claude/agents/product-owner.md': PO(PO_BODY).replace(/\n/g, '\r\n'),
    '.claude/agents/dev.md': PO('## Standards\n\n- x\n').replace('product-owner', 'dev'),
    'notes/pd.md': '# PD\n\n- Q: export csv? A: no.\n',
  }, { merge: 'sequential', target: 'main', productDecisions: 'notes/pd.md' })
  const dev = readFileSync(`${env.repo}/.claude/agents/dev.md`, 'utf8')
  const j = env.run('knowledge-migrate', { apply: true }).json
  assert.deepEqual(j.moves.map((m) => [m.from, m.to]), [['.claude/agents/product-owner.md', 'notes/pd.md']])
  const pd = readFileSync(`${env.repo}/notes/pd.md`, 'utf8')
  assert.equal(pd.split('export csv').length - 1, 1, 'no duplicate')
  assert.match(pd, /skip login/)
  const persona = readFileSync(`${env.repo}/.claude/agents/product-owner.md`, 'utf8')
  assert.ok(!persona.replace(/\r\n/g, '').includes('\n'), 'every line ending is still CRLF')
  assert.match(persona, /`notes\/pd\.md`/)
  assert.equal(readFileSync(`${env.repo}/.claude/agents/dev.md`, 'utf8'), dev)
})

t('migrate 4: loose entries outside a Product calls section move too, and a flag value is refused', () => {
  const env = world({ '.claude/agents/product-owner.md': PO('Judge.\n\n- **Question:** keep history? -> yes (decided by PM)\n- an ordinary rule\n') })
  const j = env.run('knowledge-migrate').json
  assert.equal(j.moves[0].entries.length, 1)
  env.run('knowledge-migrate', { apply: true })
  const persona = readFileSync(`${env.repo}/.claude/agents/product-owner.md`, 'utf8')
  assert.match(persona, /- an ordinary rule/)
  assert.ok(!persona.includes('keep history'))
  assertUsageError(env.run('knowledge-migrate', { apply: 'maybe' }))
})

// ---------------------------------------------------------------- the owns exemption

const KNOWLEDGE = 'docs(knowledge): s learned'
const FM = (extra = '') => `---\nname: dev\ndescription: dev area\nmodel: sonnet\n${extra}---\n\n`
function crewWorld(config = { merge: 'sequential', target: 'main' }, files = { 'a.txt': 'base\n' }) {
  const env = mkEnv({ config, files })
  writePlan(env.dir, planObj([crew('s', { owns: ['src/s/**'], status: 'running' })]))
  return { env, wt: addCrewWorktree(env.repo, 's') }
}
function knowledgeCommit(env, wt, files) {
  for (const [rel, text] of Object.entries(files)) putFile(wt, rel, text)
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-q', '-m', KNOWLEDGE])
  assert.equal(env.run('knowledge-commit', { slug: 's', sha: git(wt, ['rev-parse', 'HEAD']) }).status, 0)
}
const ownsOf = (env) => {
  const r = env.run('owns-check', { slug: 's' })
  return { status: r.status, outside: r.json.outside ?? [], exempt: r.json.exempt ?? [] }
}

t('exempt 1: a recorded knowledge commit may write <rulesDir>/*.md, <knowledgeDir>/**/*.md, the agents index and the product-decisions file with no learned-item target', () => {
  const { env, wt } = crewWorld()
  knowledgeCommit(env, wt, {
    '.claude/rules/area.md': 'r\n', 'docs/knowledge/deep/topic.md': 'k\n', 'AGENTS.md': 'index\n', 'docs/knowledge/product-decisions.md': 'pd\n',
  })
  assert.deepEqual(ownsOf(env), { status: 0, outside: [], exempt: ['.claude/rules/area.md', 'AGENTS.md', 'docs/knowledge/deep/topic.md', 'docs/knowledge/product-decisions.md'] })
})

t('exempt 2: only .md files, only in the knowledge commit: a non-md file under those dirs, or one a builder commit also touched, is outside', () => {
  const { env, wt } = crewWorld()
  putFile(wt, 'docs/knowledge/shared.md', 'built\n')
  git(wt, ['add', '-A'])
  git(wt, ['commit', '-q', '-m', 'work'])
  knowledgeCommit(env, wt, { '.claude/rules/area.yaml': 'r\n', 'docs/knowledge/data.json': '{}\n', 'docs/knowledge/shared.md': 'changed\n', 'docs/knowledge/ok.md': 'k\n' })
  const o = ownsOf(env)
  assert.equal(o.status, 1)
  assert.deepEqual(o.outside, ['.claude/rules/area.yaml', 'docs/knowledge/data.json', 'docs/knowledge/shared.md'])
  assert.deepEqual(o.exempt, ['docs/knowledge/ok.md'])
})

t('exempt 3: the configured keys move the doc set; the defaults then stop being exempt', () => {
  const { env, wt } = crewWorld({ merge: 'sequential', target: 'main', rulesDir: 'policy', knowledgeDir: 'ctx', agentsIndex: 'ctx/INDEX.md', productDecisions: 'pd/calls.md' })
  knowledgeCommit(env, wt, { 'policy/a.md': 'r\n', 'ctx/t.md': 'k\n', 'ctx/INDEX.md': 'i\n', 'pd/calls.md': 'p\n', '.claude/rules/b.md': 'r\n', 'AGENTS.md': 'i\n' })
  const o = ownsOf(env)
  assert.deepEqual(o.exempt, ['ctx/INDEX.md', 'ctx/t.md', 'pd/calls.md', 'policy/a.md'])
  assert.deepEqual(o.outside, ['.claude/rules/b.md', 'AGENTS.md'])
})

t('exempt 4: persona frontmatter is never exempt: editing a persona\'s frontmatter fails even when its directory is also the rules dir; a body-only edit passes', () => {
  const persona = (extra, body) => `${FM(extra)}## Standards\n\n- ${body}\n`
  const { env, wt } = crewWorld({ merge: 'sequential', target: 'main', rulesDir: '.claude/agents' }, { 'a.txt': 'base\n', '.claude/agents/dev.md': persona('', 'old'), '.claude/agents/qa.md': persona('', 'old') })
  knowledgeCommit(env, wt, { '.claude/agents/dev.md': persona('tools: Bash\n', 'new'), '.claude/agents/qa.md': persona('', 'new'), '.claude/agents/fresh.md': persona('', 'new') })
  const o = ownsOf(env)
  assert.equal(o.status, 1)
  assert.deepEqual(o.outside, ['.claude/agents/dev.md', '.claude/agents/fresh.md'], 'a new persona is all frontmatter')
  assert.deepEqual(o.exempt, ['.claude/agents/qa.md'])
})

// ---------------------------------------------------------------- stage args, plan args, poPrompt, schema

function startArgs(config, files) {
  const env = mkEnv({ config, files })
  writePlan(env.dir, planObj([crew('s')]))
  writeGoal(env.dir, 's', {})
  return assertOneLine(env.run('start', { stage: 'next' })).truss
}
const RULE = `${fm({ paths: ['src/**'] })}\n- r\n`

t('args 1: start passes rules, productDecisions, agentsIndex, rulesDir and knowledgeDir next to featureMap when the files exist', () => {
  const a = startArgs({ merge: 'sequential', target: 'main' }, {
    'docs/features.md': '# f\n', 'AGENTS.md': '# i\n', 'docs/knowledge/product-decisions.md': '# pd\n', '.claude/rules/b.md': RULE, '.claude/rules/a.md': `${fm({ paths: ['lib/*.ts', 'x/**'] })}\n`,
  })
  assert.equal(a.productDecisions, 'docs/knowledge/product-decisions.md')
  assert.equal(a.agentsIndex, 'AGENTS.md')
  assert.equal(a.rulesDir, '.claude/rules')
  assert.equal(a.knowledgeDir, 'docs/knowledge')
  assert.deepEqual(a.rules, [{ path: '.claude/rules/a.md', paths: ['lib/*.ts', 'x/**'] }, { path: '.claude/rules/b.md', paths: ['src/**'] }])
  assert.equal(a.kind, 'stage')
})

t('args 2: a key is omitted when its file or dir does not exist, and rules when there are no rule files', () => {
  const none = startArgs({ merge: 'sequential', target: 'main' }, {})
  for (const k of ['productDecisions', 'agentsIndex', 'rulesDir', 'knowledgeDir', 'rules']) assert.ok(!Object.hasOwn(none, k), k)
  const some = startArgs({ merge: 'sequential', target: 'main' }, { 'AGENTS.md': '# i\n', '.claude/rules/readme.txt': 'x\n' })
  assert.equal(some.agentsIndex, 'AGENTS.md')
  assert.equal(some.rulesDir, '.claude/rules')
  assert.ok(!Object.hasOwn(some, 'rules'))
  assert.ok(!Object.hasOwn(some, 'productDecisions') && !Object.hasOwn(some, 'knowledgeDir'))
})

t('args 3: the configured paths are used (a backslash is a separator); an invalid one falls back to the default', () => {
  const a = startArgs({ merge: 'sequential', target: 'main', productDecisions: 'notes\\pd.md', rulesDir: 'policy', knowledgeDir: '../out', agentsIndex: '/abs/AGENTS.md' }, { 'notes/pd.md': '# pd\n', 'policy/r.md': RULE, 'docs/knowledge/x.md': 'x\n', 'AGENTS.md': '# i\n' })
  assert.equal(a.productDecisions, 'notes/pd.md')
  assert.equal(a.rulesDir, 'policy')
  assert.deepEqual(a.rules, [{ path: 'policy/r.md', paths: ['src/**'] }])
  assert.equal(a.knowledgeDir, 'docs/knowledge', 'a path that climbs out of the repo is dropped for the default')
  assert.equal(a.agentsIndex, 'AGENTS.md')
})

t('args 4: plan-args carries productDecisions, agentsIndex, rulesDir and knowledgeDir (not rules) only when they exist', () => {
  const brief = `${tmp('brief-')}/brief.md`
  writeFileSync(brief, 'brief\n')
  const argsOf = (repo) => runCli(`${PLUGIN}/bin/factory.ts`, 'plan-args', ['--dir', mkTrussDir(), '--repo', repo, '--brief-file', brief], repo).json.truss
  const none = argsOf(mkRepo())
  for (const k of ['productDecisions', 'agentsIndex', 'rulesDir', 'knowledgeDir', 'rules']) assert.ok(!Object.hasOwn(none, k), k)
  const all = argsOf(mkRepo({ files: { 'AGENTS.md': '# i\n', 'docs/knowledge/product-decisions.md': '# pd\n', '.claude/rules/r.md': RULE } }))
  assert.equal(all.productDecisions, 'docs/knowledge/product-decisions.md')
  assert.equal(all.agentsIndex, 'AGENTS.md')
  assert.equal(all.rulesDir, '.claude/rules')
  assert.equal(all.knowledgeDir, 'docs/knowledge')
  assert.ok(!Object.hasOwn(all, 'rules'))
})

t('args 6: a path key set in truss.json is passed even when its file or dir does not exist yet, so stage.js and the lint agree; plan-args too', () => {
  const cfg = { merge: 'sequential', target: 'main', productDecisions: 'notes/pd.md', agentsIndex: 'ctx/INDEX.md', rulesDir: 'policy', knowledgeDir: 'ctx/topics' }
  const a = startArgs(cfg, {})
  assert.deepEqual([a.productDecisions, a.agentsIndex, a.rulesDir, a.knowledgeDir], ['notes/pd.md', 'ctx/INDEX.md', 'policy', 'ctx/topics'])
  assert.ok(!Object.hasOwn(a, 'rules'), 'no rule files yet')
  const brief = `${tmp('brief-')}/brief.md`
  writeFileSync(brief, 'brief\n')
  const p = runCli(`${PLUGIN}/bin/factory.ts`, 'plan-args', ['--dir', mkTrussDir(), '--repo', mkRepo({ config: cfg }), '--brief-file', brief], tmp('cwd-')).json.truss
  assert.deepEqual([p.productDecisions, p.agentsIndex, p.rulesDir, p.knowledgeDir], ['notes/pd.md', 'ctx/INDEX.md', 'policy', 'ctx/topics'])
})

t('args 7: knowledgeBudgets reaches the stage args (all six, defaults filled in, 0 kept) whenever truss.json sets it, and is absent otherwise', () => {
  const a = startArgs({ merge: 'sequential', target: 'main', knowledgeBudgets: { rule: 0, doc: 99, persona: 'x' } }, {})
  assert.deepEqual(a.knowledgeBudgets, { agentsIndex: 60, persona: 120, personaStandards: 15, rule: 0, featureEntry: 6, doc: 99 })
  assert.ok(!Object.hasOwn(startArgs({ merge: 'sequential', target: 'main' }, {}), 'knowledgeBudgets'))
})

t('args 8: the real stage args carry the platform', () => {
  assert.equal(startArgs({ merge: 'sequential', target: 'main' }, {}).platform, process.platform)
})

t('args 5: plan.js poPrompt names the product-decisions file when plan-args carried it, and no such line without it', async () => {
  const body = readFileSync(`${PLUGIN}/workflows/plan.js`, 'utf8')
  assert.match(body, /Product decisions: \$\{F\.repo\}\/\$\{F\.productDecisions\}/)
  assert.match(body, /typeof F\.productDecisions === 'string'/)
})

t('schema 1: the schema declares productDecisions, knowledgeDir, rulesDir and agentsIndex as repo-relative paths and knowledgeBudgets as six integers', () => {
  for (const k of ['productDecisions', 'knowledgeDir', 'rulesDir', 'agentsIndex']) {
    const s = SCHEMA.properties[k]
    assert.ok(s, `${k} is declared`)
    for (const good of ['docs/knowledge', 'AGENTS.md', '.claude/rules']) assert.deepEqual(validate(s, good), [], `${k}: ${good}`)
    for (const bad of ['', '/etc/x', '../x', 'C:\\x', 'a\\b', 5]) assert.ok(validate(s, bad).length > 0, `${k}: ${JSON.stringify(bad)}`)
  }
  const b = SCHEMA.properties.knowledgeBudgets
  assert.equal(b.type, 'object')
  assert.deepEqual(Object.keys(b.properties).sort(), ['agentsIndex', 'doc', 'featureEntry', 'persona', 'personaStandards', 'rule'])
  assert.deepEqual(validate(b, { rule: 30, doc: 100 }), [])
  assert.ok(validate(b, { rule: -1 }).length > 0)
  assert.ok(validate(b, { rule: 'x' }).length > 0)
  assert.ok(validate(b, { nope: 1 }).length > 0)
})

const CFG_KEY = '.claude/truss.json'
const verdict = (j, check) => j.failures.find((f) => f.check === check)

t('config 2: an unreadable base says it could not verify, never that the crew loosened anything', () => {
  const cfg = { merge: 'sequential', target: 'main', rulesDir: '.claude/rules' }
  const env = world(GOOD, cfg)
  const base = git(env.repo, ['rev-parse', 'HEAD'])
  const blob = git(env.repo, ['rev-parse', `HEAD:${CFG_KEY}`])
  commit(env.repo, { [CFG_KEY]: JSON.stringify({ merge: 'sequential', target: 'main' }) })
  unlinkSync(`${env.repo}/.git/objects/${blob.slice(0, 2)}/${blob.slice(2)}`)
  const j = lint(env, [`--base=${base}`])
  assert.equal(j.ok, false)
  assert.match(verdict(j, 'config-unverified').message, /could not verify/)
  assert.equal(verdict(j, 'config-loosened'), undefined)
})

t('config 3: a non-JSON base or head, and a non-object head, fail as could not verify, with exit 0', () => {
  const cfg = { merge: 'sequential', target: 'main' }
  const badBase = world(GOOD, cfg)
  const base = commit(badBase.repo, { [CFG_KEY]: '{not json' })
  commit(badBase.repo, { [CFG_KEY]: JSON.stringify(cfg) })
  const a = lint(badBase, [`--base=${base}`])
  assert.equal(a.ok, false)
  assert.match(verdict(a, 'config-unverified').message, /not valid JSON/)
  for (const [text, why] of [['{not json', /not valid JSON/], ['[1]', /not an object/]]) {
    const env = world(GOOD, cfg)
    const b = git(env.repo, ['rev-parse', 'HEAD'])
    commit(env.repo, { [CFG_KEY]: text })
    const j = lint(env, [`--base=${b}`])
    assert.equal(j.ok, false)
    assert.match(verdict(j, 'config-unverified').message, why)
  }
})

t('config 4: a crew head with a malformed truss.json gives a failing lint result through --slug, not a lint that did not run', () => {
  const { env } = goodWorld()
  const wt = addCrewWorktree(env.repo, 's')
  commit(wt, { [CFG_KEY]: '{not json' })
  const j = lint(env, ['--slug', 's'])
  assert.equal(j.ok, false)
  assert.ok(verdict(j, 'config-unverified'), JSON.stringify(j.failures))
  assert.equal(verdict(j, 'config-unverified').new, true)
})

t('config 5: a base with no truss.json compares against the defaults', () => {
  const env = world(GOOD, { merge: 'sequential', target: 'main' })
  git(env.repo, ['rm', '-q', CFG_KEY])
  const base = commit(env.repo, { 'src/none.ts': 'export {}\n' })
  commit(env.repo, { [CFG_KEY]: JSON.stringify({ knowledgeBudgets: { rule: 41 } }) })
  assert.match(verdict(lint(env, [`--base=${base}`]), 'config-loosened').message, /knowledgeBudgets\.rule raised from 40 to 41/)
  commit(env.repo, { [CFG_KEY]: JSON.stringify({ knowledgeBudgets: { rule: 39 } }) })
  assert.equal(verdict(lint(env, [`--base=${base}`]), 'config-loosened'), undefined)
})

t('config 6: deleting the file is a loosening when the base set a knowledge key', () => {
  const env = world(GOOD, { merge: 'sequential', target: 'main', featureMap: 'docs/map.md' })
  const base = git(env.repo, ['rev-parse', 'HEAD'])
  git(env.repo, ['rm', '-q', CFG_KEY])
  commit(env.repo, { 'src/none.ts': 'export {}\n' })
  const j = lint(env, [`--base=${base}`])
  assert.equal(j.ok, false)
  assert.match(verdict(j, 'config-loosened').message, /deleted while the base set featureMap/)
})

t('config 7: --slug catches a budget raise committed on the crew branch', () => {
  const { env } = goodWorld()
  const wt = addCrewWorktree(env.repo, 's')
  commit(wt, { [CFG_KEY]: JSON.stringify({ merge: 'sequential', target: 'main', knowledgeBudgets: { agentsIndex: 500 } }) })
  const j = lint(env, ['--slug', 's'])
  assert.equal(j.ok, false)
  assert.match(verdict(j, 'config-loosened').message, /knowledgeBudgets\.agentsIndex raised from 60 to 500/)
})

t('config 8: an untracked truss.json in the main checkout gives no false config-loosened', () => {
  const env = world(GOOD, { merge: 'sequential', target: 'main' })
  git(env.repo, ['rm', '-q', CFG_KEY])
  commit(env.repo, { 'src/none.ts': 'export {}\n' })
  const wt = addCrewWorktree(env.repo, 's')
  commit(wt, { 'src/a.ts': 'export const a = 3\n' })
  writeFileSync(`${env.repo}/${CFG_KEY}`, JSON.stringify({ merge: 'sequential', target: 'main', knowledgeBudgets: { rule: 1 }, rulesDir: 'main-only' }))
  const j = lint(env, ['--slug', 's'])
  assert.equal(verdict(j, 'config-loosened'), undefined, JSON.stringify(j.failures))
  assert.equal(verdict(j, 'config-unverified'), undefined, JSON.stringify(j.failures))
})

t('config 1: a diff against --base that raises a knowledge budget or moves a knowledge path fails config-loosened, and the crew is linted with the base config; tightening passes', () => {
  const cfg = { merge: 'sequential', target: 'main' }
  const env = world(GOOD, cfg)
  const base = git(env.repo, ['rev-parse', 'HEAD'])
  // raise the budget and put AGENTS.md over the default budget of 60 lines
  commit(env.repo, { '.claude/truss.json': JSON.stringify({ ...cfg, knowledgeBudgets: { agentsIndex: 500 } }), 'AGENTS.md': `${GOOD['AGENTS.md']}${lines(80)}` })
  const j = lint(env, [`--base=${base}`])
  assert.equal(j.ok, false)
  assert.ok(j.failures.some((f) => f.check === 'config-loosened' && f.new === true && /knowledgeBudgets\.agentsIndex raised from 60 to 500/.test(f.message)), JSON.stringify(j.failures))
  assert.ok(j.failures.some((f) => f.check === 'over-budget' && f.path === 'AGENTS.md'), 'linted against the base budget')
  // moving a path is a loosening too
  const env2 = world(GOOD, cfg)
  const base2 = git(env2.repo, ['rev-parse', 'HEAD'])
  commit(env2.repo, { '.claude/truss.json': JSON.stringify({ ...cfg, rulesDir: 'elsewhere' }) })
  assert.ok(lint(env2, [`--base=${base2}`]).failures.some((f) => f.check === 'config-loosened' && /rulesDir changed/.test(f.message)))
  // tightening is allowed
  const env3 = world(GOOD, { ...cfg, knowledgeBudgets: { rule: 40 } })
  const base3 = git(env3.repo, ['rev-parse', 'HEAD'])
  commit(env3.repo, { '.claude/truss.json': JSON.stringify({ ...cfg, knowledgeBudgets: { rule: 30 } }) })
  assert.ok(!lint(env3, [`--base=${base3}`]).failures.some((f) => f.check === 'config-loosened'))
})
