// Pins factory-fixes2 items 14 and 15 (ADR-0019): `claude plugin validate` is clean and the plugin icon is a real PNG.
// Node built-ins only. The plugin root comes from this module's own path, never cwd or git, so a copy of this file
// placed in a base tree validates that base tree.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('plugin validate', () => {
  it('pv 1: claude plugin validate exits 0 and prints no (CODE) warning', async () => {
    let out = ''
    let code: unknown = 0
    try {
      const r = await run('claude', ['plugin', 'validate', ROOT], { encoding: 'utf8', timeout: 120000 })
      out = r.stdout + r.stderr
    } catch (e) {
      const x = e as { stdout?: string; stderr?: string; code?: unknown }
      out = (x.stdout ?? '') + (x.stderr ?? '')
      code = x.code ?? 1
    }
    const warns = out.split('\n').filter((l) => /\([A-Z][A-Z_]+\)/.test(l))
    assert.equal(warns.length, 0, `claude plugin validate warns:\n${warns.join('\n')}`)
    assert.equal(code, 0, `claude plugin validate exited ${String(code)}:\n${out}`)
  })

  it('pv 2: .claude-plugin/icon.png is a square PNG of 512 to 2048 px, under 2 MB', () => {
    const p = join(ROOT, '.claude-plugin', 'icon.png')
    let b: Buffer
    try {
      b = readFileSync(p)
    } catch {
      assert.fail(`${p} is missing (item 14: the icon clears ICON_MISSING)`)
    }
    assert.ok(b.length >= 24 && b.subarray(1, 4).toString() === 'PNG', 'icon.png lacks the PNG signature')
    assert.equal(b.subarray(12, 16).toString(), 'IHDR', 'icon.png has no IHDR chunk')
    const w = b.readUInt32BE(16)
    const h = b.readUInt32BE(20)
    assert.equal(w, h, `icon.png is not square: ${w}x${h}`)
    assert.ok(w >= 512 && w <= 2048, `icon.png side ${w} is outside 512 to 2048`)
    assert.ok(statSync(p).size < 2 * 1024 * 1024, 'icon.png is 2 MB or more')
  })
})
