// Launcher for queue.check.ts. argv: <factory.ts path> <repo> <session dir>...
// Spawns one `factory.ts queue-next --dir <dir> --repo <repo>` child per session dir, all started at once, and prints
// one JSON line: {"results": [{"dir", "status", "stdout", "stderr"}]} in the order of the dirs.
import { spawn } from 'node:child_process'

const [factory, repo, ...dirs] = process.argv.slice(2)

const run = (dir: string): Promise<{ dir: string; status: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [factory, 'queue-next', '--dir', dir, '--repo', repo], { cwd: repo, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (status) => resolve({ dir, status, stdout, stderr }))
  })

const results = await Promise.all(dirs.map(run))
console.log(JSON.stringify({ results }))
