// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0012 Seams, "scrub": stress and boundary checks for retro/scrub.ts (R-32).
// Written from the ADR before retro/ exists. tests/retro-contract.check.ts holds the first-line cases (one email,
// one path, three tokens, the exceptions as written); this file pins every token prefix, both length boundaries,
// the word-start rule, the exception edges and the committed files under retro/.
//
// Run with: node --test tests/retro/scrub.check.ts
// Self-contained on purpose: no shared helper and no import of another check file. retro/scrub.ts is imported inside
// the test that needs it, so a missing file fails that test with "producer missing: retro/scrub.ts".
//
// Nothing here may trip the scrubber itself (this file is scrubbed by its own last test), so every email, home path and
// key=value form is assembled at run time from per-run parts, never written out whole.

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const load = async (file: string) => {
  try {
    return await import(pathToFileURL(join(PLUGIN, 'retro', file)).href)
  } catch (e) {
    assert.fail(`producer missing: retro/${file} (${e?.code ?? e?.message})`)
  }
}
const scrubMod = () => load('scrub.ts')

const hex = (n = 5) => randomBytes(n).toString('hex')
// exactly n characters of [0-9a-f]
const chars = (n: number) => hex(Math.ceil(n / 2)).slice(0, n)
// exactly n characters of [0-9a-f_-], with an underscore and a hyphen inside (n >= 8)
const mixed = (n: number) => {
  const c = chars(n).split('')
  c[3] = '_'
  c[6] = '-'
  return c.join('')
}
const user = () => `u${hex(4)}`
const AT = '@'
const email = (local: string, domain: string) => local + AT + domain
const NOREPLY = email('noreply', 'anthropic.com')
const homeDir = (root: string, name: string, rest = '') => ['', root, name, rest].join('/') // /home/<name>/<rest>

const at = (hits: any[], line: number) => hits.filter((h: any) => h.line === line).map((h: any) => h.kind)

describe('retro/scrub.ts: emails', () => {
  test('different address shapes are reported with their 1-based line and kind email, and clean lines around them are not', async () => {
    const { scrub } = await scrubMod()
    const u = user()
    const lines = [
      'clean line one',
      `contact ${email(u, `corp${hex(3)}.org`)} today`,
      `<${email(`${u}.${hex(2)}+tag${hex(2)}`, `sub.corp${hex(3)}.co.uk`)}>`,
      `"${email(`${u}_${hex(2)}-x`, `d${hex(2)}.io`)}",`,
      'clean line five',
      `mailto:${email(u, `m${hex(3)}.net`)}?subject=x`,
    ]
    const hits = scrub(lines.join('\n'))
    assert.deepEqual(at(hits, 2), ['email'])
    assert.deepEqual(at(hits, 3), ['email'])
    assert.deepEqual(at(hits, 4), ['email'])
    assert.deepEqual(at(hits, 6), ['email'])
    for (const l of [1, 5]) assert.deepEqual(at(hits, l), [], `line ${l} is clean`)
    assert.equal(hits.length, 4)
    assert.ok(hits.every((h: any) => Number.isInteger(h.line) && h.line >= 1))
  })

  test('the exceptions pass: noreply at anthropic.com, example.com, and any .invalid domain', async () => {
    const { scrub } = await scrubMod()
    const u = user()
    const text = [
      `Co-Authored-By: Claude <${NOREPLY}>`,
      `write to ${email(u, 'example.com')} or ${email(`${u}.${hex(2)}`, 'example.com')}`,
      `${email(u, `${hex(3)}.invalid`)} and ${email(u, 'host.invalid')}`,
      `${email(u, `a.b.${hex(3)}.invalid`)}`,
    ].join('\n')
    assert.deepEqual(scrub(text), [])
  })

  test('an exception is the whole address, not a substring: look-alikes still hit', async () => {
    const { scrub } = await scrubMod()
    const u = user()
    const t = hex(3)
    const bad = [
      email('noreply', `anthropic.com.evil${t}.org`),
      email(`x${t}-noreply`, 'anthropic.com'),
      email(`someone${t}`, 'anthropic.com'),
      email(u, `notexample.com`),
      email(u, `example.com.${t}.org`),
      email(u, 'invalid.com'),
      email(u, `${t}.invalid.org`),
    ]
    for (const b of bad) assert.deepEqual(at(scrub(`see ${b} here`), 1), ['email'], b)
    // and one real address next to an allowed one on the same line still hits
    assert.deepEqual(at(scrub(`${NOREPLY} cc ${email(u, `corp${t}.org`)}`), 1), ['email'])
  })
})

