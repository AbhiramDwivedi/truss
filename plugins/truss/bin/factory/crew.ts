// The crew git commands: sync, integrate, mark-merged, owns-check, owns-extend and tests-check. Moved unchanged from
// bin/factory.ts (0.31.0 item 5). Never imports factory.ts, whose top-level await would make an import cycle.
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { configOf, isObj, need, refuse, repoPathOf, usage } from '../core.ts'
import type { Flags, Obj } from '../core.ts'
import { withLock } from '../lock.ts'
import { concludeFrontmatterMerge, docOfFragment } from '../fragments.ts'
import { knowledgeShas } from './decisions.ts'
import { gateGit, knowledgeConfigRefusal, preMergeOf } from './knowledge-cmds.ts'
import { baseOf, crewWorktree, dirOf, gitOrFail, repoOf, run } from './cli.ts'
import { loadPlan, patchPlan, savePlan } from './plan-file.ts'
import { docKeysOf, knowledgeCfgOf, settingsOf } from './settings.ts'
import { appendDecision } from './log.ts'

// The existing crew worktree for --slug, and the repo and target it belongs to.
function crewCtx(f: Flags): { dir: string; repo: string; slug: string; wt: string; target: string } {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  const repo = repoOf(f)
  const wt = crewWorktree(repo, slug)
  if (!existsSync(wt)) throw usage(`no crew worktree for ${slug} at ${wt}`)
  return { dir, repo, slug, wt, target: settingsOf(repo).target }
}
// Runs a merge in the worktree; on conflict leaves it in progress and refuses with the conflicting paths.
export function mergeIn(wt: string, args: string[]): Obj {
  const r = run(wt, ['merge', '--no-edit', ...args])
  // 0.31.0 item 4 (architecture.md, "Doc fragments"): a conflict confined to YAML frontmatter (two crews re-stamping `verified`, adding `sources`) resolves itself
  if (r.status !== 0 && concludeFrontmatterMerge(wt).concluded) return { merged: true, head: gitOrFail(wt, ['rev-parse', 'HEAD']), frontmatterResolved: true }
  if (r.status !== 0) {
    const conflicts = run(wt, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean)
    if (conflicts.length === 0) throw usage(`git merge ${args.join(' ')} failed: ${r.err || r.out}`)
    throw refuse({ merged: false, conflicts })
  }
  return { merged: true, head: gitOrFail(wt, ['rev-parse', 'HEAD']) }
}
export function cmdSync(f: Flags): Obj {
  const c = crewCtx(f)
  // ADR-0026 item 58: an unconcluded operation (the resolver's merge) is the resolver's to conclude, so sync refuses before any merge
  const inProgress = operationInProgress(c.wt)
  if (inProgress !== undefined) {
    const conflicts = run(c.wt, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean)
    throw refuse({ merged: false, conflicts, inProgress, why: `a ${inProgress} is in progress in ${c.wt}; conclude or abort it before syncing ${c.target}` })
  }
  return mergeIn(c.wt, [c.target])
}
// Commits in HEAD..branch whose message has a `Truss-Crew:` or `Truss-Role:` line that git's trailer parser doesn't see:
// a blank line inside the trailer block, or between it and a later one such as Co-Authored-By. QC reads the role with
// %(trailers:key=Truss-Role), so such a commit would fail as a role violation. `<sha> <subject>` each; [] when the range can't be read.
export function unparsedTrailers(wt: string, branch: string): string[] {
  const r = run(wt, ['log', '--format=%H %s%x1f%(trailers:key=Truss-Crew,valueonly)%x1f%(trailers:key=Truss-Role,valueonly)%x1f%B%x1e', `HEAD..${branch}`])
  if (r.status !== 0) return []
  const missed = (parsed: string | undefined, key: string, body: string | undefined): boolean => String(parsed).trim() === '' && new RegExp(`^${key}:`, 'm').test(String(body))
  return r.out.split('\x1e').map((rec) => rec.replace(/^\n/, '').split('\x1f')).filter((x) => x.length === 4)
    .filter(([, crew, role, body]) => missed(crew, 'Truss-Crew', body) || missed(role, 'Truss-Role', body)).map(([id]) => String(id))
}
// Non-merge commits in HEAD..branch that the target does not hold and that carry neither Truss-Crew nor Truss-Role, `<sha> <subject>`
// each; [] when the range can't be read. A commit already in the target (a main commit that reached the branch by a merge) never counts.
function untrailered(wt: string, target: string, branch: string): string[] {
  // a local branch first, else the target as git names it (origin/main): `refs/heads/origin/main` is a fatal error, which used to read as no commits
  const local = run(wt, ['rev-parse', '-q', '--verify', `refs/heads/${target}^{commit}`]).status === 0
  const not = local ? `refs/heads/${target}` : target
  const r = run(wt, ['log', '--no-merges', '--format=%H %s%x1f%(trailers:key=Truss-Crew,valueonly)%x1f%(trailers:key=Truss-Role,valueonly)%x1e', `HEAD..${branch}`, '--not', not])
  // fail closed: an unreadable range (an unknown target, a bad branch) is no proof that every commit carries a trailer
  if (r.status !== 0) throw refuse({ merged: false, conflicts: [], missingTrailers: [], why: `could not read the commits of ${branch} that ${target} does not hold, so their trailers are unchecked: ${r.err.trim().split('\n')[0] ?? ''}` })
  return r.out.split('\x1e').map((rec) => rec.replace(/^\n/, '').split('\x1f')).filter((x) => x.length === 3)
    .filter(([, crew, role]) => String(crew).trim() === '' && String(role).trim() === '').map(([id]) => String(id))
}
// The git operation left unconcluded in a worktree, if any: a rebase (`rebase-merge` or `rebase-apply` in its git dir, checked
// first since a rebase's own picks and merges can set the heads below), a merge, a cherry-pick or a revert.
export function operationInProgress(wt: string): 'rebase' | 'merge' | 'cherry-pick' | 'revert' | undefined {
  for (const d of ['rebase-merge', 'rebase-apply']) {
    const p = run(wt, ['rev-parse', '--path-format=absolute', '--git-path', d])
    if (p.status === 0 && p.out.trim() !== '' && existsSync(p.out.trim())) return 'rebase'
  }
  const has = (ref: string): boolean => run(wt, ['rev-parse', '-q', '--verify', ref]).status === 0
  if (has('MERGE_HEAD')) return 'merge'
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (has('REVERT_HEAD')) return 'revert'
  return undefined
}
export function cmdIntegrate(f: Flags): Obj {
  const branch = need(f, 'branch')
  const c = crewCtx(f)
  // ADR-0026 item 58 (c), (d), overriding ADR-0025 item 44 ("while one is, mergeIn answers"): with a merge, cherry-pick,
  // revert or rebase unconcluded in the crew worktree, integrate refuses up front, before any git merge or merge-tree, with
  // no conflicts (the paths git lists belong to that operation, not to this branch) and `inProgress` naming it.
  const inProgress = operationInProgress(c.wt)
  if (inProgress !== undefined) {
    throw refuse({ merged: false, conflicts: [], inProgress, why: `a ${inProgress} is in progress in ${c.wt}; conclude or abort it before integrating ${branch}` })
  }
  const trailers = unparsedTrailers(c.wt, branch)
  if (trailers.length > 0) throw refuse({ merged: false, conflicts: [], trailers })
  const missingTrailers = untrailered(c.wt, c.target, branch)
  if (missingTrailers.length > 0) throw refuse({ merged: false, conflicts: [], missingTrailers })
  // ADR-0024 item 32: a branch whose merge would leave the crew head's tree unchanged (one the head already holds, even after a
  // rewrite split its commits) isn't merged. A conflict or a merge-tree failure falls back to the --no-ff merge below.
  const mt = run(c.wt, ['merge-tree', '--write-tree', 'HEAD', branch])
  const tree = mt !== undefined && mt.status === 0 ? mt.out.split('\n')[0]?.trim() : undefined
  if (tree !== undefined && tree !== '') {
    const now = run(c.wt, ['rev-parse', 'HEAD^{tree}'])
    if (now.status === 0 && now.out === tree) return { merged: true, contained: true, head: gitOrFail(c.wt, ['rev-parse', 'HEAD']) }
  }
  return mergeIn(c.wt, ['--no-ff', branch])
}
// Sets a crew merged when truss-<slug> is an ancestor of the target; refuses and changes nothing otherwise.
export function cmdMarkMerged(f: Flags): Obj {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  const repo = repoOf(f)
  const plan = loadPlan(dir)
  const crew = plan.crews.find((x: Obj) => isObj(x) && x.slug === slug)
  if (crew === undefined) throw usage(`no crew ${slug} in the plan`)
  const target = settingsOf(repo).target
  const r = run(repo, ['merge-base', '--is-ancestor', `truss-${slug}`, target])
  if (r.status !== 0) throw refuse({ ok: false, slug, merged: false, why: `truss-${slug} is not an ancestor of ${target}` })
  // ADR-0035: a raw merge cannot be recorded as merged. The same two comparisons as a merge: the crew head against its fork from the target's
  // pre-merge tip, and what landed against that tip. Both from commits; the reflog only says which commit the tip was.
  const crewHead = gateGit(repo, ['rev-parse', '--verify', `refs/heads/truss-${slug}^{commit}`]).out
  const pre = preMergeOf(repo, target, crewHead)
  const fork = pre.old === undefined ? undefined : gateGit(repo, ['merge-base', pre.old, crewHead]).out
  const nextStep = `Next step: this check could not separate the crew's change from the client's. Once the client has confirmed the config change is theirs, the existing recovery is a hand edit of this crew's "status" to "merged" in plan.json.`
  const landedWhy = (old: string, landed: string): string | undefined => {
    const why = knowledgeConfigRefusal(repo, old, landed)
    return why === undefined ? undefined : `${why}. ${nextStep}`
  }
  const cfgWhy = pre.old === undefined || pre.landed === undefined
    ? `knowledge config gate: could not verify .claude/truss.json, so the merge is not recorded: ${pre.why}. ${nextStep}`
    : fork === undefined || fork === ''
      ? `knowledge config gate: truss-${slug} has no fork point with the pre-merge tip of ${target}`
      : (knowledgeConfigRefusal(repo, fork, crewHead) ?? landedWhy(pre.old, pre.landed))
  if (cfgWhy !== undefined) throw refuse({ ok: false, slug, merged: false, why: cfgWhy })
  patchPlan(dir, (p) => { const e = p.crews.find((x: Obj) => isObj(x) && x.slug === slug); if (e !== undefined) e.status = 'merged' })
  appendDecision(dir, `${slug} marked merged | truss-${slug} is an ancestor of ${target}`)
  return { ok: true, slug, status: 'merged' }
}
// Adds one glob to a crew's owns in plan.json under the plan lock, so the PM never hand-edits the plan, and logs a decision line.
// Another crew may own the same files (ADR-0043): the crews merge in turn.
export function cmdOwnsExtend(f: Flags): Obj {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  const glob = need(f, 'glob')
  const reason = need(f, 'reason').replace(/\s+/g, ' ').trim()
  const done = withLock(dir, 'plan', (): Obj => {
    const plan = loadPlan(dir)
    const crew = plan.crews.find((x: Obj) => isObj(x) && x.slug === slug)
    if (crew === undefined) throw usage(`no crew ${slug} in the plan`)
    const owns: string[] = Array.isArray(crew.owns) ? crew.owns.filter((g: unknown) => typeof g === 'string') : []
    if (!owns.includes(glob)) owns.push(glob)
    crew.owns = owns
    savePlan(dir, plan)
    return { ok: true, slug, glob, owns }
  })
  appendDecision(dir, `${slug} owns extended by ${glob.replace(/\s+/g, ' ').replace(/\|/g, '/').trim()} | ${reason}`)
  return done
}
export function cmdOwnsCheck(f: Flags): Obj {
  const c = crewCtx(f)
  const crew = loadPlan(c.dir).crews.find((x: Obj) => isObj(x) && x.slug === c.slug)
  if (crew === undefined) throw usage(`no crew ${c.slug} in the plan`)
  const owns: string[] = Array.isArray(crew.owns) ? crew.owns.filter((g: unknown) => typeof g === 'string') : []
  const files = gitOrFail(c.wt, ['-c', 'core.quotepath=off', 'diff', '--name-only', `${baseOf(c.wt, c.target)}...HEAD`]).split('\n').filter(Boolean)
  // path.matchesGlob's `**` skips dot segments; an owned `**` covers them.
  const owned = (file: string, g: string): boolean => {
    file = file.replace(/\\/g, '/')
    g = g.replace(/\\/g, '/')
    if (g.endsWith('/')) g += '**' // a bare directory entry means dir/**
    if (path.matchesGlob(file, g)) return true
    const i = g.indexOf('**')
    if (i === -1) return false
    const head = g.slice(0, i)
    if (!head.endsWith('/') && head !== '') return false
    const tail = g.slice(i + 2)
    if (tail === '' || tail === '/') return file.startsWith(head) && file.length > head.length
    // `**/rest`: any depth under head, then rest matched on the remaining segments
    const rest = tail.replace(/^\//, '')
    const under = file.slice(head.length)
    if (!file.startsWith(head)) return false
    const segs = under.split('/')
    for (let k = 0; k < segs.length; k++) if (path.matchesGlob(segs.slice(k).join('/'), rest)) return true
    return false
  }
  const allowed = knowledgeDocs(c)
  const outside = files.filter((file) => !owns.some((g) => owned(file, g)) && !allowed.has(file))
  // the files the exemption let through: changed, outside the crew's owns, and exempt (sorted, so the report is stable)
  const exempt = files.filter((file) => !owns.some((g) => owned(file, g)) && allowed.has(file)).sort()
  if (outside.length > 0) throw refuse({ ok: false, outside, exempt })
  return { ok: true, exempt }
}

// ADR-0033, as ADR-0046 item 0 amends it: the doc files any crew commit may change outside the crew's owns. Each crew owns the
// docs of its own work, so a builder updates them in the same change as the code, every round; the knowledge commit is a backstop,
// not the only doc writer. A file is exempt only when ALL hold: it changed in a non-merge commit of the crew; it is a .md file;
// its YAML frontmatter is unchanged (tools, model and descriptions are never a crew's to edit; a knowledge doc's `verified` and
// `sources` excepted); and either it is a free doc (the feature map, featureMap, default docs/features.md; the architecture doc;
// a file under the ADR directory or the knowledge dir; never another .md, a README or a changelog), or it is a
// prompt file (skills/**/SKILL.md, .claude/skills/**, agents/*.md and .claude/agents/*.md, the rules dir, the agents index, the
// product-decisions file) that only the crew's knowledge commit changed and that is no judge (an agent whose name says QC,
// checking, review, judge or product owner). A learned item's target widens nothing. A code file is never exempt.
function knowledgeDocs(c: { dir: string; repo: string; slug: string; wt: string; target: string }): Set<string> {
  const base = baseOf(c.wt, c.target)
  const out = gitOrFail(c.wt, ['-c', 'core.quotepath=off', 'log', '--no-merges', '--name-only', '--format=%x00%H', `${base}..HEAD`])
  const knowledge = new Set(knowledgeShas(c.dir, c.slug))
  const byCrew = new Set<string>()
  // the files some commit other than the crew's knowledge commit changed
  const byMember = new Set<string>()
  for (const chunk of out.split('\0').slice(1)) {
    const [sha = '', ...files] = chunk.split('\n')
    for (const file of files.map((l) => l.trim()).filter(Boolean)) {
      byCrew.add(file)
      if (!knowledge.has(sha.trim())) byMember.add(file)
    }
  }
  const arch = repoPathOf(configOf(c.repo).architecture) ?? 'docs/architecture.md'
  const keys = docKeysOf(c.repo)
  const featureMap = keys.featureMap ?? 'docs/features.md'
  const adrDir = keys.adrDir ?? 'docs/adr'
  const frontmatter = (text: string): string => {
    const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
    if (lines[0]?.trim() !== '---') return ''
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
    return (end < 0 ? lines : lines.slice(0, end + 1)).join('\n')
  }
  const kc = knowledgeCfgOf(c.repo)
  // ADR-0046: every exempt file keeps its YAML frontmatter, except a knowledge doc's `verified` stamp and `sources` list, which
  // knowledge-lint checks and a builder keeps true with its doc change (an indented line under `sources:` belongs to it)
  const kept = (file: string, text: string): string => {
    const fm = frontmatter(text)
    if (!file.startsWith(`${kc.knowledgeDir}/`)) return fm
    let skip = false
    return fm.split('\n').filter((l) => {
      if (/^\S/.test(l)) skip = /^(verified|sources)\s*:/.test(l)
      return !skip
    }).join('\n')
  }
  const frontmatterKept = (file: string): boolean => {
    const was = run(c.wt, ['show', `${base}:${file}`])
    const now = run(c.wt, ['show', `HEAD:${file}`])
    return kept(file, was.status === 0 ? was.out : '') === kept(file, now.status === 0 ? now.out : '')
  }
  const name = (file: string): string => file.split('/').pop() ?? ''
  // free docs: any member may change them with its code, every round
  // (only these: a README, a changelog or any other .md is a crew's to change only when its owns name it)
  // a doc fragment (`docs/features.d/<crew>.md`, `<rulesDir>.d/<area>/<crew>.md`) has the standing of the doc it stitches into
  const fragOf = (file: string): string | undefined => docOfFragment(file, kc.rulesDir)
  const isFreeDoc = (file: string): boolean =>
    file === featureMap || file === arch || file.startsWith(`${adrDir}/`) || file.startsWith(`${kc.knowledgeDir}/`) ||
    fragOf(file) === featureMap || fragOf(file) === arch
  // skills, agents and personas, the rules dir, the agents index and the product-decisions file: prompts other agents run on,
  // so only the crew's knowledge commit may change them outside its owns
  const isPromptDoc = (file: string): boolean =>
    /(^|\/)skills\/(.+\/)?SKILL\.md$/.test(file) || /^\.claude\/skills\//.test(file) || /(^|\/)agents\/[^/]+\.md$/.test(file) ||
    file.startsWith(`${kc.rulesDir}/`) || file === kc.agentsIndex || file === kc.productDecisions
  const isPrompt = (file: string): boolean => isPromptDoc(file) || (fragOf(file) !== undefined && isPromptDoc(fragOf(file) as string))
  // an agent or persona that judges (QC, checking, review, product owner): never a crew's to edit, even in its knowledge commit
  const isJudge = (file: string): boolean => /(^|\/)agents\/[^/]+\.md$/.test(file) && /qc|check|review|judge|product-owner/i.test(name(file))
  const isDoc = (file: string): boolean => {
    if (!file.toLowerCase().endsWith('.md')) return false
    const allowed = isPrompt(file) ? !isJudge(file) && !byMember.has(file) : isFreeDoc(file)
    return allowed && frontmatterKept(file)
  }
  return new Set([...byCrew].filter(isDoc))
}

// Guarded = every file a `Truss-Role: test-writer` commit in <base>..HEAD touched, whatever its name, plus every existing path
// the acceptanceTest names that is a test file by name (isTestPath). Lists every builder or resolver commit there that touched
// one, the check of agents/qc-engineer.md step 8 done before a QC engineer is paid for it. Read oldest first with
// `--name-status -M`: a pure rename (R100) of a guarded file is no touch and the guard follows the new path; a rename with an
// edit, a later edit at the new path, and a delete are touches. A merge commit counts only for the files its resolution changed
// (`--cc`), so integrating a tester's branch is no touch. History is what QC reads, so a later commit that restores the file
// doesn't clear it.
export function cmdTestsCheck(f: Flags): Obj {
  const { touched, tests } = guardedOf(crewCtx(f))
  if (touched.length > 0) throw refuse({ ok: false, touched, tests })
  return { ok: true, tests }
}
// The one guarded-set rule, used by tests-check and by the start entry's `guarded`.
export function guardedOf(c: { dir: string; slug: string; wt: string; target: string }): { touched: Obj[]; tests: string[] } {
  const out = gitOrFail(c.wt, ['-c', 'core.quotepath=off', 'log', '--cc', '--name-status', '-M', '--format=%x00%H %(trailers:key=Truss-Role,valueonly,separator=%x2C)', `${baseOf(c.wt, c.target)}..HEAD`])
  // Oldest first; each entry is a status letter (R keeps its score) with the old path and, for a rename, the new one.
  const commits = out.split('\0').filter((b) => b.trim() !== '').map((b) => {
    const [first = '', ...rest] = b.split('\n')
    const [sha = '', roles = ''] = first.split(' ')
    const entries = rest.filter((l) => l.trim() !== '').map((l) => {
      const [st = '', p1 = '', p2 = ''] = l.split('\t')
      return { st, from: p1, to: st.startsWith('R') || st.startsWith('C') ? p2 : p1 }
    })
    return { sha, roles: roles.split(',').map((r) => r.trim()).filter(Boolean), entries }
  }).reverse()
  // Also guarded: every existing repo-relative path the crew's acceptanceTest names.
  const plan = loadPlan(c.dir)
  const crew = Array.isArray(plan.crews) ? plan.crews.find((x: unknown) => isObj(x) && x.slug === c.slug) : undefined
  const base = baseOf(c.wt, c.target)
  const named = typeof crew?.acceptanceTest === 'string'
    ? crew.acceptanceTest.split(/[\s"'`;&|<>()=]+/).map((t: string) => t.replace(/^\.\//, '')).filter((t: string) => t !== '' && !t.startsWith('/') && !t.startsWith('-') && !t.split('/').includes('..') && (existsSync(`${c.wt}/${t}`) ? statSync(`${c.wt}/${t}`).isFile() : run(c.wt, ['cat-file', '-e', `${base}:${t}`]).status === 0))
    : []
  const guarded = new Set<string>(named.filter(isTestPath))
  const touched: Obj[] = []
  for (const x of commits) {
    const role = x.roles.find((r) => r === 'builder' || r === 'resolver')
    const writer = x.roles.includes('test-writer')
    const files: string[] = []
    for (const e of x.entries) {
      const renamed = e.st.startsWith('R')
      if (writer) {
        if (renamed) guarded.delete(e.from)
        if (!e.st.startsWith('D')) guarded.add(e.to)
        continue
      }
      if (!guarded.has(e.from)) continue
      if (renamed && e.st === 'R100') { guarded.delete(e.from); guarded.add(e.to); continue }
      if (role !== undefined) files.push(e.to)
      if (renamed) { guarded.delete(e.from); guarded.add(e.to) }
    }
    if (role !== undefined && !writer && files.length > 0) touched.push({ commit: x.sha, role, files })
  }
  return { touched, tests: [...guarded].sort() }
}

// A test file by name: basename `.test|spec|check.[cm]?[jt]sx?`, `test_*.py`, `*_test.py|go`, `conftest.py`, or a directory segment
// tests/ test/ __tests__/ spec/ checks/ e2e/ fixtures/.
export function isTestPath(p: string): boolean {
  const parts = p.split('/')
  const b = parts[parts.length - 1] ?? ''
  return /\.(test|spec|check)\.[cm]?[jt]sx?$/.test(b) || /^test_.*\.py$/.test(b) || /_test\.(py|go)$/.test(b) || b === 'conftest.py'
    || parts.slice(0, -1).some((s) => ['tests', 'test', '__tests__', 'spec', 'checks', 'e2e', 'fixtures'].includes(s))
}
