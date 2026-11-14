// The roles table and the session scripts dir: readRoles, the role defaults, --type and --model overlays, the stage script copy.
// Split from bin/factory/shared.ts (0.32.0 item 8). Never imports factory.ts, whose top-level await would make an import cycle.
import os from 'node:os'
import path from 'node:path'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { CliError, commonDir, flat, isObj, listOf, readJson, usage } from '../core.ts'
import type { Flags, Obj } from '../core.ts'
import { transcriptsOf } from '../transcripts.ts'

// The roles table from <plugin>/workflows/roles.json.
export function readRoles(plugin: string): Obj {
  const v = readJson(`${plugin}/workflows/roles.json`)
  if (!isObj(v)) throw usage('roles.json is not an object')
  return v
}

// The roles table copied for args, with `--type role=agentType` laid on the roles marked typeFromProject: true; resolver follows the role its typeFromProject names.
// The roles table's model and effort for a role; every spawn event carries both, never null (a stage.js agent() call always sets them).
export function roleDefaults(roles: Obj, role: string): { model: string; effort: string } {
  const r = isObj(roles[role]) ? roles[role] : {}
  return { model: typeof r.model === 'string' ? r.model : 'sonnet', effort: typeof r.effort === 'string' ? r.effort : 'medium' }
}
export function rolesWithTypes(plugin: string, types: string[], cfgRoles?: unknown): Obj {
  const roles = readRoles(plugin)
  // ADR-0021 Decision 3: truss.json `roles.build` sets builder (and resolver, which follows it), `roles.test` sets tester; --type wins below.
  if (isObj(cfgRoles)) {
    for (const [key, role] of [['build', 'builder'], ['test', 'tester']] as const) {
      const v = cfgRoles[key]
      if (typeof v === 'string' && v !== '' && isObj(roles[role]) && roles[role].typeFromProject === true) roles[role].agentType = v
    }
    // ADR-0022 U2: `roles.ux` lays on the ux row directly; the ux role has no typeFromProject, so --type ux=... stays refused below.
    if (typeof cfgRoles.ux === 'string' && cfgRoles.ux !== '' && isObj(roles.ux)) roles.ux.agentType = cfgRoles.ux
  }
  for (const t of types) {
    const eq = t.indexOf('=')
    if (eq <= 0 || eq === t.length - 1) throw usage(`--type needs role=agentType, got ${t}`)
    const role = t.slice(0, eq)
    if (!isObj(roles[role])) throw usage(`--type: unknown role ${role}`)
    if (roles[role].typeFromProject !== true) throw usage(`--type: role ${role} does not take a project agent type`)
    roles[role].agentType = t.slice(eq + 1)
  }
  for (const r of Object.values(roles)) if (isObj(r) && typeof r.typeFromProject === 'string' && isObj(roles[r.typeFromProject])) r.agentType = roles[r.typeFromProject].agentType
  return roles
}
// ADR-0026 item 50: start --model <role>=<opus|sonnet>, repeatable, sets roles.<role>.model in `roles` and returns the map,
// which crewEntry lays on members.<role>.model where ## Members gives that role. It is the one way to change a model.
const MODEL_USAGE = 'start --model needs <role>=<opus|sonnet> for a role of the roles table; it sets roles.<role>.model and the ## Members entry, so never edit the args file'
export function modelsOf(f: Flags, roles: Obj): Record<string, string> {
  const out: Record<string, string> = {}
  for (const t of listOf(f, 'model')) {
    const eq = t.indexOf('=')
    const role = eq > 0 ? t.slice(0, eq) : ''
    const model = eq > 0 ? t.slice(eq + 1).toLowerCase() : ''
    if (role === '' || !isObj(roles[role])) throw usage(`${MODEL_USAGE}; got ${t}${role === '' ? '' : ` (unknown role ${role})`}`)
    if (model !== 'opus' && model !== 'sonnet') throw usage(`${MODEL_USAGE}; got ${t}`)
    if (out[role] !== undefined && out[role] !== model) throw usage(`${MODEL_USAGE}; --model gives ${role} both ${out[role]} and ${model}`)
    out[role] = model
    roles[role].model = model
  }
  return out
}
// Copies <plugin>/workflows/<script> byte for byte to <scriptsDir>/truss-<script> and returns that path; without scriptsDir returns the plugin path.
export function scriptPathFor(plugin: string, script: string, scriptsDir: string | undefined): string {
  const src = `${plugin}/workflows/${script}`
  if (scriptsDir === undefined) return src
  if (!existsSync(src)) throw usage(`${src} does not exist`)
  mkdirSync(scriptsDir, { recursive: true })
  const to = `${flat(scriptsDir)}/truss-${script}`
  copyFileSync(src, to)
  return to
}
// The script copy for plan-args and start. An explicit --scripts-dir is used as given, and its failure stays an error. Otherwise the
// session scripts dir comes first; when the sandbox or the file system refuses it (EPERM, ENOTDIR), the copy goes to
// <truss dir>/scripts, which the factory writes anyway and which the session's tools can read, and then to a truss-scripts dir under
// os.tmpdir(), which exists on macOS, Linux and Windows. The plugin's own copy of the script stays the last resort.
export function scriptPathAuto(plugin: string, script: string, explicit: string | undefined, repo: string, dir: string): string {
  if (explicit !== undefined) return scriptPathFor(plugin, script, explicit)
  const sessionDir = sessionScriptsDir(repo, dir)
  if (sessionDir === undefined) return scriptPathFor(plugin, script, undefined)
  const candidates = [sessionDir, `${flat(path.resolve(dir))}/scripts`, `${flat(os.tmpdir())}/truss-scripts`]
  for (const d of candidates) {
    try {
      return scriptPathFor(plugin, script, d)
    } catch (e) {
      if (e instanceof CliError) throw e
    }
  }
  return scriptPathFor(plugin, script, undefined)
}
// The session scripts dir the Workflow tool accepts: <dirname of the main transcript>/<sid>/workflows/scripts, where <sid> is the path
// segment directly under <git common dir>/truss/ of the truss dir (a wave subdir is allowed). undefined when the session is not found.
export function sessionScriptsDir(repo: string, dir: string): string | undefined {
  const rel = path.relative(`${flat(commonDir(repo))}/truss`, path.resolve(dir))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  const sid = flat(rel).split('/')[0] as string
  const main = transcriptsOf(sid).main
  return main === null ? undefined : `${path.posix.dirname(flat(main))}/${sid}/workflows/scripts`
}