describe('retro/scrub.ts: home paths', () => {
  test('/home/<user>/ and /Users/<user>/ are reported with kind home-path, wherever on the line', async () => {
    const { scrub } = await scrubMod()
    const u = user()
    const lines = [
      `see ${homeDir('home', u, `work/${hex(2)}/notes.md`)} for details`,
      `cd ${homeDir('Users', u, `Library/${hex(2)}`)} && ls`,
      `'${homeDir('home', u)}'`,
      'clean',
      `{"cwd":"${homeDir('home', `${u}-${hex(2)}`, 'p')}"}`,
    ]
    const hits = scrub(lines.join('\n'))
    for (const l of [1, 2, 3, 5]) assert.deepEqual(at(hits, l), ['home-path'], `line ${l}`)
    assert.deepEqual(at(hits, 4), [])
    assert.equal(hits.length, 4)
  })

  test('the literal /home/<name>/ placeholder, ~ paths and look-alike directories pass; a real path next to a placeholder hits', async () => {
    const { scrub } = await scrubMod()
    const u = user()
    const placeholder = ['', 'home', '<name>', 'project'].join('/')
    const placeholderMac = ['', 'Users', '<name>', 'project'].join('/')
    const clean = [`the path ${placeholder} is a placeholder`, `and ${placeholderMac}`, `~/work/${hex(3)} and ./${hex(3)}`, `/homework/${u}/x`, `/usr/home-${u}/x`].join('\n')
    assert.deepEqual(scrub(clean), [])
    assert.deepEqual(at(scrub(`${placeholder} then ${homeDir('home', u, 'x')}`), 1), ['home-path'])
  })
})

describe('retro/scrub.ts: tokens by prefix, with the 20-character boundary', () => {
  const PREFIXES = ['sk-', 'ghp_', 'gho_', 'ghs_', 'github_pat_', 'xox', 'AKIA']

  test('each prefix followed by 20 characters is a token; 19 is not; 40 is; _ and - count as token characters', async () => {
    const { scrub } = await scrubMod()
    for (const p of PREFIXES) {
      const text = [
        `first clean line ${hex(2)}`,
        `see ${p}${chars(20)} now`,
        `see ${p}${chars(19)} now`,
        `see ${p}${chars(40)} now`,
        `see ${p}${mixed(20)} now`,
        `see ${p}${mixed(19)} now`,
        `quoted "${p}${chars(24)}",`,
        p,
        `${p} ${chars(30)}`,
      ].join('\n')
      const hits = scrub(text)
      assert.deepEqual(at(hits, 2), ['token'], `${p} + 20`)
      assert.deepEqual(at(hits, 3), [], `${p} + 19 is below the boundary`)
      assert.deepEqual(at(hits, 4), ['token'], `${p} + 40`)
      assert.deepEqual(at(hits, 5), ['token'], `${p} + 20 with _ and -`)
      assert.deepEqual(at(hits, 6), [], `${p} + 19 with _ and -`)
      assert.deepEqual(at(hits, 7), ['token'], `${p} in quotes`)
      assert.deepEqual(at(hits, 8), [], `${p} alone`)
      assert.deepEqual(at(hits, 9), [], `${p} then a space ends the token`)
      assert.equal(hits.length, 4, p)
    }
  })

  test('the prefix must start a word: the same prefix inside another word is no token', async () => {
    const { scrub } = await scrubMod()
    for (const p of PREFIXES) assert.deepEqual(scrub(`word Z${p}${chars(24)} end`), [], `Z${p}`)
    assert.deepEqual(scrub(`the task-${chars(24)} and risk-${chars(24)}`), [], 'task- and risk- end in sk-')
  })

  test('a token and an email on one line are both reported; calling scrub again gives the same answer (no regex state)', async () => {
    const { scrub } = await scrubMod()
    const u = user()
    const dirty = `${email(u, `corp${hex(3)}.org`)} ${PREFIXES_FIRST()}${chars(20)}\nline two\n${homeDir('home', u, 'x')}`
    const first = scrub(dirty)
    assert.deepEqual(at(first, 1).sort(), ['email', 'token'])
    assert.deepEqual(at(first, 3), ['home-path'])
    for (let n = 0; n < 4; n++) {
      assert.deepEqual(scrub(dirty), first, `call ${n + 2}`)
      assert.deepEqual(scrub(`clean ${hex(3)}`), [])
    }
    assert.deepEqual(
      first.map((h: any) => h.line),
      [...first.map((h: any) => h.line)].sort((a: number, b: number) => a - b),
      'hits come in line order',
    )
  })
})

