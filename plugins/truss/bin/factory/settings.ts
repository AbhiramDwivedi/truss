// The repo's truss.json as the factory reads it: merge mode and target, the knowledge doc keys and layout. Split from
// bin/factory/shared.ts (0.32.0 item 8). Never imports factory.ts, whose top-level await would make an import cycle.
import path from 'node:path'
import { existsSync } from 'node:fs'
import { configOf, isObj, readJson, repoPathOf } from '../core.ts'
import type { Flags, Obj } from '../core.ts'
import { budgetsOf, rulesIndex as knowledgeRulesIndex } from '../knowledge.ts'
import type { KCfg } from '../knowledge.ts'
import { run } from './cli.ts'

// The target a run's plan.json sets (ADR-0053), or undefined: no dir, no plan, a plan that does not parse, or no string `target`.
// plan-check refuses a target that is not a branch name; a bad one found here is ignored, so the config target stands.
export function planTargetOf(dir: string | undefined): string | undefined {
  if (dir === undefined || dir === '') return undefined
  try {
    const p = `${dir}/plan.json`
    if (!existsSync(p)) return undefined
    const v = readJson(p)
    return isObj(v) && typeof v.target === 'string' && v.target !== '' && validBranchName(v.target) ? v.target : undefined
  } catch {
    return undefined
  }
}
// A valid git branch name for a plan target: git check-ref-format --branch's rules, without a git call.
export function validBranchName(name: string): boolean {
  if (name === '' || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name === '@') return false
  if (/[\u0000- \u007f~^:?*[\\]/.test(name) || name.includes('..') || name.includes('@{') || name.includes('//')) return false
  return name.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'))
}
// `settingsOf` for a command whose flags may carry --dir: the plan's target wins when that dir is known.
export function settingsFor(f: Flags, repo: string): ReturnType<typeof settingsOf> {
  const d = f.dir
  return settingsOf(repo, typeof d === 'string' && d !== '' ? path.resolve(d) : undefined)
}

// The repo's merge mode and target branch, and where they came from, as `settings` prints them. ADR-0053: an optional plan.json
// `target` in `dir` (the truss dir) wins over the truss.json target; without a dir the config target stands.
export function settingsOf(repo: string, dir?: string): { merge: string; target: string; source: string } {
  let cfg: Obj = {}
  const p = `${repo}/.claude/truss.json`
  if (existsSync(p)) {
    const v = readJson(p)
    if (isObj(v)) cfg = v
  }
  const hasMerge = typeof cfg.merge === 'string' && cfg.merge !== ''
  const hasTarget = typeof cfg.target === 'string' && cfg.target !== ''
  const planTarget = planTargetOf(dir)
  const target = planTarget ?? (hasTarget ? cfg.target : run(repo, ['branch', '--show-current']).out)
  const hasT = hasTarget || planTarget !== undefined
  return { merge: hasMerge ? cfg.merge : 'sequential', target, source: hasMerge && hasT ? (planTarget !== undefined ? 'plan.json' : '.claude/truss.json') : hasMerge || hasT ? 'mixed' : 'default' }
}

// The knowledge step's doc keys (ADR-0033) as stage.js args: only the ones set to a valid path. adrDir falls back to `adr`, the
// ADR directory key init already writes.
export function docKeysOf(repo: string): { featureMap?: string; adrDir?: string } {
  const cfg = configOf(repo)
  const featureMap = repoPathOf(cfg.featureMap)
  const adrDir = repoPathOf(cfg.adrDir) ?? repoPathOf(cfg.adr)
  return { ...(featureMap === undefined ? {} : { featureMap }), ...(adrDir === undefined ? {} : { adrDir }) }
}
// ADR-0035: the path-scoped knowledge keys of truss.json, each a valid repo path or its default.
export function knowledgeCfgOf(repo: string): KCfg {
  return knowledgeCfgFrom(configOf(repo))
}
export function knowledgeCfgFrom(cfg: Obj): KCfg {
  return {
    featureMap: repoPathOf(cfg.featureMap) ?? 'docs/features.md',
    productDecisions: repoPathOf(cfg.productDecisions) ?? 'docs/knowledge/product-decisions.md',
    knowledgeDir: repoPathOf(cfg.knowledgeDir) ?? 'docs/knowledge',
    rulesDir: repoPathOf(cfg.rulesDir) ?? '.claude/rules',
    agentsIndex: repoPathOf(cfg.agentsIndex) ?? 'AGENTS.md',
    budgets: budgetsOf(cfg.knowledgeBudgets),
  }
}
// The stage args (and plan-args) that carry the knowledge layout, next to featureMap: a path key set to a valid path in truss.json
// always (stage.js and the lint must use the same path even before the file exists), a default one only when its file or dir
// exists; `rules` ([{path, paths}]) only when there are rule files; in the stage args, `knowledgeBudgets` (all six, defaults filled
// in) whenever truss.json sets it.
export function knowledgeArgsOf(repo: string, withRules: boolean): Obj {
  const k = knowledgeCfgOf(repo)
  const cfg = configOf(repo)
  const out: Obj = {}
  for (const key of ['productDecisions', 'agentsIndex', 'rulesDir', 'knowledgeDir'] as const) {
    if (repoPathOf(cfg[key]) !== undefined || existsSync(`${repo}/${k[key]}`)) out[key] = k[key]
  }
  if (withRules && isObj(cfg.knowledgeBudgets)) out.knowledgeBudgets = k.budgets
  if (withRules && out.rulesDir !== undefined) {
    try {
      const rules = knowledgeRulesIndex(repo, k).rules
      if (rules.length > 0) out.rules = rules
    } catch {
      // not a git repo or git failed: the crew runs without the rules list
    }
  }
  return out
}
