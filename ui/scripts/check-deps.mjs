#!/usr/bin/env node
// check-deps [uiDir]: every name in dependencies and devDependencies of uiDir/package.json must have
// uiDir/node_modules/<name>/package.json. uiDir defaults to this script's parent directory. When any is
// missing it prints one stderr line naming each one and `npm --prefix ui ci`, then exits 1; otherwise it is
// silent and exits 0. Node built-ins only, so it runs before any install.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const uiDir = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
const pkg = JSON.parse(readFileSync(join(uiDir, 'package.json'), 'utf8'))
const names = [...new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])]
const missing = names.filter((name) => !existsSync(join(uiDir, 'node_modules', name, 'package.json')))
if (missing.length > 0) {
  process.stderr.write(`check-deps: not installed in node_modules: ${missing.join(', ')}; run npm --prefix ui ci\n`)
  process.exit(1)
}
