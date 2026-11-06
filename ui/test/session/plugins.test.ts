// resolvePlugins: the Truss plugin's dependencies resolved from installed_plugins.json, read-only, in temp dirs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { resolvePlugins } = (await import(pathToFileURL(path.join(uiDir, 'server/session/plugins.ts')).href)) as any
const { foldMessage, initialView } = (await import(pathToFileURL(path.join(uiDir, 'server/session/fold.ts')).href)) as any

function fixture(manifest: unknown, installed: string | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-ui-plugins-'))
  const plugin = path.join(root, 'truss')
  fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true })
  fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest))
  const claude = path.join(root, 'claude')
  fs.mkdirSync(path.join(claude, 'plugins'), { recursive: true })
  if (installed !== null) fs.writeFileSync(path.join(claude, 'plugins', 'installed_plugins.json'), installed)
  return { root, plugin, claude }
}
const dep = (name: string) => ({ name, marketplace: 'ops', version: '^1' })

test('a found dependency is passed as an extra local plugin', () => {
  const f = fixture({ name: 'truss', dependencies: [dep('kit')] }, null)
  const kit = path.join(f.root, 'kit-install')
  fs.mkdirSync(kit)
  fs.writeFileSync(path.join(f.claude, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'kit@ops': [{ scope: 'local', installPath: path.join(f.root, 'gone') }, { scope: 'user', installPath: kit }] } }))
  const r = resolvePlugins(f.plugin, f.claude)
  assert.deepEqual(r.plugins, [{ type: 'local', path: f.plugin }, { type: 'local', path: kit }])
  assert.deepEqual(r.missing, [])
  fs.rmSync(f.root, { recursive: true, force: true })
})

test('a missing dependency does not crash and is reported', () => {
  const f = fixture({ name: 'truss', dependencies: [dep('kit')] }, JSON.stringify({ version: 2, plugins: {} }))
  const r = resolvePlugins(f.plugin, f.claude)
  assert.deepEqual(r.plugins, [{ type: 'local', path: f.plugin }])
  assert.deepEqual(r.missing, ['kit@ops'])
  fs.rmSync(f.root, { recursive: true, force: true })
})

test('a malformed or absent installed_plugins.json leaves only the plugin and reports every dependency', () => {
  for (const bad of ['{not json', '[]', null]) {
    const f = fixture({ name: 'truss', dependencies: [dep('kit'), 'worktrees'] }, bad)
    const r = resolvePlugins(f.plugin, f.claude)
    assert.deepEqual(r.plugins, [{ type: 'local', path: f.plugin }])
    assert.deepEqual(r.missing, ['kit@ops', 'worktrees'])
    fs.rmSync(f.root, { recursive: true, force: true })
  }
})

test('a plugin.json with no dependencies yields just the plugin', () => {
  const f = fixture({ name: 'truss' }, '{bad')
  assert.deepEqual(resolvePlugins(f.plugin, f.claude), { plugins: [{ type: 'local', path: f.plugin }], missing: [] })
  fs.rmSync(f.root, { recursive: true, force: true })
})

test("init's plugin_errors messages are kept beside the session view", () => {
  const msg = { type: 'system', subtype: 'init', session_id: 's', plugins: [], plugin_errors: [{ plugin: 'truss@inline', type: 'dependency-unsatisfied', message: 'Dependency "kit@ops" is not installed' }] }
  const v = foldMessage(initialView(), msg, [])
  assert.deepEqual(v.pluginErrors, ['Dependency "kit@ops" is not installed'])
  assert.equal(v.session.plugin, null)
  assert.deepEqual(foldMessage(initialView(), { ...msg, plugin_errors: undefined }, []).pluginErrors, [])
})
