// The text of a repo doc as it reads now: the stitched doc plus any fragment still pending under its fragment dir.
// Fragments are transient (the release's stitch step folds them into the doc and deletes them), so a test that pins
// doc text reads it through this helper and never names a `features.d` or `rules.d` path.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fragmentDirOf, stitchDoc } from '../../bin/fragments.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(here, '..', '..', '..', '..')

// One pending fragment of a doc by file name, or undefined once the stitch has folded it in and deleted it.
export function pendingFragment(doc: string, name: string, root = REPO_ROOT): string | undefined {
  const file = path.join(root, fragmentDirOf(doc), name)
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

// `doc` is repo-relative with forward slashes, e.g. 'docs/features.md'.
export function docText(doc: string, root = REPO_ROOT): string {
  const text = readFileSync(path.join(root, doc), 'utf8')
  const dir = path.join(root, fragmentDirOf(doc))
  if (!existsSync(dir)) return text
  const fragments = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({ name: f, text: readFileSync(path.join(dir, f), 'utf8') }))
  return fragments.length === 0 ? text : stitchDoc(text, fragments).text
}
