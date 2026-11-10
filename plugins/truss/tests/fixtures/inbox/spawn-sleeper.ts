// A notify command for tests/inbox.check.ts that never finishes: spawns a grandchild node that sleeps 60 s, writes the grandchild's pid to the
// file named by argv[2], and waits. The grandchild stays in this process's group, so a tree kill reaches it.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
writeFileSync(process.argv[2] as string, String(child.pid))
setInterval(() => {}, 1000)
