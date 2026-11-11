import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFrontmatter } from '../bin/knowledge.ts'

test('inline frontmatter list keeps a comma inside glob braces', () => {
  const fm = parseFrontmatter('---\npaths: [src/{a,b}/**, "lib/{x,y}.ts", plain.ts]\n---\n')
  assert.deepEqual(fm?.data.paths, ['src/{a,b}/**', 'lib/{x,y}.ts', 'plain.ts'])
  const multi = parseFrontmatter('---\npaths: [src/{a,b}/**,\n  c.ts]\n---\n')
  assert.deepEqual(multi?.data.paths, ['src/{a,b}/**', 'c.ts'])
})
