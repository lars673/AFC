import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './mock-upstream.js';
import { umzugCodeOk } from '../lib/umzug.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const CODE = 'umzug-test-code-123456';

function run(port, dir, mock, extra = {}) {
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), AFC_DATA_DIR: dir, AFC_OPENMETEO_URL: mock.url, AFC_SMN_URL: mock.url, AFC_STATION_META_URL: mock.url + '/meta_stations.csv', AFC_UPDATE_CHECK: '0', AFC_AIRSPACE_URL: mock.url, AFC_OBSTACLE_URL: mock.url + '/x.kmz', AFC_BACKUP_DIR: '', XPC_SERVICE_NAME: '', AFC_AUTOSTART: '', AFC_BACKFILL: '0', ...extra }, stdio: 'ignore' });
  const exited = new Promise(r => child.on('exit', r));
  return { child, exited };
}
async function up(base) {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/healthz')).ok) return; } catch {} await new Promise(r => setTimeout(r, 250)); }
  throw new Error('Server startet nicht');
}
const H = { 'X-AFC-Client': 'testgeraet-12345', 'Content-Type': 'application/json' };

test('Umzug: Code wird zeitkonstant und nur ab 12 Zeichen geprüft', () => {
  assert.equal(umzugCodeOk(CODE, CODE), true);
  assert.equal(umzugCodeOk(CODE, ' ' + CODE + '\n'), true);
  assert.equal(umzugCodeOk(CODE, CODE + 'x'), false);
  assert.equal(umzugCodeOk('kurz', 'kurz'), false);
  assert.equal(umzugCodeOk('', ''), false);
  assert.equal(umzugCodeOk(CODE, undefined), false);
});

test('Umzug: Mac-Daten (Konto, Flugbuch, Push-Schlüssel) kommen auf den Server, Push-Abos werden zurückgesetzt', async () => {
  const mock = await startMock('good');
  const mac = fs.mkdtempSync(path.join(os.tmpdir(), 'afc-mac-'));
  const srv = fs.mkdtempSync(path.join(os.tmpdir(), 'afc-srv-'));
  const pA = 18811, pB = 18812, A = `http://127.0.0.1:${pA}`, B = `http://127.0.0.1:${pB}`;
  try {
    // 1. «Mac»: Konto und Flug anlegen, sauber beenden
    let m = run(pA, mac, mock); await up(A);
    const ad = await fetch(A + '/api/auth/setup', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Lars', email: 'lars@test.ch', password: 'Niesen-Soaring' }) });
    assert.equal(ad.status, 200);
    const cookie = ad.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(A + '/api/logbook/flight/f1', { method: 'PUT', headers: { ...H, Cookie: cookie }, body: JSON.stringify({ date: '2026-10-01', siteName: 'Niesen', durMin: 40 }) })).status, 200);
    m.child.kill('SIGTERM'); await m.exited;
    if (!fs.existsSync(path.join(mac, 'vapid.json'))) fs.writeFileSync(path.join(mac, 'vapid.json'), JSON.stringify({ test: 'schluessel' }));
    const vapid = fs.readFileSync(path.join(mac, 'vapid.json'), 'utf8');
    const tgz = path.join(os.tmpdir(), `afc-umzug-${pA}.tgz`);
    execFileSync('tar', ['-czf', tgz, '-C', mac, '--exclude', 'backups', '--exclude', 'server.log', '.']);
    const body = fs.readFileSync(tgz);

    // 2. frischer «Server» mit Umzugs-Code
    let s = run(pB, srv, mock, { AFC_HOSTED: '1', AFC_UMZUG_CODE: CODE }); await up(B);
    assert.equal((await fetch(B + '/api/umzug', { method: 'PUT', headers: { 'X-AFC-Umzug': 'falsch-falsch-falsch' }, body })).status, 403);
    assert.equal((await fetch(B + '/api/umzug', { method: 'PUT', headers: { 'X-AFC-Umzug': CODE }, body: Buffer.from('kein archiv') })).status, 400);
    const r = await fetch(B + '/api/umzug', { method: 'PUT', headers: { 'X-AFC-Umzug': CODE }, body });
    assert.equal(r.status, 200);
    await s.exited;   // startet nach dem Empfang neu (die Plattform startet ihn wieder)

    // 3. Neustart: Konto und Flug sind da, Push-Schlüssel gleich
    s = run(pB, srv, mock, { AFC_HOSTED: '1', AFC_UMZUG_CODE: CODE }); await up(B);
    const st = await (await fetch(B + '/api/auth/state', { headers: H })).json();
    assert.equal(st.auth, true);
    const li = await fetch(B + '/api/auth/login', { method: 'POST', headers: H, body: JSON.stringify({ email: 'lars@test.ch', password: 'Niesen-Soaring' }) });
    assert.equal(li.status, 200);
    const c2 = li.headers.get('set-cookie').split(';')[0];
    const lb = await (await fetch(B + '/api/logbook', { headers: { ...H, Cookie: c2 } })).json();
    assert.equal(lb.flights.length, 1);
    assert.equal(fs.readFileSync(path.join(srv, 'vapid.json'), 'utf8'), vapid);
    assert.ok(fs.readdirSync(path.join(srv, 'backups')).some(f => f.startsWith('umzug-')));
    assert.ok(!fs.existsSync(path.join(srv, 'umzug.tgz')));
    // Status sagt: Updates kommen von selbst
    const meta = await (await fetch(B + '/api/status', { headers: { ...H, Cookie: c2 } })).json().catch(() => null);
    if (meta?.update) assert.equal(meta.update.hosted, true);
    // Ein zweiter Umzug braucht «ersetzen»
    assert.equal((await fetch(B + '/api/umzug', { method: 'PUT', headers: { 'X-AFC-Umzug': CODE }, body })).status, 409);
    s.child.kill('SIGTERM'); await s.exited;

    // 4. Ohne gesetzten Code ist der Umzug aus
    s = run(pB, srv, mock, { AFC_HOSTED: '1', AFC_UMZUG_CODE: '' }); await up(B);
    assert.equal((await fetch(B + '/api/umzug', { method: 'PUT', headers: { 'X-AFC-Umzug': CODE, 'X-AFC-Umzug-Ersetzen': 'ja' }, body })).status, 403);
    s.child.kill('SIGTERM'); await s.exited;
  } finally {
    await mock.close?.();
  }
});
