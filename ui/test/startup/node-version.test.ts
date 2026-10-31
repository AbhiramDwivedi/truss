// Startup Node-version warning: older warns, equal or newer is silent, odd version strings parse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeVersionWarning, readEnginesRange } from '../../server/node-version.ts';

test('an older Node gets one line naming both versions', () => {
  const w = nodeVersionWarning('22.23.0', '>=24');
  assert.equal(w, 'truss-ui: Node 22.23.0 is older than the >=24 this UI is tested on; if something breaks, upgrade Node (https://nodejs.org).');
});

test('equal or newer Node is silent', () => {
  assert.equal(nodeVersionWarning('24.0.0', '>=24'), null);
  assert.equal(nodeVersionWarning('25.1.2', '>=24'), null);
});

test('a prerelease string parses', () => {
  assert.equal(nodeVersionWarning('24.0.0-pre', '>=24'), null);
  assert.notEqual(nodeVersionWarning('23.9.0-nightly2025', '>=24'), null);
});

test('minor and patch count: >=24.1.0', () => {
  assert.notEqual(nodeVersionWarning('24.0.0', '>=24.1.0'), null);
  assert.equal(nodeVersionWarning('24.1.0', '>=24.1.0'), null);
  assert.notEqual(nodeVersionWarning('24.1.0', '>=24.1.1'), null);
});

test('caret: older warns, newer (even a later major) is silent because the line says "older than"', () => {
  assert.notEqual(nodeVersionWarning('23.9.0', '^24'), null);
  assert.equal(nodeVersionWarning('24.5.0', '^24'), null);
  assert.equal(nodeVersionWarning('25.0.0', '^24'), null);
  assert.notEqual(nodeVersionWarning('24.0.9', '^24.1.0'), null);
});

test('readEnginesRange reads engines.node and returns null on a missing or bad file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nodever-'));
  try {
    assert.equal(readEnginesRange(dir), null);
    writeFileSync(join(dir, 'package.json'), '{not json');
    assert.equal(readEnginesRange(dir), null);
    writeFileSync(join(dir, 'package.json'), '{}');
    assert.equal(readEnginesRange(dir), null);
    writeFileSync(join(dir, 'package.json'), '{"engines":{"node":">=24"}}');
    assert.equal(readEnginesRange(dir), '>=24');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable range or version stays silent', () => {
  assert.equal(nodeVersionWarning('24.0.0', 'latest'), null);
  assert.equal(nodeVersionWarning('weird', '>=24'), null);
});
