// A notify command for tests/inbox.check.ts that fails: reads stdin to its end, then exits 1.
process.stdin.resume()
process.stdin.on('end', () => process.exit(1))
