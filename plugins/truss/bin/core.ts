// truss contract-025 section 2 (ADR-0037), split in 0.32.0: the helpers every bin module shares (CliError, flags, JSON reads, git roots).
// Node built-ins and relative paths only; no module imports factory.ts, which has a top-level await. bin/store.ts re-exports this module.
import { spawnSync } from 'node:child_process'
import * as nodeFs from 'node:fs'
import path from 'node:path'

// ==== core (moved unchanged from factory.ts) ====

export class CliError extends Error {
  code: number
  body: Record<string, unknown>
  constructor(code: number, body: Record<string, unknown>) {
    super(typeof body.error === 'string' ? body.error : JSON.stringify(body))
    this.code = code
    this.body = body
  }
}
export const usage = (message: string): CliError => new CliError(2, { error: message })
export const refuse = (body: Record<string, unknown>): CliError => new CliError(1, body)

export type Flags = Record<string, string | boolean | string[]>
export type Obj = Record<string, any>

export const flat = (p: string): string => String(p).replace(/\\/g, '/')

export const str = (f: Flags, key: string): string | undefined => {
  const v = f[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw usage(`--${key} needs a value`)
  return v
}
export const need = (f: Flags, key: string): string => {
  const v = str(f, key)
  if (v === undefined || v === '') throw usage(`missing --${key}`)
  return v
}
export const listOf = (f: Flags, key: string): string[] => {
  const v = f[key]
  if (v === undefined) return []
  if (v === true) throw usage(`--${key} needs a value`)
  return Array.isArray(v) ? v : [String(v)]
}

export const readText = (p: string): string => {
  try {
    return nodeFs.readFileSync(p, 'utf8')
  } catch (e) {
    throw usage(`cannot read ${flat(p)}: ${(e as Error).message}`)
  }
}
export const readJson = (p: string): any => {
  const text = readText(p)
  try {
    return JSON.parse(text.startsWith('﻿') ? text.slice(1) : text)
  } catch {
    throw usage(`${flat(p)} is not JSON`)
  }
}
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// A Workflow label as {slug, role, n}: strip a trailing -<n> (n >= 2) first, the last segment is the role, the rest the slug. Undefined when it has no role segment.
export function parseLabel(label: string): { slug: string; role: string; n: number } | undefined {
  if (typeof label !== 'string') return undefined
  let rest = label
  let n = 1
  const m = /-(\d+)$/.exec(rest)
  if (m) {
    n = Number(m[1])
    if (n < 2) return undefined
    rest = rest.slice(0, m.index)
  }
  const cut = rest.lastIndexOf('-')
  if (cut <= 0 || cut === rest.length - 1) return undefined
  return { slug: rest.slice(0, cut), role: rest.slice(cut + 1), n }
}

// The repo's .claude/truss.json as an object ({} when absent).
export function configOf(repo: string): Obj {
  const p = `${repo}/.claude/truss.json`
  if (!nodeFs.existsSync(p)) return {}
  const v = readJson(p)
  return isObj(v) ? v : {}
}

// A path key of truss.json (featureMap, adrDir): a non-empty string that is relative and stays inside the repo (no `..` segment, no
// drive letter), as a clean repo-relative path with no leading ./ or trailing /; undefined for anything else. A Windows backslash
// is a separator: it is turned into `/` first, then the path is checked.
export function repoPathOf(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.trim() === '' || /[\r\n]/.test(v)) return undefined
  const p = v.trim().replace(/\\/g, '/')
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some((s) => s === '..')) return undefined
  const clean = p.replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  return clean === '' ? undefined : clean
}

// The package name of a bare import specifier (`@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`).
export const packageName = (spec: string): string => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')
// True when the package.json nearest to `from` (walking up) declares `pkg` in any dependency list.
export function declares(from: string, pkg: string): boolean {
  for (let d = path.dirname(from); ; d = path.dirname(d)) {
    const p = `${d}/package.json`
    if (nodeFs.existsSync(p)) {
      try {
        const j = JSON.parse(nodeFs.readFileSync(p, 'utf8'))
        return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some((k) => isObj(j?.[k]) && Object.hasOwn(j[k], pkg))
      } catch {
        return false
      }
    }
    if (path.dirname(d) === d) return false
  }
}

// ==== git roots ====

// Runs git in `cwd` and returns status, trimmed stdout and stderr. Child process, no shell.
export function git(cwd: string, args: string[]): { status: number; out: string; err: string } {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], { cwd, encoding: 'utf8', windowsHide: true })
  if (r.error) throw usage(`git failed to run: ${r.error.message}`)
  return { status: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}
// <common>: the repo's git common dir as an absolute, forward-slash path. Outside git it is a usage error.
export function commonDir(repo: string): string {
  const r = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (r.status !== 0 || r.out === '') throw usage(`needs a git repo: ${flat(repo)}`)
  return flat(r.out)
}
// S: where state shared by every session of the repo lives.
export const sharedDir = (repo: string): string => `${commonDir(repo)}/truss/shared`
