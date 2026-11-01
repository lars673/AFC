import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpdater, githubChecks, githubRepo } from '../lib/updater.js';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
function repos() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afc-upd-'));
  const origin = path.join(dir, 'origin.git'), dev = path.join(dir, 'dev'), mac = path.join(dir, 'mac');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, dev);
  fs.writeFileSync(path.join(dev, 'a.txt'), '1');
  git(dev, 'add', '.'); git(dev, 'commit', '-qm', 'eins'); git(dev, 'push', '-q', 'origin', 'HEAD:main');
  git(dir, 'clone', '-q', origin, mac);
  const commit = (msg) => { fs.writeFileSync(path.join(dev, 'a.txt'), msg); git(dev, 'commit', '-qam', msg); git(dev, 'push', '-q', 'origin', 'HEAD:main'); return git(dev, 'rev-parse', 'HEAD'); };
  return { dir, mac, commit };
}

test('Update nur, wenn die Tests auf GitHub für genau diesen Stand bestanden haben', async () => {
  const r = repos();
  const ci = {};
  const up = createUpdater(r.mac, { checks: async (_repo, sha) => ci[sha] || 'none' });
  try {
    assert.equal((await up.check()).behind, 0);
    const s1 = r.commit('zwei');
    ci[s1] = 'running';
    let st = await up.check();
    assert.equal(st.behind, 1);
    assert.equal(st.available, false);
    assert.match(st.waiting, /laufen noch/);
    assert.equal((await up.apply()).ok, false);
    assert.equal(git(r.mac, 'rev-parse', 'HEAD') === s1, false);
    ci[s1] = 'failed';
    assert.match((await up.check()).waiting, /durchgefallen/);
    ci[s1] = 'passed';
    st = await up.check();
    assert.equal(st.available, true);
    assert.equal(st.waiting, null);
    // inzwischen kommt ein neuer, ungetesteter Stand dazu: eingespielt wird nur der geprüfte
    r.commit('drei');
    assert.equal((await up.apply()).ok, true);
    assert.equal(git(r.mac, 'rev-parse', 'HEAD'), s1);
    st = await up.check();
    assert.equal(st.behind, 1);
    assert.equal(st.available, false);
    assert.match(st.waiting, /keine automatischen Tests/);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

test('GitHub-Abfrage: Ergebnis der Prüfläufe auswerten', async () => {
  assert.equal(githubRepo('https://github.com/lars673/AFC.git'), 'lars673/AFC');
  assert.equal(githubRepo('git@github.com:lars673/afc'), 'lars673/afc');
  assert.equal(githubRepo('/pfad/zum/repo'), null);
  const sha = 'a'.repeat(40);
  const fake = runs => async () => ({ ok: true, json: async () => ({ check_runs: runs }) });
  assert.equal(await githubChecks('x/y', sha, { fetchImpl: fake([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }]) }), 'passed');
  assert.equal(await githubChecks('x/y', sha, { fetchImpl: fake([{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }]) }), 'running');
  assert.equal(await githubChecks('x/y', sha, { fetchImpl: fake([{ status: 'completed', conclusion: 'failure' }, { status: 'in_progress' }]) }), 'failed');
  assert.equal(await githubChecks('x/y', sha, { fetchImpl: fake([]) }), 'none');
  assert.equal(await githubChecks('x/y', sha, { fetchImpl: async () => ({ ok: false }) }), 'unknown');
  assert.equal(await githubChecks('x/y', sha, { fetchImpl: async () => { throw new Error('offline'); } }), 'unknown');
  assert.equal(await githubChecks(null, sha), 'unknown');
});
