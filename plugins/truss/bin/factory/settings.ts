// The repo's truss.json as the factory reads it: merge mode and target, the knowledge doc keys and layout. Split from
// bin/factory/shared.ts (0.32.0 item 8). Never imports factory.ts, whose top-level await would make an import cycle.
import { existsSync } from 'node:fs'
import { configOf, isObj, readJson, repoPathOf } from '../core.ts'
import type { Obj } from '../core.ts'
import { budgetsOf, rulesIndex as knowledgeRulesIndex } from '../knowledge.ts'
import type { KCfg } from '../knowledge.ts'
import { run } from './cli.ts'

// The repo's merge mode and target branch, and where they came from, as `settings` prints them.
export function settingsOf(repo: string): { merge: string; target: string; source: string } {
  let cfg: Obj = {}
  const p = `${repo}/.claude/truss.json`
  if (existsSync(p)) {
    const v = readJson(p)
    if (isObj(v)) cfg = v
  }
  const hasMerge = typeof cfg.merge === 'string' && cfg.merge !== ''
  const hasTarget = typeof cfg.target === 'string' && cfg.target !== ''
  const target = hasTarget ? cfg.target : run(repo, ['branch', '--show-current']).out
  return { merge: hasMerge ? cfg.merge : 'sequential', target, source: hasMerge && hasTarget ? '.claude/truss.json' : hasMerge || hasTarget ? 'mixed' : 'default' }
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
