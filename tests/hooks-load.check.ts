// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// The hooks loader's rule on $ (Claude Code 2.1.316): $ may be passed only to a function declared at the top of
// hooks/register.ts, or to one imported from a file of the module's own. A closure inside register that takes $ makes
// the whole module fail to load, so `claude plugin validate` fails and nearly every plugin test with it.
// This is a static check of the source, so it runs without the harness-only `claude-code` package.
//
// Run with: node --test tests/hooks-load.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const FILE = new URL('../hooks/register.ts', import.meta.url)

// The source with comments and string text blanked to spaces (newlines kept), so a $ in a string or a comment is not
// read as code. Template literals keep their ${...} expressions, which are code.
export function codeOnly(src: string): string {
  const out = src.split('')
  const blank = (i: number) => {
    if (out[i] !== '\n') out[i] = ' '
  }
  let i = 0
  // stack of contexts: 'code' (with brace depth) or 'tpl'
  const stack: { kind: 'code' | 'tpl'; depth: number }[] = [{ kind: 'code', depth: 0 }]
  while (i < src.length) {
    const top = stack[stack.length - 1]
    const c = src[i]
    if (top.kind === 'tpl') {
      if (c === '\\') {
        blank(i)
        blank(i + 1)
        i += 2
      } else if (c === '`') {
        stack.pop()
        i++
      } else if (c === '$' && src[i + 1] === '{') {
        stack.push({ kind: 'code', depth: 0 })
        i += 2
      } else {
        blank(i)
        i++
      }
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') blank(i++)
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      while (i < stop) blank(i++)
    } else if (c === "'" || c === '"') {
      i++
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') blank(i++)
        blank(i++)
      }
      i++
    } else if (c === '`') {
      stack.push({ kind: 'tpl', depth: 0 })
      i++
    } else if (c === '{') {
      top.depth++
      i++
    } else if (c === '}') {
      if (top.depth === 0 && stack.length > 1) stack.pop()
      else top.depth--
      i++
    } else if (c === '/' && /[=(,:;!&|?{}\[]\s*$/.test(src.slice(Math.max(0, i - 20), i))) {
      // a regex literal: blank it up to its closing slash
      i++
      let inClass = false
      while (i < src.length && src[i] !== '\n') {
        if (src[i] === '\\') {
          blank(i++)
          blank(i++)
          continue
        }
        if (src[i] === '[') inClass = true
        else if (src[i] === ']') inClass = false
        else if (src[i] === '/' && !inClass) break
        blank(i++)
      }
      i++
    } else i++
  }
  return out.join('')
}

const isIdent = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$]/.test(c)

// Every call that is handed a bare $ as an argument: the callee's name (or a description when it is not a plain
// name), and the line. Parameter lists ($, e, next) => ... are not calls and are left out.
export function callsTaking$(code: string): { callee: string; line: number }[] {
  const found: { callee: string; line: number }[] = []
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== '$' || isIdent(code[i - 1]) || isIdent(code[i + 1])) continue
    let after = i + 1
    while (/\s/.test(code[after])) after++
    if (code[after] !== ',' && code[after] !== ')') continue
    let before = i - 1
    while (before >= 0 && /\s/.test(code[before])) before--
    if (code[before] !== '(' && code[before] !== ',') continue
    // the open paren of the list this $ sits in
    let depth = 0
    let open = before
    for (; open >= 0; open--) {
      const c = code[open]
      if (c === ')' || c === ']' || c === '}') depth++
      else if (c === '[' || c === '{') {
        if (depth === 0) break
        depth--
      } else if (c === '(') {
        if (depth === 0) break
        depth--
      }
    }
    if (open < 0 || code[open] !== '(') continue
    // its close paren, to tell a parameter list (followed by => or a return type) from a call
    depth = 0
    let close = open
    for (; close < code.length; close++) {
      const c = code[close]
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        depth--
        if (depth === 0) break
      }
    }
    let next = close + 1
    while (/\s/.test(code[next])) next++
    if (code.startsWith('=>', next) || code[next] === ':') continue
    // the callee, skipping type arguments such as refuse<R>(
    let end = open - 1
    while (end >= 0 && /\s/.test(code[end])) end--
    if (code[end] === '>') {
      let angle = 0
      for (; end >= 0; end--) {
        if (code[end] === '>') angle++
        else if (code[end] === '<') {
          angle--
          if (angle === 0) {
            end--
            break
          }
        }
      }
      while (end >= 0 && /\s/.test(code[end])) end--
    }
    let start = end
    while (start >= 0 && isIdent(code[start])) start--
    const name = code.slice(start + 1, end + 1)
    let lead = start
    while (lead >= 0 && /\s/.test(code[lead])) lead--
    const line = code.slice(0, i).split('\n').length
    if (name === '' || /^(if|while|for|switch|return|function|catch)$/.test(name)) continue
    if (code[lead] === '.') found.push({ callee: `.${name}`, line })
    else found.push({ callee: name, line })
  }
  return found
}

