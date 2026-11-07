// Checks for views/transcript/Markdown.tsx: the PM's bubble text as safe markdown (R-45).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { createRenderer, type Renderer } from '../../test/render.ts'

let r: Renderer
let m: Record<string, any>
before(async () => {
  r = await createRenderer()
  m = await r.load('views/transcript/Markdown.tsx')
})
after(async () => { await r?.close() })

const html = (text: string): string => r.render(React.createElement(m.Markdown, { text }))

test('bold, italic and inline code become elements, with no markers left', () => {
  const h = html('**`greet.sh`:** is *ready*')
  assert.match(h, /<strong[^>]*><code[^>]*>greet\.sh<\/code>:<\/strong>/)
  assert.match(h, /<em>ready<\/em>/)
  assert.doesNotMatch(h, /\*\*|`/)
})
test('a fenced block is a pre, and a bullet list is a ul', () => {
  const h = html('Steps:\n\n- one\n- two\n\n```\necho hi\n```')
  assert.match(h, /<ul[^>]*><li[^>]*>one<\/li><li[^>]*>two<\/li><\/ul>/)
  assert.match(h, /<pre[^>]*>echo hi<\/pre>/)
})
test('an https link opens safely; a javascript: link is only its words', () => {
  const ok = html('[docs](https://example.com/a)')
  assert.match(ok, /<a [^>]*href="https:\/\/example\.com\/a"[^>]*rel="noopener noreferrer"/)
  const bad = html('[click](javascript:alert(1)) and [mail](mailto:a@b.c) and [rel](/x)')
  assert.doesNotMatch(bad, /<a /)
  assert.doesNotMatch(bad, /href/)
  assert.match(bad, /click/)
})
test('raw html shows as text, and an image shows as words', () => {
  const h = html('<script>alert(1)</script>\n\nhi <b>x</b> ![logo](http://e.com/a.png)')
  assert.doesNotMatch(h, /<script|<b>|<img/)
  assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(h, /\[image: logo\]/)
})
test('no inline style is ever written', () => {
  assert.doesNotMatch(html('# h\n\n> q\n\n1. a\n2. b\n\n| a | b |\n|---|---|\n| 1 | 2 |'), /style=/)
})
