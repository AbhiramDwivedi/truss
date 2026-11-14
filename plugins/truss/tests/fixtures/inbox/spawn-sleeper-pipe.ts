// A notify command for tests/inbox.check.ts that never finishes: spawns a detached grandchild node that sleeps 10 minutes, and waits.
// Both processes keep the inherited stderr, which the test holds the read end of (notify-run passes it down when
// TRUSS_TEST_NOTIFY_STDERR=inherit). The grandchild leaves this process's group (detached, as setsid does), so only a walk of the
// descendants reaches it. The pipe closes only when this process and the grandchild are both gone; no pid file, no polling.
import { spawn } from 'node:child_process'

spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { detached: true, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true })
setInterval(() => {}, 1000)
