// Test preload (NODE_OPTIONS=--import): the first `git worktree add` of this process stops until the test creates <dir>/go.
// It writes <dir>/held first, so the test waits on a real signal. The hold fails open after 60 s so a broken test cannot hang.
import cp from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

const dir = process.env.TRUSS_TEST_HOLD_DIR
if (dir) {
  const real = cp.spawnSync
  let done = false
  cp.spawnSync = function (cmd, args, ...rest) {
    if (!done && Array.isArray(args) && args.includes('worktree') && args.includes('add')) {
      done = true
      fs.writeFileSync(`${dir}/held`, String(process.pid))
      const end = Date.now() + 60_000
      while (!fs.existsSync(`${dir}/go`) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
    return real.call(this, cmd, args, ...rest)
  }
  syncBuiltinESMExports()
}