function PREFIXES_FIRST() {
  return 'gh' + 'p_'
}

describe('retro/scrub.ts: key words followed by = or : and 16 characters', () => {
  const WORDS = ['token', 'secret', 'password', 'api_key', 'apikey']

  test('each key word with = or : (with or without spaces) and 16 characters hits; 15 does not', async () => {
    const { scrub } = await scrubMod()
    for (const w of WORDS) {
      const seps = ['=', ':', ' = ', ': ']
      for (const sep of seps) {
        const hit = scrub(`cfg ${w}${sep}${chars(16)} end`)
        assert.deepEqual(at(hit, 1), ['token'], `${w}${JSON.stringify(sep)} + 16`)
        assert.deepEqual(at(scrub(`cfg ${w}${sep}${chars(15)} end`), 1), [], `${w}${JSON.stringify(sep)} + 15`)
        assert.deepEqual(at(scrub(`cfg ${w}${sep}${mixed(16)} end`), 1), ['token'], `${w}${JSON.stringify(sep)} + 16 with _ and -`)
        assert.deepEqual(at(scrub(`cfg ${w}${sep}${mixed(15)} end`), 1), [], `${w}${JSON.stringify(sep)} + 15 with _ and -`)
      }
      assert.deepEqual(at(scrub(`${w}=${chars(40)}`), 1), ['token'], `${w} + 40`)
    }
  })

  test('a key word with no = or :, or alone in prose, is no token', async () => {
    const { scrub } = await scrubMod()
    for (const w of WORDS) {
      assert.deepEqual(scrub(`the ${w} ${chars(30)} is fine`), [], `${w} then a space only`)
      assert.deepEqual(scrub(`the ${w} is rotated every ${chars(2)} days; ${w}s differ`), [], `${w} in prose`)
      assert.deepEqual(scrub(`${w}=`), [], `${w}= with nothing after`)
      assert.deepEqual(scrub(`${w}: <redacted>`), [], `${w}: with a placeholder`)
    }
  })

  test('the hit is on the right line of several, and one line with a prefix token and a key-word token is still a token line', async () => {
    const { scrub } = await scrubMod()
    const text = ['a', `b ${WORDS[0]}=${chars(16)}`, 'c', 'd', `e ${WORDS[4]}: ${chars(18)}`, `f ${PREFIXES_FIRST()}${chars(20)} ${WORDS[1]}=${chars(16)}`].join('\n')
    const hits = scrub(text)
    assert.deepEqual(at(hits, 2), ['token'])
    assert.deepEqual(at(hits, 5), ['token'])
    assert.ok(at(hits, 6).length >= 1 && at(hits, 6).every((k: string) => k === 'token'), 'line 6 holds a prefix token and a key-word token')
    for (const l of [1, 3, 4]) assert.deepEqual(at(hits, l), [])
  })
})

