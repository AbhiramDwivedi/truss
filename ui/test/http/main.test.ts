// ui/server/main.ts flags (ADR-0011 Decision 8). These spawn main.ts with bad input only; each must exit 2
// before main.ts loads ui/server/state or ui/server/session, so they hold on a branch where those are absent.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const main = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'main.ts');
const tmp = mkdtempSync(join(tmpdir(), 'truss-main-test-'));
const emptyPlugin = join(tmp, 'plugin-empty');
const halfPlugin = join(tmp, 'plugin-half');
mkdirSync(emptyPlugin);
mkdirSync(join(halfPlugin, '.claude-plugin'), { recursive: true });
after(() => { rmSync(tmp, { recursive: true, force: true }); });

function run(args: string[]) {
  const r = spawnSync(process.execPath, [main, ...args], { encoding: 'utf8', timeout: 15000, cwd: tmp, env: { ...process.env, INIT_CWD: tmp } });
  return { code: r.status, signal: r.signal, out: r.stdout, err: r.stderr };
}
function oneLine(err: string) {
  const lines = err.split('\n').filter((l) => l.trim() !== '');
  assert.equal(lines.length, 1, `stderr must be one line, got: ${JSON.stringify(err)}`);
  return lines[0]!;
}

describe('main.ts refuses bad input with exit 2 (Decision 8)', () => {
  it('Decision 8: an unknown flag exits 2, one usage line on stderr, nothing on stdout', () => {
    const r = run(['--bogus']);
    assert.equal(r.code, 2, r.err);
    assert.equal(r.out, '');
    assert.match(oneLine(r.err), /usage|--bogus/i);
  });
  it('Decision 8: an unknown flag after good ones still exits 2', () => {
    const r = run(['--repo', tmp, '--port', '0', '--nope', 'x']);
    assert.equal(r.code, 2, r.err);
    assert.equal(r.out, '');
    oneLine(r.err);
  });
  it('Decision 8: --port abc exits 2, one line on stderr, nothing on stdout', () => {
    const r = run(['--port', 'abc']);
    assert.equal(r.code, 2, r.err);
    assert.equal(r.out, '');
    assert.match(oneLine(r.err), /port|usage/i);
  });
  it('Decision 8: a flag missing its value exits 2 (--port, --repo, --plugin, --truss-dir last on the line)', () => {
    for (const flag of ['--port', '--repo', '--plugin', '--truss-dir']) {
      const r = run([flag]);
      assert.equal(r.code, 2, `${flag}: ${r.err}`);
      assert.equal(r.out, '', flag);
      oneLine(r.err);
    }
  });
  it('Decision 8: a flag followed by another flag instead of a value exits 2', () => {
    const r = run(['--port', '--repo', tmp]);
    assert.equal(r.code, 2, r.err);
    assert.equal(r.out, '');
    oneLine(r.err);
  });
  it('Decision 8: --plugin without .claude-plugin/plugin.json exits 2 with an error naming it, nothing on stdout', () => {
    for (const dir of [emptyPlugin, halfPlugin, join(tmp, 'does-not-exist')]) {
      const r = run(['--repo', tmp, '--plugin', dir, '--port', '0']);
      assert.equal(r.code, 2, `${dir}: ${r.err}`);
      assert.equal(r.out, '', dir);
      assert.match(oneLine(r.err), /plugin/i);
    }
  });
  it('Decision 8: the process exits on its own (no server left listening) for each refusal', () => {
    const r = run(['--port', 'abc']);
    assert.equal(r.signal, null, 'not killed by the timeout');
    assert.equal(r.code, 2, r.err);
  });
});
