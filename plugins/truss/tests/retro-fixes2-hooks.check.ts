// @ts-nocheck
// truss ADR-0027 F-74 (the push and merge gate), crew push-gate. Written from the spec before any Bash handler existed.
// Runs under plain node, like gate-trussfile.check.ts:
//
//   node --test plugins/truss/tests/retro-fixes2-hooks.check.ts
//
// The harness registers the real hooks through register(), records EVERY tool.call handler with its tool filter, and
// dispatches a Bash call through each handler whose filter matches, in registration order, chaining next. A call that
// reaches the last next is "allowed". So on the base code (no Bash handler) the controls pass and the F74 cases fail
// with "allowed", never with a missing handler.
// Cases titled `F74 n:` fail on the base code; `control N: F74` cases pass on it.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const PLUGIN = '/repo/truss/plugins/truss'
const F = '/sessions/truss/retro/scrub-in-3.jsonl'
const WT = '/repo/truss/.claude/worktrees/truss-push-gate'
const SCRUB = `node ${PLUGIN}/retro/cli.ts scrub ${F}`

const ALLOWED = Symbol('allowed')

async function drive(fn: (call: (command: string, extra?: Record<string, unknown>) => Promise<any>) => Promise<void>) {
  const mod = await import('../hooks/register.ts')
  const root = mkdtempSync(join(tmpdir(), 'push-gate-'))
  try {
    const common = join(root, 'git')
    const sessionId = 's1'
    const truss = mod.trussDir(common, undefined, sessionId)
    mkdirSync(truss, { recursive: true })
    const $: any = {
      process: { run: async () => ({ exitCode: 0, stdout: `${common}\n`, stderr: '' }) },
      session: { cwd: async () => root, id: async () => sessionId },
      env: { get: async () => undefined },
      clock: { after: () => ({ cancel() {} }) },
      ui: { log: () => {} },
      fs: {
        exists: async () => false,
        read: async () => {
          throw new Error('no such file')
        },
        stat: async (p: string) => ({ realPath: p }),
        write: async () => {},
      },
      state: { get: async () => ({ value: undefined, version: 0 }), set: async () => ({ isSet: true, version: 1 }) },
    }
    const handlers: { filter: any; fn: any }[] = []
    const on: any = (...a: any[]) => {
      if (a[0] === 'tool.call') {
        const filter = a.length >= 3 && a[1] && typeof a[1] === 'object' ? a[1] : undefined
        handlers.push({ filter, fn: a[a.length - 1] })
      }
      const chain: any = { catch: () => chain }
      return chain
    }
    mod.register(on)
    assert.ok(handlers.length > 0, 'no tool.call handler was registered')
    const matches = (filter: any, tool: string) => {
      if (filter === undefined || filter.tool === undefined) return true
      return Array.isArray(filter.tool) ? filter.tool.includes(tool) : filter.tool === tool
    }
    const call = async (command: string, extra: Record<string, unknown> = {}) => {
      const chain = handlers.filter((h) => matches(h.filter, 'Bash'))
      const dispatch = async (i: number, ev: any): Promise<any> => {
        if (i >= chain.length) return ALLOWED
        return chain[i].fn($, ev, (next: any) => dispatch(i + 1, next))
      }
      return dispatch(0, { tool: 'Bash', args: { command }, ...extra })
    }
    await fn(call)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const refused = (v: unknown) => {
  assert.ok(v && typeof v === 'object' && typeof (v as any).deny === 'string', `expected a deny, got ${v === ALLOWED ? 'allowed' : JSON.stringify(v)}`)
  const d = (v as { deny: string }).deny
  assert.ok(d.startsWith('[truss] Refused:'), d)
  assert.ok(d.includes('&&'), `the refusal does not name &&: ${d}`)
  assert.match(d, /pipe/i, `the refusal does not say not to pipe scrub: ${d}`)
  return d
}
const allowed = (v: unknown, command: string) => assert.equal(v, ALLOWED, `${command} was not allowed: ${JSON.stringify(v)}`)

test('F74 1: scrub then git push is refused, and so is the git -C <wt> push form', async () => {
  await drive(async (call) => {
    for (const command of [`${SCRUB}; git push`, `${SCRUB}; git -C ${WT} push`, `${SCRUB}; git push origin main`]) {
      refused(await call(command))
    }
  })
})

test('F74 2: the same holds with git merge, git -C <wt> merge, and with || or a newline in place of ;', async () => {
  await drive(async (call) => {
    for (const command of [
      `${SCRUB}; git merge truss-x`,
      `${SCRUB}; git -C ${WT} merge truss-x`,
      `${SCRUB} || git push`,
      `${SCRUB} || git merge truss-x`,
      `${SCRUB}\ngit push`,
      `${SCRUB}\ngit -C ${WT} merge truss-x`,
    ]) {
      refused(await call(command))
    }
  })
})

test('F74 3: scrub f | tail -5 && git push and scrub a && echo x; git push are refused', async () => {
  await drive(async (call) => {
    for (const command of [`${SCRUB} | tail -5 && git push`, `${SCRUB} && echo x; git push`]) {
      refused(await call(command))
    }
  })
})

test('control 1: F74 scrub && git push runs', async () => {
  await drive(async (call) => {
    const c = `${SCRUB} && git push`
    allowed(await call(c), c)
  })
})

test('control 2: F74 scrub && git push 2>&1 | tail (a pipe after the push) runs', async () => {
  await drive(async (call) => {
    const c = `${SCRUB} && git push 2>&1 | tail`
    allowed(await call(c), c)
  })
})

test('control 3: F74 scrub && git -C <wt> merge x runs', async () => {
  await drive(async (call) => {
    const c = `${SCRUB} && git -C ${WT} merge x`
    allowed(await call(c), c)
  })
})

test('control 4: F74 a plain git push runs', async () => {
  await drive(async (call) => {
    const c = 'git push'
    allowed(await call(c), c)
  })
})

test('control 5: F74 scrub; git merge-base main HEAD runs', async () => {
  await drive(async (call) => {
    const c = `${SCRUB}; git merge-base main HEAD`
    allowed(await call(c), c)
  })
})

test('control 6: F74 scrub; git log runs', async () => {
  await drive(async (call) => {
    const c = `${SCRUB}; git log`
    allowed(await call(c), c)
  })
})

test('control 7: F74 a member call (agentId set) with scrub; git push is allowed, the rule is main-session only', async () => {
  await drive(async (call) => {
    const c = `${SCRUB}; git push`
    allowed(await call(c, { agentId: 'member-1' }), c)
  })
})