describe('retro/scrub.ts: shape of the answer, line endings and size', () => {
  test('empty text and clean text give an empty array; CRLF and a missing final newline keep 1-based line numbers', async () => {
    const { scrub } = await scrubMod()
    const u = user()
    assert.deepEqual(scrub(''), [])
    assert.deepEqual(scrub('\n\n\n'), [])
    const crlf = ['a', 'b', `c ${email(u, `corp${hex(3)}.org`)}`, 'd', `e ${PREFIXES_FIRST()}${chars(20)}`].join('\r\n')
    const hits = scrub(crlf)
    assert.deepEqual(at(hits, 3), ['email'])
    assert.deepEqual(at(hits, 5), ['token'])
    assert.equal(hits.length, 2)
    const blank = `\n\n${homeDir('home', u, 'x')}\n\n`
    assert.deepEqual(at(scrub(blank), 3), ['home-path'])
  })

  test('every hit is {line, kind} with a kind from the three the ADR names', async () => {
    const { scrub } = await scrubMod()
    const u = user()
    const hits = scrub([email(u, `corp${hex(3)}.org`), homeDir('Users', u, 'x'), `${PREFIXES_FIRST()}${chars(20)}`, `api_key=${chars(16)}`].join('\n'))
    assert.equal(hits.length, 4)
    for (const h of hits) {
      assert.ok(['email', 'home-path', 'token'].includes(h.kind), h.kind)
      assert.ok(Number.isInteger(h.line) && h.line >= 1 && h.line <= 4)
    }
    assert.deepEqual(hits.map((h: any) => h.line), [1, 2, 3, 4])
    assert.deepEqual(hits.map((h: any) => h.kind), ['email', 'home-path', 'token', 'token'])
  })

  test('long lines finish: 30,000 characters with no at-sign, with at-signs, and with a prefix run', { timeout: 30000 }, async () => {
    const { scrub } = await scrubMod()
    const t0 = Date.now()
    assert.deepEqual(scrub('a'.repeat(30000)), [])
    assert.deepEqual(scrub('a.'.repeat(15000)), [])
    assert.ok(Array.isArray(scrub((hex(2) + AT).repeat(8000))), 'at-signs without a domain finish')
    assert.ok(Array.isArray(scrub('sk-'.repeat(10000))), 'a prefix run finishes')
    assert.deepEqual(scrub('x'.repeat(30000) + `\n${PREFIXES_FIRST()}${chars(20)}`).map((h: any) => h.line), [2])
    assert.ok(Date.now() - t0 < 25000, 'under 25 seconds in all')
  })
})

describe('retro/ as committed: every file scrubs clean (R-32)', () => {
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '__pycache__' || e.name === '.git') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) out.push(...walk(p))
      else if (e.isFile()) out.push(p)
    }
    return out.sort()
  }

  test('every file under retro/ holds no email, home path or token, and the five producers are there', async () => {
    const { scrub } = await scrubMod()
    const dir = join(PLUGIN, 'retro')
    if (!existsSync(dir)) assert.fail('producer missing: retro/ (the directory does not exist)')
    const files = walk(dir)
    const rel = files.map(f => relative(dir, f))
    for (const need of ['catalog.json', 'catalog.ts', 'cli.ts', 'extract.ts', 'scrub.ts']) {
      if (!rel.includes(need)) assert.fail(`producer missing: retro/${need}`)
    }
    const dirty: string[] = []
    for (const f of files) {
      const text = readFileSync(f, 'utf8')
      for (const h of scrub(text)) dirty.push(`${relative(PLUGIN, f)}:${h.line} | ${h.kind}`)
    }
    assert.deepEqual(dirty, [], 'committed files under retro/ must scrub clean')
  })

  test('the checks under tests/retro/ scrub clean too', async () => {
    const { scrub } = await scrubMod()
    const dir = join(PLUGIN, 'tests', 'retro')
    const files = walk(dir).filter(f => f.endsWith('.check.ts') && statSync(f).isFile())
    assert.ok(files.length >= 4, 'the four check files are there')
    const dirty: string[] = []
    for (const f of files) for (const h of scrub(readFileSync(f, 'utf8'))) dirty.push(`${relative(PLUGIN, f)}:${h.line} | ${h.kind}`)
    assert.deepEqual(dirty, [])
  })
})
