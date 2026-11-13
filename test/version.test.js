import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

test('Version überall gleich: package.json, App und Service Worker (der Server liest package.json)', () => {
  const v = JSON.parse(read('package.json')).version.replace(/\.0$/, '');
  assert.equal(read('app.js').match(/const APP_VER = '([^']+)'/)[1], v);
  assert.equal(read('sw.js').match(/const CACHE = 'afc-([^']+)'/)[1], v);
  assert.match(read('server.js'), /SERVER_VERSION = \(\(\) =>/);
});
