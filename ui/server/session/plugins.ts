// Resolves the Truss plugin's declared dependencies (plugin.json `dependencies`) to install paths, so a session in any
// target repo loads them even where they are not enabled. Read-only: never writes settings, never installs.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface LocalPlugin { type: 'local'; path: string }
export interface PluginSet { plugins: LocalPlugin[]; missing: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// A dependency is a string "name" / "name@marketplace" or an object { name, marketplace }.
function depKey(d: unknown): { name: string; key: string } | null {
  if (typeof d === 'string' && d !== '') return { name: d.split('@')[0] as string, key: d }
  if (isObj(d) && typeof d.name === 'string' && d.name !== '') {
    return { name: d.name, key: typeof d.marketplace === 'string' && d.marketplace !== '' ? `${d.name}@${d.marketplace}` : d.name }
  }
  return null
}

function installPath(installed: Record<string, unknown>, d: { name: string; key: string }): string | null {
  const keys = d.key.includes('@') ? [d.key] : Object.keys(installed).filter((k) => k.split('@')[0] === d.name)
  for (const k of keys) {
    const entries = installed[k]
    if (!Array.isArray(entries)) continue
    // user-scope installs first: they are the ones that apply in every repo
    const sorted = [...entries].filter(isObj).sort((a, b) => Number(b.scope === 'user') - Number(a.scope === 'user'))
    for (const e of sorted) if (typeof e.installPath === 'string' && existsSync(e.installPath)) return e.installPath
  }
  return null
}

// The truss plugin first, then each resolvable dependency. `missing` names the dependencies with no usable install.
export function resolvePlugins(pluginPath: string, claudeDir: string): PluginSet {
  const plugins: LocalPlugin[] = [{ type: 'local', path: pluginPath }]
  const missing: string[] = []
  const manifest = readJson(join(pluginPath, '.claude-plugin', 'plugin.json'))
  const deps = isObj(manifest) && Array.isArray(manifest.dependencies) ? manifest.dependencies : []
  if (deps.length === 0) return { plugins, missing }
  const file = readJson(join(claudeDir, 'plugins', 'installed_plugins.json'))
  const installed = isObj(file) && isObj(file.plugins) ? file.plugins : {}
  const seen = new Set<string>([pluginPath])
  for (const raw of deps) {
    const d = depKey(raw)
    if (d === null) continue
    const p = installPath(installed, d)
    if (p === null) missing.push(d.key)
    else if (!seen.has(p)) {
      seen.add(p)
      plugins.push({ type: 'local', path: p })
    }
  }
  return { plugins, missing }
}
