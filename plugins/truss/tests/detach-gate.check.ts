// truss 0.20.1, ADR-0030 item 7: truss stops no process itself; Claude Code's TaskStop stops a finished agent or background shell
// with everything it left running, but only when the process stayed the session's. So a member's Bash command that backgrounds a
// process itself (a lone `&`, or nohup, setsid or disown as a command word) is refused with the run_in_background way. Quoted text,
// escapes and the redirections &>, >&, 2>&1 and && are not detaching. The main session is not gated.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DETACH_REFUSAL, detachVerdict } from '../hooks/register.ts'

const ALLOWED = Symbol('allowed')

// Registers the hooks against a stub runtime and returns a dispatcher over the Bash tool.call chain.
async function drive(fn: (call: (command: string, extra?: Record<string, unknown>) => Promise<any>) => Promise<void>) {
  const mod = await import('../hooks/register.ts')
  const root = mkdtempSync(join(tmpdir(), 'detach-gate-'))
  try {
    const common = join(root, 'git')
    const sessionId = 's1'
    mkdirSync(mod.trussDir(common, undefined, sessionId), { recursive: true })
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
      if (a[0] === 'tool.call') handlers.push({ filter: a.length >= 3 && a[1] && typeof a[1] === 'object' ? a[1] : undefined, fn: a[a.length - 1] })
      const chain: any = { catch: () => chain }
      return chain
    }
    mod.register(on)
    const matches = (filter: any) => filter === undefined || filter.tool === undefined || (Array.isArray(filter.tool) ? filter.tool.includes('Bash') : filter.tool === 'Bash')
    const call = async (command: string, extra: Record<string, unknown> = {}) => {
      const chain = handlers.filter((h) => matches(h.filter))
      const dispatch = async (i: number, ev: any): Promise<any> => (i >= chain.length ? ALLOWED : chain[i].fn($, ev, (next: any) => dispatch(i + 1, next)))
      return dispatch(0, { tool: 'Bash', args: { command }, ...extra })
    }
    await fn(call)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const DETACHING = [
  'npm run dev &',
  'node server.js & echo started',
  'nohup node server.js',
  'nohup node server.js > out.log 2>&1 &',
  'setsid node server.js',
  'PORT=3000 nohup npm start',
  'npm start; disown',
  'cd /x && python -m http.server 8000 &',
  'sleep 100 &\necho next',
]
const PLAIN = [
  'npm test',
  'npm test 2>&1 | tail -5',
  'npm test &> out.txt',
  'make build >& build.log',
  'git status && git log -1',
  'echo "a & b"',
  "grep -n 'nohup' notes.md",
  'echo nohup is a word here',
  'find . -name x -exec rm {} \\;',
  'echo a \\& b',
  'cat <&3',
]

test('detachVerdict refuses a lone & and nohup, setsid or disown as a command word', () => {
  for (const c of DETACHING) assert.deepEqual(detachVerdict(c), { deny: DETACH_REFUSAL }, c)
})

test('detachVerdict passes &&, redirections with &, quoted and escaped text, and the words as arguments', () => {
  for (const c of PLAIN) assert.equal(detachVerdict(c), undefined, c)
  assert.equal(detachVerdict(undefined), undefined)
})

test('the refusal names run_in_background and TaskStop', () => {
  assert.ok(DETACH_REFUSAL.startsWith('[truss] Refused:'), DETACH_REFUSAL)
  assert.match(DETACH_REFUSAL, /run_in_background/)
  assert.match(DETACH_REFUSAL, /TaskStop/)
})

test('the hook refuses a member call that detaches and lets its plain calls run', async () => {
  await drive(async (call) => {
    for (const c of DETACHING) {
      const v = await call(c, { agentId: 'member-1' })
      assert.ok(v && typeof v === 'object' && typeof v.deny === 'string' && v.deny.includes('run_in_background'), `${c}: ${v === ALLOWED ? 'allowed' : JSON.stringify(v)}`)
    }
    for (const c of PLAIN) assert.equal(await call(c, { agentId: 'member-1' }), ALLOWED, c)
  })
})

test('the main session is not detach-gated', async () => {
  await drive(async (call) => {
    for (const c of DETACHING) assert.equal(await call(c), ALLOWED, c)
  })
})