// The names the loader accepts: functions declared at the top level of the file (column 0, optionally exported or
// async), a top-level const bound to a function (as failOpen is), and names imported from the module's own files
// (relative imports).
export function topLevelFunctions(code: string): Set<string> {
  const names = new Set<string>()
  for (const m of code.matchAll(/^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) names.add(m[1])
  for (const m of code.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|(?:<[^>]*>)?\([^)]*\)\s*(?::[^=]+)?=>)/gm)) names.add(m[1])
  return names
}

export function ownImports(src: string): Set<string> {
  const names = new Set<string>()
  for (const m of src.matchAll(/^import\s+(?!type\b)\{([^}]*)\}\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+as\s+/)
      const local = (bits[1] ?? bits[0]).replace(/^type\s+/, '').trim()
      if (local !== '' && !part.trim().startsWith('type ')) names.add(local)
    }
  }
  return names
}

export function loaderRefusals(src: string): string[] {
  const code = codeOnly(src)
  const allowed = new Set([...topLevelFunctions(code), ...ownImports(src)])
  return callsTaking$(code)
    .filter(c => !allowed.has(c.callee))
    .map(c => `line ${c.line}: $ is passed to "${c.callee}", which is not a top-level function declaration or an own import`)
}

test('the scanner flags a closure handed $, and passes top-level and imported functions', () => {
  const src = [
    "import { amendPlan } from './intake.ts'",
    'function top($: $, n: number) { return n }',
    'export async function topAsync($: $) {}',
    'const bound = ($: $, n: { error?: unknown }) => {',
    '}',
    'export const register = on => {',
    '  const inner = async ($: $, e) => e',
    "  on('x', async ($, e, next) => {",
    '    top($, 1)',
    '    await topAsync($)',
    '    amendPlan($, e)',
    '    bound($, e)',
    "    const s = `a ${top($, 2)} b ($, c)`",
    "    // inner($, e) in a comment",
    "    const t = 'inner($, e) in a string'",
    '    return inner($, e)',
    '  })',
    '}',
  ].join('\n')
  assert.deepEqual(loaderRefusals(src), ['line 16: $ is passed to "inner", which is not a top-level function declaration or an own import'])
  assert.deepEqual(loaderRefusals(src.replace('return inner($, e)', 'return inner<number>( $ , e)')), ['line 16: $ is passed to "inner", which is not a top-level function declaration or an own import'])
  assert.deepEqual(loaderRefusals(src.replace('return inner($, e)', 'return e')), [])
})

test('hooks/register.ts passes $ only to top-level function declarations or its own imports', () => {
  const src = readFileSync(FILE, 'utf8')
  const calls = callsTaking$(codeOnly(src))
  // the scanner is reading the file: register.ts hands $ to many functions
  assert.ok(calls.length > 50, `found only ${calls.length} calls taking $`)
  assert.deepEqual(loaderRefusals(src), [])
})

test('the refusal helpers are top-level declarations taking state, not closures in register', () => {
  const src = readFileSync(FILE, 'utf8')
  assert.match(src, /^async function noteRefusal\(\$: \$, state: State, /m)
  assert.match(src, /^async function refuse<R>\(\$: \$, state: State, /m)
  // (the verdict functions keep a local refuse(reason) of their own, which takes no $)
  assert.doesNotMatch(src, /^[ \t]+const noteRefusal\s*=/m)
  assert.doesNotMatch(src, /^[ \t]+const refuse\s*=\s*async\b[^\n]*\(\$/m)
})
