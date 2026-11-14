// The doctor command: the retro catalog probes and the role model check. Moved unchanged from bin/factory.ts (0.31.0 item
// 5). Never imports factory.ts, whose top-level await would make an import cycle.
import { CliError, configOf, flat, isObj, refuse, str, usage } from '../core.ts'
import type { Flags, Obj } from '../core.ts'
import type { Catalog } from '../../retro/catalog.ts'
import { runProbe } from './check.ts'
import { retro } from './retro-mods.ts'
import { dirOf, PLUGIN, repoOf } from './cli.ts'
import { loadPlan } from './plan-file.ts'
import { rolesWithTypes } from './roles.ts'

export function cmdDoctor(f: Flags): Obj {
  const dir = dirOf(f)
  const repo = repoOf(f)
  const catPath = str(f, 'catalog')
  if (f.catalog !== undefined && (catPath === undefined || catPath === '')) throw usage('--catalog needs a value')
  let catalog: Catalog
  try {
    catalog = retro().cat.loadCatalog(catPath === undefined ? `${PLUGIN}/retro/catalog.json` : flat(catPath))
  } catch (e) {
    throw usage((e as Error).message)
  }
  const plan = loadPlan(dir)
  const probes: { name: string; kind: string; pass: boolean; detail: string }[] = []
  const allow: string[] = []
  const downloads: string[] = []
  const addOnce = (list: string[], v: unknown): void => {
    if (typeof v === 'string' && v !== '' && !list.includes(v)) list.push(v)
  }
  for (const c of plan.crews) {
    if (!isObj(c) || !Array.isArray(c.needs)) continue
    for (const nd of c.needs) {
      if (!isObj(nd) || !isObj(nd.probe)) continue
      const r = runProbe(nd.probe, repo)
      probes.push({ name: `${String(c.slug)}/${String(nd.id)}`, kind: String(nd.probe.kind), pass: r.pass, detail: r.detail })
      if (Array.isArray(nd.allow)) for (const a of nd.allow) addOnce(allow, a)
      if (!r.pass) addOnce(downloads, nd.download)
    }
  }
  const known: { id: string; pass: boolean }[] = []
  const rulings: { id: string; fix: string }[] = []
  for (const e of catalog.entries) {
    if (e.probe === undefined) continue
    const r = runProbe(e.probe, repo)
    known.push({ id: e.id, pass: r.pass })
    if (!r.pass) rulings.push({ id: e.id, fix: e.fix })
  }
  // a malformed .claude/truss.json is one failed probe, so the other probes still print
  let cfg: Obj = {}
  try {
    cfg = configOf(repo)
  } catch (e) {
    probes.push({ name: 'config', kind: 'config', pass: false, detail: e instanceof CliError && typeof e.body.error === 'string' ? e.body.error : (e as Error).message })
  }
  const failed = probes.filter((p) => !p.pass).map((p) => p.name)
  // contract-025 section 4: with a budget set, a model the roles use that no pricing key covers can't be priced, so every spend would hold
  const warnings: string[] = []
  if (isObj(cfg.budget)) {
    const keys = isObj(cfg.pricing) ? Object.keys(cfg.pricing) : []
    const models = new Set(Object.values(rolesWithTypes(PLUGIN, [], cfg.roles)).filter(isObj).map((r) => r.model).filter((m): m is string => typeof m === 'string'))
    // a pricing key is a model-id prefix; a role names its model by alias (opus, sonnet), so a key that holds the alias covers it
    for (const m of models) if (!keys.some((k) => m.startsWith(k) || k.includes(m))) warnings.push(`budget is set but pricing has no entry for the ${m} model (a key that is a prefix of its id); its spend can't be priced, so the budget holds`)
  }
  const body = { ok: failed.length === 0, probes, passed: probes.filter((p) => p.pass).map((p) => p.name), failed, known, bundle: { allow, downloads, rulings }, ...(warnings.length > 0 ? { warnings } : {}) }
  if (!body.ok) throw refuse(body)
  return body
}
