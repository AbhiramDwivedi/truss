// The knowledge commands (ADR-0035): knowledge-lint, the knowledge config gate, gated-merge, knowledge-migrate,
// rules-index, and `stitch` (doc fragments, 0.31.0 item 4). Moved unchanged from bin/factory.ts (0.31.0 item 5). Never imports
// factory.ts, whose top-level await would make an import cycle.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { CliError, configOf, isObj, need, refuse, repoPathOf, str, usage } from '../store.ts'
import type { Flags, Obj } from '../store.ts'
import { lint as knowledgeLint, migrate as knowledgeMigrate, rulesIndex as knowledgeRulesIndex } from '../knowledge.ts'
import type { KCfg, LintResult } from '../knowledge.ts'
import { docOfFragment, stitchTree } from '../fragments.ts'
import { redRecord } from './finish.ts'
import { SLUG } from './plan.ts'
import { worktreesOf } from './retire.ts'
import { crewWorktree, dirOf, knowledgeCfgFrom, knowledgeCfgOf, repoOf, run, settingsOf } from './shared.ts'

// ==== knowledge (ADR-0035) ====

// `knowledge-lint [--base=<sha>] [--repo R] [--slug S [--dir D]]`: exit 0 whether or not it found failures; the caller reads `ok`.
// With --slug it lints the crew worktree (its working tree, HEAD as the head); with no --base the base is `git merge-base <target>
// HEAD` there, and when that does not resolve, the head of the crew's red record in --dir (the crew's head when its red check ran,
// so a later base than the fork point: the output then carries `baseFallback: true`); with neither, a failing result. Without
// --slug it lints the repo's own checkout, against --base when given. With a base the config is the base commit's; a head that
// loosens it or a side git cannot read is a failure. The output carries `base` whenever the lint ran against one.
export function cmdKnowledgeLint(f: Flags): Obj {
  const repo = repoOf(f)
  let at = repo
  let base = str(f, 'base')
  let fallback = false
  if (f.base === true || base === '') throw usage('--base needs a value')
  // the full sha a ref names in the linted checkout, or undefined
  const commitOf = (ref: string): string | undefined => {
    if (ref.startsWith('-')) return undefined
    const r = run(at, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return r.status === 0 && r.out !== '' ? r.out : undefined
  }
  if (f.slug !== undefined) {
    const slug = str(f, 'slug')
    if (slug === undefined || !SLUG.test(slug)) throw usage(`--slug ${String(f.slug)} is not a crew slug`)
    at = crewWorktree(repo, slug)
    if (!existsSync(at)) throw usage(`no crew worktree for ${slug} at ${at}`)
    if (base === undefined) {
      let target = ''
      let targetErr: string | undefined
      try {
        target = settingsOf(repo).target
      } catch (e) {
        if (!(e instanceof CliError)) throw e
        targetErr = e.message
      }
      const mb = target === '' || target.startsWith('-') ? undefined : run(at, ['merge-base', target, 'HEAD'])
      if (mb !== undefined && mb.status === 0 && mb.out !== '') base = mb.out
      else {
        const first = targetErr !== undefined ? `the target could not be read: ${targetErr}` : mb === undefined ? `no usable target (${target === '' ? 'none set' : JSON.stringify(target)})` : `git merge-base ${target} HEAD failed in ${at}${mb.err === '' ? '' : `: ${mb.err.split('\n')[0]}`}`
        const red = f.dir === undefined ? undefined : redRecord(dirOf(f), slug)
        const head = typeof red?.head === 'string' ? red.head : ''
        const second = f.dir === undefined ? 'no --dir, so no red record was read' : red === undefined ? `no red record for ${slug} in ${dirOf(f)}/checks` : head === '' ? `the red record for ${slug} names no head` : commitOf(head) !== undefined ? '' : `the red record head ${head} is not a commit of ${at}`
        // a crew whose base cannot be found is not "lint did not run": it is a failure QC sees
        if (second !== '') return { ok: false, failures: [{ check: 'config-unverified', path: '.claude/truss.json', message: `could not verify the crew's knowledge config: no base for crew ${slug}: ${first}, and ${second}; pass --base`, new: true }], warnings: [], predatingCount: 0, warningCount: 0 }
        base = head
        fallback = true
      }
    }
  }
  if (base !== undefined) {
    const sha = commitOf(base)
    if (sha === undefined) throw usage(`--base ${base} is not a commit of ${at}`)
    base = sha
  }
  if (base === undefined) return knowledgeLint(at, knowledgeCfgOf(repo), undefined)
  // A crew must not loosen the lint that judges it: with a base, the crew is linted against the base commit's config and never
  // against a working tree's. A head config that loosens it, or a side that cannot be read, is a failure, not a lint that did not run.
  const guard = knowledgeConfigGuard(at, base, 'HEAD')
  const res = knowledgeLint(at, guard.baseCfg ?? guard.headCfg ?? knowledgeCfgFrom({}), base)
  const finding = guard.unverified !== undefined
    ? { check: 'config-unverified', message: `could not verify the crew's knowledge config: ${guard.unverified}` }
    : guard.loosened.length > 0
      ? { check: 'config-loosened', message: `the crew loosened its own knowledge lint: ${guard.loosened.join('; ')}. Revert it; the lint runs against the base config` }
      : undefined
  const out: LintResult = finding === undefined ? res : { ...res, ok: false, failures: [...res.failures, { ...finding, path: '.claude/truss.json', new: true }] }
  return { ...out, base, ...(fallback ? { baseFallback: true } : {}) }
}
// Every read the gate makes ignores refs/replace, which a crew's worktree can write and which would show the gate a tree other than the one landing.
export const gateGit = (at: string, args: string[]): ReturnType<typeof run> => run(at, ['--no-replace-objects', ...args])
// ADR-0035: .claude/truss.json as a commit holds it, never as a working tree does.
// A forged tree refuses: a symlink, a blob of another mode, a `.claude` that is not a tree, or a path equal to it only when case-folded
// (a case-insensitive checkout would read that one instead). Never echoes a path the tree holds: it is the crew's text.
function committedTrussJson(at: string, rev: string): { raw?: Obj; absent?: boolean; error?: string } {
  const bad = (why: string): { error: string } => ({ error: `.claude/truss.json at ${rev}: ${why}` })
  const fold = (s: string): string => s.toUpperCase().toLowerCase()
  const entries = (treeish: string): { error: string } | { name: string; mode: string; type: string; sha: string }[] => {
    const ls = gateGit(at, ['ls-tree', '-z', '--full-tree', treeish])
    if (ls.status !== 0) return { error: `could not read .claude/truss.json at ${rev}: ${ls.err.split('\n')[0]}` }
    return ls.out.split('\0').filter(Boolean).map((row) => {
      const tab = row.indexOf('\t')
      const [mode = '', type = '', sha = ''] = row.slice(0, tab).split(' ')
      return { name: row.slice(tab + 1), mode, type, sha }
    })
  }
  const top = entries(rev)
  if (!Array.isArray(top)) return top
  let file: { mode: string; sha: string } | undefined
  for (const d of top.filter((e) => fold(e.name) === '.claude')) {
    if (d.type !== 'tree') return bad(d.name === '.claude' ? '.claude is a symlink or a file, not a directory' : 'a path differs from it only by case')
    const kids = entries(d.sha)
    if (!Array.isArray(kids)) return kids
    const hits = kids.filter((e) => fold(e.name) === 'truss.json')
    if (hits.some((e) => d.name !== '.claude' || e.name !== 'truss.json')) return bad('a path differs from it only by case')
    if (d.name === '.claude') file = hits[0]
  }
  if (file === undefined) return { absent: true }
  if (file.mode !== '100644') return bad(`it must be a regular file (mode 100644), found mode ${file.mode}`)
  const show = gateGit(at, ['cat-file', 'blob', file.sha])
  if (show.status !== 0) return { error: `could not read .claude/truss.json at ${rev}: ${show.err.split('\n')[0]}` }
  try {
    const v = JSON.parse(show.out)
    return isObj(v) ? { raw: v } : { error: `.claude/truss.json at ${rev} is not an object` }
  } catch {
    return { error: `.claude/truss.json at ${rev} is not valid JSON` }
  }
}
// The comparison behind both the lint and the merge gate: commits only. `unverified` says a side could not be read (fail closed);
// `loosened` lists what the head loosens, by key and numeric budget only, because a path value is the crew's own text.
function knowledgeConfigGuard(at: string, base: string, head: string): { baseCfg?: KCfg; headCfg?: KCfg; loosened: string[]; unverified?: string } {
  const b = committedTrussJson(at, base)
  const h = committedTrussJson(at, head)
  const baseCfg = b.error === undefined ? knowledgeCfgFrom(b.raw ?? {}) : undefined
  const headCfg = h.error === undefined ? knowledgeCfgFrom(h.raw ?? {}) : undefined
  if (baseCfg === undefined || headCfg === undefined) return { baseCfg, headCfg, loosened: [], unverified: [b.error, h.error].filter((e) => e !== undefined).join('; ') }
  const loosened: string[] = []
  const pathKeys = ['featureMap', 'productDecisions', 'knowledgeDir', 'rulesDir', 'agentsIndex'] as const
  if (h.absent === true && b.raw !== undefined) {
    const set = ['knowledgeBudgets', ...pathKeys].filter((k) => Object.hasOwn(b.raw as Obj, k))
    if (set.length > 0) loosened.push(`.claude/truss.json deleted while the base set ${set.join(', ')}`)
  }
  for (const k of Object.keys(baseCfg.budgets) as (keyof KCfg['budgets'])[]) {
    if (headCfg.budgets[k] > baseCfg.budgets[k]) loosened.push(`knowledgeBudgets.${k} raised from ${baseCfg.budgets[k]} to ${headCfg.budgets[k]}`)
  }
  for (const k of pathKeys) {
    if (headCfg[k] !== baseCfg[k]) loosened.push(`${k} changed`)
  }
  return { baseCfg, headCfg, loosened }
}
const refusalOf = (g: ReturnType<typeof knowledgeConfigGuard>): string | undefined => {
  if (g.unverified !== undefined) return `knowledge config gate: could not verify .claude/truss.json, so the merge is refused: ${g.unverified}`
  if (g.loosened.length > 0) return `knowledge config gate: a crew cannot make this change to its own knowledge lint: ${g.loosened.join('; ')}. If it is right (a real relocation of the knowledge dir, say), the client makes it on main, outside a crew`
  return undefined
}
// Why this head may not merge, or undefined. Used by every merge path, so each gets the same answer.
export function knowledgeConfigRefusal(at: string, base: string, head: string): string | undefined {
  return refusalOf(knowledgeConfigGuard(at, base, head))
}
// Why `result` (a commit or tree) may not replace the destination's old tip. With `target` (the destination is an integration branch),
// a result that brings no more than the target itself holds passes: the branch only picked up what the target did.
function landingRefusal(at: string, old: string, result: string, target?: string): string | undefined {
  const g = knowledgeConfigGuard(at, old, result)
  if (g.unverified === undefined && g.loosened.length > 0 && target !== undefined) {
    const t = knowledgeConfigGuard(at, target, result)
    if (t.unverified === undefined && t.loosened.length === 0) return undefined
  }
  return refusalOf(g)
}
type MergeSides = { head: string; old: string; base: string; target?: string }
// Resolves the three commits a merge of `branch` into `into` is judged on and refuses on the branch's own change. Its base is the fork from the
// target, also for an integration branch: `into` may be older than a target the branch already holds, and that change is not the branch's own.
function mergeSides(repo: string, branch: string, into: string): { sides?: MergeSides; why?: string } {
  if (branch.startsWith('-') || into === '' || into.startsWith('-')) return { why: 'knowledge config gate: the branch or target name is not usable' }
  const tip = (b: string): string | undefined => {
    const r = gateGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}^{commit}`])
    return r.status === 0 && r.out !== '' ? r.out : undefined
  }
  const head = tip(branch)
  if (head === undefined) return { why: `knowledge config gate: branch ${branch} does not resolve` }
  const old = tip(into)
  if (old === undefined) return { why: `knowledge config gate: branch ${into} does not resolve` }
  const targetName = settingsOf(repo).target
  const targetTip = tip(targetName)
  if (targetTip === undefined) return { why: `knowledge config gate: branch ${targetName} does not resolve` }
  const base = gateGit(repo, ['merge-base', targetTip, head])
  if (base.status !== 0 || base.out === '') return { why: `knowledge config gate: git merge-base ${targetName} ${branch} failed${base.err === '' ? '' : `: ${base.err.split('\n')[0]}`}` }
  const why = knowledgeConfigRefusal(repo, base.out, head)
  if (why !== undefined) return { why }
  return { sides: { head, old, base: base.out, ...(into === targetName ? {} : { target: targetTip }) } }
}
// `knowledge-config-gate --branch B [--into T]`: the check alone, where the merge happens elsewhere (the integration branch before its PR).
// Exit 0 when B may merge into T (default: the target), 1 when not. The result is a merge-tree of the two tips; git before 2.38 has none, so B's head stands in, which can only refuse more.
export function cmdKnowledgeConfigGate(f: Flags): Obj {
  const repo = repoOf(f)
  const branch = need(f, 'branch')
  const into = str(f, 'into') ?? settingsOf(repo).target
  const { sides, why } = mergeSides(repo, branch, into)
  if (sides === undefined) throw refuse({ ok: false, branch, into, why })
  const mt = gateGit(repo, ['merge-tree', '--write-tree', sides.old, sides.head])
  const tree = mt.status === 0 || mt.status === 1 ? mt.out.split('\n')[0]?.trim() : undefined
  const landing = landingRefusal(repo, sides.old, tree === undefined || tree === '' ? sides.head : tree, sides.target)
  if (landing !== undefined) throw refuse({ ok: false, branch, into, why: landing })
  return { ok: true, branch, into, base: sides.base, head: sides.head }
}
// `gated-merge --branch B [--into T] [--ff-only] [--continue]`: the gate and the merge in one process, for the merges neither land nor finish performs.
// A conflict is left for the caller to resolve and `git add`; --continue then judges the resolved index. A refused result is aborted, so nothing lands.
export function cmdGatedMerge(f: Flags): Obj {
  const repo = repoOf(f)
  const branch = need(f, 'branch')
  const into = str(f, 'into') ?? settingsOf(repo).target
  for (const k of ['ff-only', 'continue']) if (f[k] !== undefined && f[k] !== true) throw usage(`--${k} takes no value`)
  const ffOnly = f['ff-only'] === true
  const resume = f.continue === true
  if (ffOnly && resume) throw usage('--ff-only and --continue do not go together')
  const no = (why: string, more: Obj = {}): CliError => refuse({ ok: false, merged: false, branch, into, why, ...more })
  const { sides, why } = mergeSides(repo, branch, into)
  if (sides === undefined) throw no(why ?? 'knowledge config gate: refused')
  const { head, old, target } = sides
  const holder = worktreesOf(repo).find((w) => w.branch === into)
  if (ffOnly) {
    if (gateGit(repo, ['merge-base', '--is-ancestor', old, head]).status !== 0) throw no(`not a fast-forward: ${branch} does not contain the tip of ${into}; merge ${into} into it first`)
    const landing = landingRefusal(repo, old, head, target)
    if (landing !== undefined) throw no(landing)
    if (holder !== undefined) {
      const m = run(holder.path, ['merge', '--ff-only', head])
      if (m.status !== 0) throw no(`git merge --ff-only failed: ${(m.err || m.out).split('\n')[0]}`)
    } else if (run(repo, ['update-ref', `refs/heads/${into}`, head, old]).status !== 0) throw no(`${into} moved during the merge; run this again`)
    return { ok: true, merged: true, branch, into, old, head, mode: 'ff-only' }
  }
  if (holder === undefined) throw no(`no worktree has ${into} checked out`)
  const at = holder.path
  const inProgress = (): string => run(at, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).out
  if (resume) {
    if (inProgress() !== head) throw no(`no merge of ${branch} is in progress in ${into}'s worktree`)
  } else {
    if (inProgress() !== '') throw no(`a merge is already in progress in ${into}'s worktree`)
    // By name, so the message is git's own "Merge branch 'x'"; MERGE_HEAD is then held to the head the gate read.
    const m = run(at, ['merge', '--no-ff', '--no-commit', '--no-edit', branch])
    if (m.status !== 0) {
      const files = run(at, ['-c', 'core.quotepath=off', 'diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean)
      if (files.length > 0) throw no('merge conflict: resolve it, git add the files, then run this command again with --continue', { conflict: true, files })
      run(at, ['merge', '--abort'])
      throw no(`git merge failed: ${(m.err || m.out).split('\n')[0]}`)
    }
    if (inProgress() === '') return { ok: true, merged: true, upToDate: true, branch, into, old, head: old, mode: 'no-ff' }
    if (inProgress() !== head) {
      run(at, ['merge', '--abort'])
      throw no(`${branch} moved during the merge; run this again`)
    }
  }
  const gate = (): void => {
    const tree = gateGit(at, ['write-tree'])
    if (tree.status !== 0 || tree.out === '') throw no(`unresolved paths remain in ${into}'s worktree: ${tree.err.split('\n')[0]}`)
    const landing = landingRefusal(at, old, tree.out, target)
    if (landing === undefined) return
    run(at, ['merge', '--abort'])
    throw no(landing)
  }
  // Refused text for one hook, run by git so core.hooksPath and git's own sh apply. Git before 2.36 has no `git hook`: only a hook that exists then stops the merge.
  const hookRefusal = (name: string, args: string[] = []): string | undefined => {
    const h = run(at, ['hook', 'run', '--ignore-missing', name, ...(args.length > 0 ? ['--', ...args] : [])])
    if (h.status === 0) return undefined
    if (/is not a git command/.test(h.err)) return existsSync(run(at, ['rev-parse', '--path-format=absolute', '--git-path', `hooks/${name}`]).out) ? `the ${name} hook cannot be run: git hook needs git 2.36 or later` : undefined
    const said = h.err || h.out
    return `the ${name} hook refused the merge commit${said === '' ? ', printing nothing' : `: ${said}`}`
  }
  // Git keeps the conflict resolution only while MERGE_HEAD stands, so a refusal on --continue leaves the merge for the retry; a clean merge has nothing to keep.
  const stopped = (why: string): CliError => {
    if (resume) return no(`${why}. The resolved index and MERGE_HEAD are kept: fix that, git add any change, then run this command again with --continue to retry`)
    run(at, ['merge', '--abort'])
    return no(why)
  }
  gate() // first, so a loosening is cleared whatever a hook would say
  // The hooks raw git runs: `git merge` runs pre-merge-commit, `git merge --continue` is `git commit` and runs pre-commit, both then commit-msg.
  // Run here because `git commit` would pick pre-commit for both, and `merge --no-commit` runs neither; hence --no-verify below.
  const msgFile = run(at, ['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_MSG']).out
  const hookWhy = hookRefusal(resume ? 'pre-commit' : 'pre-merge-commit') ?? hookRefusal('commit-msg', [msgFile])
  if (hookWhy !== undefined) throw stopped(hookWhy)
  gate() // again, since a hook can change the index, and this is the tree that lands
  const c = run(at, ['commit', '--no-edit', '--no-verify', '--cleanup=strip'])
  if (c.status !== 0) throw stopped(`git commit failed: ${c.err || c.out || `exit ${c.status} with no output, as from a prepare-commit-msg hook`}`)
  return { ok: true, merged: true, branch, into, old, head: run(at, ['rev-parse', 'HEAD']).out, mode: 'no-ff' }
}
// The target's tip just before `head` reached it and the tip that first held it, from the target's reflog (a commit graph cannot tell them apart after a
// fast-forward). A raw merge leaves this behind; an expired or disabled reflog does not, and that fails closed.
export function preMergeOf(repo: string, target: string, head: string): { old?: string; landed?: string; why?: string } {
  const log = gateGit(repo, ['log', '-g', '--format=%H', `refs/heads/${target}`])
  if (log.status !== 0) return { why: `could not read the reflog of ${target}: ${log.err.split('\n')[0]}` }
  let landed: string | undefined
  for (const sha of log.out.split('\n').filter(Boolean)) {
    if (gateGit(repo, ['merge-base', '--is-ancestor', head, sha]).status === 0) landed = sha
    else return landed === undefined ? { why: `the reflog of ${target} is inconsistent` } : { old: sha, landed }
  }
  return { why: `the reflog of ${target} does not reach back to before the merge` }
}
// `knowledge-migrate [--apply]`: moves the product calls out of the personas into productDecisions; never commits.
export function cmdKnowledgeMigrate(f: Flags): Obj {
  const repo = repoOf(f)
  if (typeof f.apply === 'string' && f.apply !== 'true') throw usage('--apply takes no value')
  return knowledgeMigrate(repo, knowledgeCfgOf(repo), f.apply === true || f.apply === 'true')
}
// `rules-index`: every rule file and its `paths` globs.
export function cmdRulesIndex(f: Flags): Obj {
  const repo = repoOf(f)
  return knowledgeRulesIndex(repo, knowledgeCfgOf(repo))
}

// ==== doc fragments (0.31.0 item 4) ====

// The shared doc a fragment stitches into, or undefined. Shared docs are the feature map, the product decisions file, the
// architecture doc, every knowledge doc and every rule file. A `.d/` dir beside any other markdown file is no fragment dir.
export function sharedDocOf(file: string, cfg: KCfg, arch: string): string | undefined {
  const doc = docOfFragment(file, cfg.rulesDir)
  if (doc === undefined) return undefined
  if (doc === cfg.featureMap || doc === cfg.productDecisions || doc === arch) return doc
  if (doc.startsWith(`${cfg.knowledgeDir}/`) || doc.startsWith(`${cfg.rulesDir}/`)) return doc
  return undefined
}

// `stitch [--repo R] [--dry]`: folds every committed doc fragment in the checkout into its shared doc, deletes the fragments and commits
// the result as one `docs: stitch doc fragments` commit (no commit when there is no fragment). --dry reports and writes
// nothing. Refuses when a stitched doc or tracked fragment has uncommitted changes, so the commit holds only the stitch.
export function cmdStitch(f: Flags): Obj {
  const repo = repoOf(f)
  const cfg = knowledgeCfgOf(repo)
  const arch = repoPathOf(configOf(repo).architecture) ?? 'docs/architecture.md'
  const ls = run(repo, ['-c', 'core.quotepath=off', 'ls-files', '-z', '--cached'])
  if (ls.status !== 0) throw usage(`git ls-files failed: ${ls.err}`)
  const frags = ls.out.split('\0').map((s) => s.trim()).filter((p) => p !== '' && sharedDocOf(p, cfg, arch) !== undefined)
  const plan = stitchTree(repo, frags, { rulesDir: cfg.rulesDir })
  const touched = [...new Set([...plan.stitched.map((s) => s.doc), ...plan.removed])].sort()
  if (f.dry === true || touched.length === 0) return { ok: true, dry: f.dry === true, ...plan, committed: false }
  const dirty = run(repo, ['-c', 'core.quotepath=off', 'status', '--porcelain', '--', ...touched])
  const unclean = dirty.out.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('?? '))
  if (unclean.length > 0) throw refuse({ ok: false, why: 'commit or discard the changes to these docs and fragments first', dirty: unclean })
  const done = stitchTree(repo, frags, { rulesDir: cfg.rulesDir, write: true })
  const add = run(repo, ['add', '-A', '--', ...touched])
  if (add.status !== 0) throw usage(`git add failed: ${add.err}`)
  const c = run(repo, ['commit', '-m', 'docs: stitch doc fragments', '--', ...touched])
  if (c.status !== 0) throw usage(`git commit failed: ${c.err || c.out}`)
  return { ok: true, dry: false, ...done, committed: true, head: run(repo, ['rev-parse', 'HEAD']).out }
}
