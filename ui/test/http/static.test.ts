// ui-server static files (ADR-0011 Decisions 6 and 7).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, call, type Booted } from './helpers.ts';

const SECRET = 'TOP-SECRET-OUTSIDE-WEBDIR';
let b: Booted;
before(async () => {
  b = await boot({ files: { 'style.css': 'body{color:red}', 'app.js': 'export const a = 1;', 'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'sub/page.html': '<p>sub</p>' } });
  writeFileSync(join(b.root, 'secret.txt'), SECRET);
  symlinkSync(join(b.root, 'secret.txt'), join(b.webDir, 'link.txt'));
  symlinkSync(b.root, join(b.webDir, 'linkdir'));
});
after(async () => { await b.stop(); });

const get = (path: string, headers: Record<string, string> = {}) => call(b.port, 'GET', path, { headers: { cookie: b.cookie, ...headers } });

describe('files from webDir (Decision 6)', () => {
  it('Decision 6: / is index.html with the page CSP', async () => {
    const r = await get('/');
    assert.equal(r.status, 200);
    assert.match(r.text, /<p>hi<\/p>/);
    assert.equal(r.headers['content-security-policy'], "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    assert.match(String(r.headers['content-type']), /^text\/html/);
  });
  it('Decision 6: a file and a nested file are served byte for byte', async () => {
    assert.equal((await get('/style.css')).text, 'body{color:red}');
    assert.equal((await get('/sub/page.html')).text, '<p>sub</p>');
  });
  it('Decision 6: content types for .html .css .js .svg', async () => {
    assert.match(String((await get('/sub/page.html')).headers['content-type']), /^text\/html/);
    assert.match(String((await get('/style.css')).headers['content-type']), /^text\/css/);
    assert.match(String((await get('/app.js')).headers['content-type']), /^(text|application)\/javascript/);
    assert.match(String((await get('/logo.svg')).headers['content-type']), /^image\/svg\+xml/);
  });
  it('Decision 6: an unknown static path is 404 with the hardening headers', async () => {
    const r = await get('/nope.css');
    assert.equal(r.status, 404);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal((await get('/sub/')).status, 404);
  });
  it('Decision 6: static files carry the hardening headers', async () => {
    const r = await get('/style.css');
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
  });
});

describe('no path outside webDir (Decision 6)', () => {
  const paths = [
    '/../secret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/..%2fsecret.txt', '/%2E%2E%2Fsecret.txt',
    '/sub/../../secret.txt', '/sub/%2e%2e/%2e%2e/secret.txt', '/....//secret.txt',
    '/..%5csecret.txt', '/%2e%2e%5csecret.txt', '/sub/..%5c..%5csecret.txt', '/..\\secret.txt',
    '/etc/passwd', '//etc/passwd', '/%2fetc%2fpasswd', '/%2Fetc/passwd', '/../../../../../../etc/passwd',
    '/link.txt', '/linkdir/secret.txt', '/index.html%00.css', '/%00',
  ];
  it('Decision 6: traversal, encoded, backslash and absolute paths are never 200 and never leak a file', async () => {
    for (const p of paths) {
      const r = await get(p);
      assert.ok(r.status >= 400 && r.status < 500, `${p} -> ${r.status}`);
      assert.ok(!r.text.includes(SECRET), `${p} leaked the secret`);
      assert.ok(!r.text.includes('root:'), `${p} leaked /etc/passwd`);
    }
  });
  it('Decision 6: the absolute path built from this temp dir is refused too', async () => {
    const r = await get('/' + join(b.root, 'secret.txt'));
    assert.ok(r.status >= 400 && r.status < 500, String(r.status));
    assert.ok(!r.text.includes(SECRET));
  });
  it('Decision 6: a symlink in webDir that points outside is not followed', async () => {
    for (const p of ['/link.txt', '/linkdir/secret.txt']) {
      const r = await get(p);
      assert.notEqual(r.status, 200, p);
      assert.ok(!r.text.includes(SECRET), p);
    }
  });
  it('Decision 6: the server keeps serving after the attempts', async () => {
    assert.equal((await get('/')).status, 200);
  });
});

describe('/vendor/marked.js (Decision 7)', () => {
  const marked = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', 'marked', 'lib', 'marked.esm.js');
  it('Decision 7: serves marked.esm.js as JavaScript when installed, else 404 without a crash', async () => {
    const r = await get('/vendor/marked.js');
    if (existsSync(marked)) {
      assert.equal(r.status, 200);
      assert.match(String(r.headers['content-type']), /javascript/);
      assert.ok(r.body.equals(readFileSync(marked)), 'bytes of ui/node_modules/marked/lib/marked.esm.js');
    } else {
      assert.equal(r.status, 404);
    }
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal((await get('/')).status, 200, 'server still up');
  });
  it('Decision 7: it is not read from webDir (a vendor/marked.js there is not served as the vendor file)', async () => {
    const b2 = await boot({ files: { 'vendor/marked.js': 'WEBDIR-COPY' } });
    try {
      const r = await call(b2.port, 'GET', '/vendor/marked.js', { headers: { cookie: b2.cookie } });
      if (existsSync(marked)) assert.ok(r.body.equals(readFileSync(marked)));
      else assert.equal(r.status, 404);
      assert.ok(!r.text.includes('WEBDIR-COPY'), 'fixed path only');
    } finally { await b2.stop(); }
  });
});
