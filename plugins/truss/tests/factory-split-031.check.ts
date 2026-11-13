// 0.31.0 item 5: bin/factory.ts is a thin dispatcher and each command group lives in its own module under bin/factory/, so two
// crews rarely change the same file. This pins the structure; the rest of the suite pins the behaviour.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const BIN = new URL('../bin/', import.meta.url)
const MODULES = [
  'shared', 'runs', 'retro-mods', 'plan', 'check', 'doctor', 'crew', 'start', 'warnings', 'personas', 'resources', 'heavy', 'gates',
  'finish', 'audit', 'retire', 'decide', 'decisions', 'knowledge-cmds',
]
// The only functions factory.ts declares: the dispatch around the command table and the CLI flags it handles itself.
const DISPATCH = ['positionalsToFlags', 'attach', 'main', 'statusLine', 'takeStatusFlag', 'takeReapFlag', 'reapFirst']
const src = (rel: string): string => readFileSync(new URL(rel, BIN), 'utf8')
const declared = (text: string): string[] =>
  [...text.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([\w$]+)/gm)].map((m) => m[1] as string)
const importsFactory = (text: string): string[] =>
  [...text.matchAll(/(?:\bimport|\bexport)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((m) => (m[1] ?? m[2]) as string).filter((s) => /(^|\/)factory(\.ts)?$/.test(s))

test('factory split 1: factory.ts is a thin dispatcher: under 400 lines and no command bodies', () => {
  const text = src('factory.ts')
  const lines = text.split('\n').length
  assert.ok(lines < 400, `bin/factory.ts has ${lines} lines; a command body belongs in a bin/factory/<group>.ts module`)
  assert.deepEqual(declared(text).filter((n) => !DISPATCH.includes(n)), [], 'bin/factory.ts declares a function outside the dispatcher')
  assert.doesNotMatch(text, /^(?:export\s+)?(?:async\s+)?function\s+cmd/m, 'bin/factory.ts declares a cmd* command body')
})

test('factory split 2: each command module exists, and the command table takes every core command from one', () => {
  for (const m of MODULES) assert.ok(existsSync(new URL(`factory/${m}.ts`, BIN)), `bin/factory/${m}.ts is missing`)
  const extra = readdirSync(new URL('factory/', BIN)).filter((n) => n.endsWith('.ts') && !MODULES.includes(n.slice(0, -3)))
  assert.deepEqual(extra, [], 'a module in bin/factory/ this test does not know: add it to MODULES and to architecture.md')
  const text = src('factory.ts')
  const table = text.slice(text.indexOf('const CORE_COMMANDS'), text.indexOf('\n}\n', text.indexOf('const CORE_COMMANDS')))
  const cmds = [...new Set([...table.matchAll(/\b(cmd[A-Z][\w$]*)\b/g)].map((m) => m[1] as string))]
  assert.ok(cmds.length > 30, `only ${cmds.length} cmd* names in CORE_COMMANDS`)
  for (const c of cmds) assert.match(text, new RegExp(`^import \\{[^}]*\\b${c}\\b[^}]*\\} from '\\./factory/[\\w-]+\\.ts'`, 'm'), `${c} is not imported from a bin/factory/ module`)
  const owners = cmds.map((c) => MODULES.filter((m) => new RegExp(`^export function ${c}\\(`, 'm').test(src(`factory/${m}.ts`))))
  owners.forEach((o, i) => assert.equal(o.length, 1, `${cmds[i]} is declared in ${o.length} modules`))
})

test('factory split 3: no module in bin/factory/ imports factory.ts (its top-level await would make an import cycle)', () => {
  assert.deepEqual(importsFactory(`import { main } from '../factory.ts'\n`), ['../factory.ts'], 'the scanner misses a planted import')
  for (const m of MODULES) assert.deepEqual(importsFactory(src(`factory/${m}.ts`)), [], `bin/factory/${m}.ts imports factory.ts`)
})
