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
  const PREFIXES = ['sk-', 'ghp_', 'gho_', 'ghs_', 'github_pat_', 'xox', 'AKIA', 'glpat-', 'npm_']

  test('each prefix followed by 20 characters (AKIA: 16) is a token; one fewer is not; 40 is; _ and - count as token characters', async () => {
    const { scrub } = await scrubMod()
    for (const p of PREFIXES) {
      // a real AWS key id is AKIA plus 16 characters (20 in all); the other prefixes need 20 after them
      const n = p === 'AKIA' ? 16 : 20
      const text = [
        `first clean line ${hex(2)}`,
        `see ${p}${chars(n)} now`,
        `see ${p}${chars(n - 1)} now`,
        `see ${p}${chars(40)} now`,
        `see ${p}${mixed(n)} now`,
        `see ${p}${mixed(n - 1)} now`,
        `quoted "${p}${chars(24)}",`,
        p,
        `${p} ${chars(30)}`,
      ].join('\n')
      const hits = scrub(text)
      assert.deepEqual(at(hits, 2), ['token'], `${p} + ${n}`)
      assert.deepEqual(at(hits, 3), [], `${p} + ${n - 1} is below the boundary`)
      assert.deepEqual(at(hits, 4), ['token'], `${p} + 40`)
      assert.deepEqual(at(hits, 5), ['token'], `${p} + ${n} with _ and -`)
      assert.deepEqual(at(hits, 6), [], `${p} + ${n - 1} with _ and -`)
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

// ---------- stress fixes: more token forms, pins, encoded dirs, person names, Windows paths ----------
// Every plant is per run and assembled from parts, so this file scrubs clean itself.

const alpha = (n: number) => Array.from(randomBytes(n), b => String.fromCharCode(97 + (b % 26))).join('')
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)
const BS = '\\'
const HOME = ['', 'ho' + 'me', ''].join('/') // /home/
const ENC = '-ho' + 'me-'

describe('retro/scrub.ts: bearer values, JWTs and secret key names', () => {
  test('a Bearer value of 30 characters and a three-part eyJ token hit; short values, bare words and prose do not', async () => {
    const { scrub } = await scrubMod()
    const lines = [
      `Authorization: Bearer ${chars(30)}`, // 1
      `Authorization: Bearer eyJ${chars(20)}.eyJ${chars(20)}.${chars(20)}`, // 2
      `jwt eyJ${chars(20)}.${chars(20)}.${chars(20)} end`, // 3
      `Authorization: Bearer ${chars(6)}`, // 4: too short
      'the Bearer of the news', // 5
      'Bearer', // 6
      `eyJ${chars(4)} alone`, // 7
      `clean ${chars(12)}`, // 8
    ]
    const hits = scrub(lines.join('\n'))
    for (const l of [1, 2, 3]) assert.deepEqual(at(hits, l), ['token'], `line ${l}`)
    for (const l of [4, 5, 6, 7, 8]) assert.deepEqual(at(hits, l), [], `line ${l} is clean`)
  })

  test('a secret key name with a word tail before the separator hits like the bare key word; a tail with no separator does not', async () => {
    const { scrub } = await scrubMod()
    const hit = [`aws_secret_access_key = ${chars(30)}`, `aws_secret_access_key=${chars(30)}`, `client_secret: ${chars(20)}`, `refresh_token="${chars(24)}"`]
    for (const h of hit) assert.deepEqual(at(scrub(h), 1), ['token'], h)
    const clean = [`aws_secret_access_key = ${chars(8)}`, 'the secret_santa list is fun', `secret_rotation is weekly ${chars(30)}`]
    for (const c of clean) assert.deepEqual(scrub(c), [], c)
  })
})

// ---------- R-32 widening: "/" and "+" continue a value after a key word ----------
describe('retro/scrub.ts: a key-word value may hold / and + (R-32)', () => {
  const WORDS = ['token', 'secret', 'password', 'api_key', 'apikey']
  const SEPS = ['=', ':', ' = ', ': ']
  const rnd = (lo: number, hi: number) => lo + (randomBytes(1)[0] % (hi - lo + 1)) // inclusive
  // a value of n characters with `sepChar` at a random index 1..15
  const split = (n: number, sepChar: string) => {
    const v = chars(n)
    const k = rnd(1, 15)
    return { value: v.slice(0, k) + sepChar + v.slice(k + 1), k }
  }

  test('each key word and separator: a 16+ character value with / or + at a random index under 16 hits', async () => {
    const { scrub } = await scrubMod()
    for (const w of WORDS) {
      for (const sep of SEPS) {
        for (const ch of ['/', '+']) {
          for (const n of [16, 16 + rnd(1, 20)]) {
            const { value, k } = split(n, ch)
            const line = `cfg ${w}${sep}${value} end`
            assert.deepEqual(at(scrub(line), 1), ['token'], `${w}${JSON.stringify(sep)} ${ch} at ${k}, length ${n}`)
          }
        }
      }
    }
  })

  test('a 40 character base64-shaped value with several / and + hits for every key word and separator', async () => {
    const { scrub } = await scrubMod()
    for (const w of WORDS) {
      for (const sep of SEPS) {
        const c = chars(40).split('')
        const spots = new Set<number>()
        while (spots.size < 6) spots.add(rnd(1, 38))
        let i = 0
        for (const s of spots) c[s] = i++ % 2 ? '/' : '+'
        const value = c.join('')
        assert.equal(value.length, 40)
        assert.deepEqual(at(scrub(`${w}${sep}${value}`), 1), ['token'], `${w}${JSON.stringify(sep)} ${value.length} chars`)
      }
    }
  })

  test('a secret access key name with / or + at a random index under 16 hits', async () => {
    const { scrub } = await scrubMod()
    for (const ch of ['/', '+', randomBytes(1)[0] % 2 ? '/' : '+']) {
      const { value, k } = split(40, ch)
      assert.deepEqual(at(scrub(`aws_secret_access_key = ${value}`), 1), ['token'], `${ch} at ${k}`)
    }
  })

  test('negatives stay clean: short value, key named in prose, secret_santa, and under 16 counted characters with / or +', async () => {
    const { scrub } = await scrubMod()
    assert.deepEqual(scrub(`aws_secret_access_key = ${chars(8)}`), [])
    assert.deepEqual(scrub('set aws_secret_access_key in your shell config'), [])
    assert.deepEqual(scrub('the secret_santa list is fun'), [])
    for (const w of WORDS) {
      for (const sep of SEPS) {
        for (const ch of ['/', '+']) {
          const value = chars(7) + ch + chars(7) // 15 counted characters
          assert.equal(value.length, 15)
          assert.deepEqual(scrub(`cfg ${w}${sep}${value} end`), [], `${w}${JSON.stringify(sep)} 15 with ${ch}`)
        }
      }
    }
  })

  test('scope boundary: a prefix token of 10 characters, a slash, then 10 more is no token; Bearer still takes / and +', async () => {
    const { scrub } = await scrubMod()
    assert.deepEqual(scrub(`${PREFIXES_FIRST()}${chars(10)}/${chars(10)}`), [])
    assert.deepEqual(scrub(`${PREFIXES_FIRST()}${chars(10)}+${chars(10)}`), [])
    for (const ch of ['/', '+']) {
      assert.deepEqual(at(scrub(`Authorization: Bearer ${chars(15)}${ch}${chars(15)}`), 1), ['token'], `Bearer with ${ch}`)
    }
  })
})

describe('retro/scrub.ts: a package pin is not an email', () => {
  test('name@version pins are clean, a real address next to a pin still hits, and look-alikes with a letter-led last label hit', async () => {
    const { scrub } = await scrubMod()
    const pkg = `pk${alpha(5)}`
    const ver = `${1 + (randomBytes(1)[0] % 9)}.${randomBytes(1)[0] % 90}.${randomBytes(1)[0] % 90}`
    assert.deepEqual(scrub(`Run npx ${pkg}${AT}${ver} install chromium.`), [])
    assert.deepEqual(scrub(`Pin ${pkg}-${alpha(3)}${AT}${ver} in the notes.`), [])
    assert.deepEqual(at(scrub(`${pkg}${AT}${ver} and ${email(user(), `corp${alpha(3)}.io`)}`), 1), ['email'])
    assert.deepEqual(at(scrub(`mail ${email(user(), `corp${alpha(3)}.io`)} today`), 1), ['email'])
  })
})

describe('retro/scrub.ts: the encoded project dir and a bare home dir', () => {
  test('-home-<user>-<project> after a space, a slash or a quote hits; a word that merely holds it and a lone flag do not', async () => {
    const { scrub } = await scrubMod()
    const u = user()
    const hit = [`see ~/.claude/projects/${ENC}${u}-Projects-${alpha(3)}/ here`, `dir ${ENC}${u}-x`, `"${ENC}${u}-x"`, `${ENC}${u}-x at the start`]
    for (const h of hit) assert.deepEqual(at(scrub(h), 1), ['home-path'], h)
    const clean = [`a sweet${ENC}page`, `use ${ENC} as a flag`, `the ${alpha(4)}${ENC}${u}-x word`]
    for (const c of clean) assert.deepEqual(scrub(c), [], c)
  })

  test('a bare /home/<user> with no trailing slash hits, at the end of a line or before a space; the placeholder and look-alikes do not', async () => {
    const { scrub } = await scrubMod()
    const u = user()
    for (const h of [`cd ${HOME}${u}`, `${HOME}${u} is the home`, `HOME=${HOME}${u}`]) assert.deepEqual(at(scrub(h), 1), ['home-path'], h)
    for (const c of [`cd ${HOME}<name>`, `${HOME}<name>/x`, `the ${HOME} folder`, `/homework/${u}`]) assert.deepEqual(scrub(c), [], c)
  })
})

describe('retro/scrub.ts: person names, matched on word boundaries without case', () => {
  test('the full name, the first part alone and the last part alone each hit; case does not matter; a clean line does not', async () => {
    const { scrub } = await scrubMod()
    const first = cap(`fn${alpha(5)}`)
    const last = cap(`ln${alpha(6)}`)
    const names = [`${first} ${last}`, first, last]
    const lines = [
      `by ${first} ${last} today`, // 1
      `thanks ${first} for the review`, // 2
      `cc ${last.toUpperCase()}`, // 3
      `(${last.toLowerCase()}), ${first}.`, // 4: punctuation around is a boundary
      `nothing about anyone ${hex(3)}`, // 5
    ]
    const hits = scrub(lines.join('\n'), names)
    for (const l of [1, 2, 3, 4]) assert.deepEqual(at(hits, l), ['name'], `line ${l}`)
    assert.deepEqual(at(hits, 5), [])
    assert.deepEqual(scrub(lines.join('\n')), [], 'with no names configured nothing is a name')
  })

  test('a name inside a longer word is no hit, before, after or both', async () => {
    const { scrub } = await scrubMod()
    const first = cap(`fn${alpha(5)}`)
    const last = cap(`ln${alpha(6)}`)
    const lines = [`pre${first.toLowerCase()}post`, `x${last}`, `${first}${alpha(2)}`, `${first}${last}`]
    assert.deepEqual(scrub(lines.join('\n'), [`${first} ${last}`, first, last]), [])
  })
})

describe('retro/scrub.ts: Windows home paths', () => {
  test('C:\\Users\\<n>\\, any drive letter in either case, forward slashes and the JSON-escaped form all hit', async () => {
    const { scrub } = await scrubMod()
    const n = user()
    const forms = [
      `C:${BS}Users${BS}${n}${BS}work`,
      `d:${BS}Users${BS}${n}${BS}work`,
      `c:/Users/${n}/work`,
      `E:/Users/${n}/work`,
      `C:${BS}${BS}Users${BS}${BS}${n}${BS}${BS}work`,
    ]
    for (const f of forms) {
      assert.deepEqual(at(scrub(`see ${f} here`), 1), ['home-path'], f)
      assert.deepEqual(at(scrub(`{"cwd":"${f}"}`), 1), ['home-path'], `json ${f}`)
    }
  })

  test('the literal <name> placeholder and system directories pass; a real path beside a placeholder still hits', async () => {
    const { scrub } = await scrubMod()
    const n = user()
    const clean = [
      `C:${BS}Users${BS}<name>${BS}x`,
      `c:/Users/<name>/x`,
      `C:${BS}${BS}Users${BS}${BS}<name>${BS}${BS}x`,
      `C:${BS}Windows${BS}System32`,
      `C:${BS}Program Files${BS}${alpha(5)}`,
    ]
    for (const c of clean) assert.deepEqual(scrub(c), [], c)
    assert.deepEqual(at(scrub(`C:${BS}Users${BS}<name>${BS}x then C:${BS}Users${BS}${n}${BS}x`), 1), ['home-path'])
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
