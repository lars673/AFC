import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './mock-upstream.js';
import { hashPassword, verifyPassword, passwordProblem, cleanProfile, wingLoading, cleanUserPrefs, cleanPhoto, cleanFeedback, cleanEmail } from '../lib/auth.js';

test('Konten: Passwort, Profil und Eingaben werden geprüft', () => {
  const h = hashPassword('Thermik2026!');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(verifyPassword('Thermik2026!', h), true);
  assert.equal(verifyPassword('thermik2026!', h), false);
  assert.equal(verifyPassword('x', 'kaputt'), false);
  assert.ok(passwordProblem('kurz'));
  assert.ok(passwordProblem('12345678'));
  assert.equal(passwordProblem('Niesen-Soaring'), null);
  assert.equal(cleanEmail(' Lars@Example.CH '), 'lars@example.ch');
  assert.equal(cleanEmail('lars@'), null);
  const p = cleanProfile({ license: 'brevet', since: '2015', weight: '95', wingArea: '23.6', wingMin: 100, wingMax: 80, styles: ['thermal', 'hack'], homes: ['niederhorn', '../x'], emergPhone: '079 123 45 67<script>', maxWind: 300 }, new Set(['niederhorn']));
  assert.equal(p.license, 'brevet'); assert.equal(p.since, 2015);
  assert.deepEqual(p.styles, ['thermal']); assert.deepEqual(p.homes, ['niederhorn']);
  assert.equal(p.wingMin, 80); assert.equal(p.wingMax, 100);   // vertauscht korrigiert
  assert.equal(p.emergPhone, '079 123 45 67');
  assert.equal(p.maxWind, 60);
  assert.deepEqual(wingLoading(p), { load: 4.03, pos: 0.75 });
  const pr = cleanUserPrefs({ fav: ['niederhorn-1', 'x y', 'niederhorn-1'], level: 'hacker', pilot: { flights: '150', glider: 'B', student: 'ja' } });
  assert.deepEqual(pr.fav, ['niederhorn-1']); assert.equal(pr.level, null); assert.equal(pr.pilot.flights, 150); assert.equal(pr.pilot.student, false);
  assert.equal(cleanPhoto('data:image/jpeg;base64,' + Buffer.from('nichtjpeg').toString('base64')), null);
  assert.ok(cleanPhoto('data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]).toString('base64')));
  assert.equal(cleanFeedback({ kind: 'idea', text: '  ' }), null);
  assert.equal(cleanFeedback({ kind: 'nofly', reason: 'wind', score: 88 }).reason, 'wind');
});

test('Konten: erstes Konto übernimmt die Daten, Einladung, Anmeldung, getrennte Flugbücher, Admin, Löschen', async () => {
  const mock = await startMock('good');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afc-acc-'));
  const port = 18796, base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PORT: String(port), AFC_DATA_DIR: dir, AFC_OPENMETEO_URL: mock.url, AFC_SMN_URL: mock.url, AFC_STATION_META_URL: mock.url + '/meta_stations.csv', AFC_UPDATE_CHECK: '0', AFC_AIRSPACE_URL: mock.url, AFC_BACKUP_DIR: '', XPC_SERVICE_NAME: '', AFC_AUTOSTART: '' }, stdio: 'ignore' });
  const H = { 'X-AFC-Client': 'testgeraet-12345', 'Content-Type': 'application/json' };
  const call = async (method, p, body, cookie) => {
    const r = await fetch(base + p, { method, headers: { ...H, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    return { status: r.status, json: await r.json().catch(() => null), cookie: set ? set.split(';')[0] : null };
  };
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/plan')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
    // ohne Konten wie bisher: Flugbuch ohne Anmeldung
    assert.equal((await call('PUT', '/api/logbook/flight/f1', { date: '2026-10-01', siteName: 'Niesen', durMin: 40 })).status, 200);
    let st = await call('GET', '/api/auth/state');
    assert.equal(st.json.setup, true);
    // erstes Konto = Admin, übernimmt das Flugbuch
    assert.equal((await call('POST', '/api/auth/setup', { name: 'Lars', email: 'lars@test.ch', password: 'kurz' })).status, 400);
    const ad = await call('POST', '/api/auth/setup', { name: 'Lars', email: 'Lars@Test.ch', password: 'Niesen-Soaring', prefs: { fav: ['niesen-1'], pilot: { flights: 150 } } });
    assert.equal(ad.status, 200); assert.ok(ad.cookie?.startsWith('afc_s='));
    assert.equal(ad.json.user.role, 'admin'); assert.equal(ad.json.prefs.pilot.flights, 150);
    const A = ad.cookie;
    assert.equal((await call('POST', '/api/auth/setup', { name: 'X', email: 'x@test.ch', password: 'Niesen-Soaring' })).status, 409);
    // jetzt braucht alles eine Anmeldung
    assert.equal((await call('GET', '/api/plan')).status, 401);
    assert.equal((await call('GET', '/api/logbook')).status, 401);
    assert.equal((await call('GET', '/api/meta')).status, 200);
    assert.equal((await fetch(base + '/')).status, 200);   // App selbst lädt
    assert.equal((await call('GET', '/api/plan', null, A)).status, 200);
    let lb = await call('GET', '/api/logbook', null, A);
    assert.equal(lb.json.flights.length, 1, 'bisheriger Flug gehört jetzt Lars');
    // Einladung
    const inv = await call('POST', '/api/admin/invite', { note: 'Beat' }, A);
    assert.equal(inv.status, 200); assert.ok(/^[a-z0-9]{10}$/.test(inv.json.code));
    st = await call('GET', '/api/auth/state?invite=' + inv.json.code);
    assert.equal(st.json.invite.ok, true);
    assert.equal((await call('POST', '/api/auth/register', { invite: 'falsch12345', name: 'Beat', email: 'beat@test.ch', password: 'Grindelwald-1' })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { invite: inv.json.code, name: 'Beat', email: 'lars@test.ch', password: 'Grindelwald-1' })).status, 409);
    const be = await call('POST', '/api/auth/register', { invite: inv.json.code, name: 'Beat', email: 'beat@test.ch', password: 'Grindelwald-1' });
    assert.equal(be.status, 200); assert.equal(be.json.user.role, 'pilot');
    const B = be.cookie;
    assert.equal((await call('POST', '/api/auth/register', { invite: inv.json.code, name: 'Eva', email: 'eva@test.ch', password: 'Grindelwald-1' })).status, 400, 'Einladung nur einmal');
    // getrennte Flugbücher
    assert.equal((await call('GET', '/api/logbook', null, B)).json.flights.length, 0);
    assert.equal((await call('PUT', '/api/logbook/flight/f2', { date: '2026-10-02', siteName: 'First', durMin: 30, afcVerdict: 'streng' }, B)).status, 200);
    assert.equal((await call('PUT', '/api/logbook/settings/main', { flightsBefore: 12 }, B)).status, 200);
    assert.equal((await call('GET', '/api/logbook', null, A)).json.flights.length, 1);
    assert.equal((await call('GET', '/api/logbook', null, A)).json.settings.flightsBefore || 0, 0);
    assert.equal((await call('GET', '/api/logbook', null, B)).json.flights[0].id, 'f2');
    assert.equal((await call('GET', '/api/logbook', null, B)).json.backup, null);
    assert.equal((await call('POST', '/api/logbook/backup', null, B)).status, 403);
    // Wächter getrennt
    assert.equal((await call('POST', '/api/watch', { siteId: 'niederhorn-1' }, B)).status, 200);
    assert.equal((await call('GET', '/api/watch', null, A)).json.watches.length, 0);
    assert.equal((await call('GET', '/api/watch', null, B)).json.watches.length, 1);
    // Profil und Einstellungen
    const me = await call('PUT', '/api/me', { name: 'Beat Muster', profile: { license: 'brevet', weight: 90, wingArea: 22, homes: ['niederhorn', 'gibtsnicht'] }, prefs: { fav: ['first-1'] } }, B);
    assert.equal(me.status, 200); assert.equal(me.json.user.name, 'Beat Muster');
    assert.deepEqual(me.json.profile.homes.length <= 1, true);
    assert.deepEqual(me.json.prefs.fav, ['first-1']);
    assert.equal(me.json.stats.flights, 13);
    // Pilotentyp wird mit dem Flug gespeichert (vom Server, nicht von der App) und bleibt beim Ändern
    assert.equal((await call('PUT', '/api/me', { profile: { license: 'brevetXc', styles: ['xc', 'thermal'], weight: 90, wingArea: 22 }, prefs: { level: 'expert' } }, B)).status, 200);
    let fx = await call('PUT', '/api/logbook/flight/f3', { date: '2026-10-03', siteId: 'first-1', afcVerdict: 'streng', pilot: { level: 'careful', license: 'student' } }, B);
    assert.equal(fx.json.item.pilot.level, 'expert'); assert.deepEqual(fx.json.item.pilot.styles, ['xc', 'thermal']); assert.equal(fx.json.item.pilot.load, 4.09);
    assert.equal((await call('PUT', '/api/me', { prefs: { level: 'normal' } }, B)).status, 200);
    fx = await call('PUT', '/api/logbook/flight/f3', { date: '2026-10-03', siteId: 'first-1', afcVerdict: 'streng', note: 'geändert' }, B);
    assert.equal(fx.json.item.pilot.level, 'expert', 'Typ vom ersten Speichern');
    // Profilbild
    const jpg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]).toString('base64');
    const ph = await call('PUT', '/api/me/photo', { photo: jpg }, B);
    assert.equal(ph.status, 200); assert.ok(ph.json.user.photo.startsWith('/api/photo/'));
    const img = await fetch(base + ph.json.user.photo, { headers: { Cookie: A } });
    assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.equal((await fetch(base + ph.json.user.photo)).status, 401);
    // Rückmeldung und Fehlerbericht
    assert.equal((await call('POST', '/api/feedback', { kind: 'nofly', reason: 'wind', site: 'niederhorn-1', score: 82 }, B)).status, 200);
    assert.equal((await call('POST', '/api/feedback', { kind: 'idea', text: 'Bitte Webcam am First' }, B)).status, 200);
    assert.equal((await call('POST', '/api/client-error', { msg: 'TypeError: x is undefined', src: '/app.js', line: 10 }, B)).status, 200);
    assert.equal((await call('POST', '/api/client-error', { msg: 'TypeError: x is undefined', src: '/app.js', line: 10 }, B)).status, 200);
    // Admin-Übersicht nur für Lars
    assert.equal((await call('GET', '/api/admin/overview', null, B)).status, 403);
    const ov = await call('GET', '/api/admin/overview', null, A);
    assert.equal(ov.status, 200);
    assert.equal(ov.json.users.length, 2);
    assert.equal(ov.json.feedback.length, 2);
    assert.equal(ov.json.errors[0].n, 2);
    const xc = ov.json.groups.find(g => g.key === 's:xc');
    assert.equal(xc.pilots, 1); assert.equal(xc.flights, 2, 'älterer Flug ohne Typ bekommt das heutige Profil'); assert.equal(xc.streng, 2); assert.equal(xc.nofly.wind, 1);
    assert.ok(ov.json.groups.find(g => g.key === 'l:expert').flights >= 1);
    assert.equal(ov.json.verdicts.streng, 2);
    assert.equal(ov.json.invites[0].usedBy, 'Beat Muster');
    assert.equal((await call('PUT', '/api/admin/survey', { on: true }, A)).status, 200);
    assert.equal((await call('GET', '/api/me', null, B)).json.survey, true);
    assert.equal((await call('POST', '/api/feedback', { kind: 'survey', answers: { nps: 9, gut: 'Begründungen' } }, B)).status, 200);
    assert.equal((await call('GET', '/api/me', null, B)).json.survey, false);
    // Status: Betriebsdetails nur für den Admin
    assert.equal((await call('GET', '/api/status', null, B)).json.admin, false);
    assert.equal((await call('GET', '/api/status', null, B)).json.openMeteo, undefined);
    // Anmelden, Abmelden, falsches Passwort
    assert.equal((await call('POST', '/api/auth/login', { email: 'beat@test.ch', password: 'falsch-falsch' })).status, 401);
    const li = await call('POST', '/api/auth/login', { email: 'BEAT@test.ch', password: 'Grindelwald-1' });
    assert.equal(li.status, 200); assert.ok(li.cookie);
    assert.equal((await call('POST', '/api/auth/logout', null, li.cookie)).status, 200);
    assert.equal((await call('GET', '/api/me', null, li.cookie)).status, 401);
    // Passwort vergessen: Lars erstellt einen Link
    const rs = await call('POST', '/api/admin/invite', { kind: 'reset', uid: be.json.user.id }, A);
    assert.equal(rs.status, 200);
    st = await call('GET', '/api/auth/state?invite=' + rs.json.code);
    assert.equal(st.json.invite.kind, 'reset'); assert.equal(st.json.invite.name, 'Beat Muster');
    const nr = await call('POST', '/api/auth/reset', { invite: rs.json.code, password: 'Neues-Passwort-9' });
    assert.equal(nr.status, 200);
    assert.equal((await call('GET', '/api/me', null, B)).status, 401, 'alte Sitzungen abgemeldet');
    const B2 = nr.cookie;
    // Export und Konto löschen
    const ex = await fetch(base + '/api/me/export', { headers: { ...H, Cookie: B2 } });
    const exj = await ex.json();
    assert.equal(exj.flugbuch.flights.length, 2); assert.equal(exj.rueckmeldungen.length, 3);
    assert.equal((await call('DELETE', '/api/me', { password: 'falsch-falsch' }, B2)).status, 400);
    assert.equal((await call('DELETE', '/api/me', { password: 'Neues-Passwort-9' }, B2)).status, 200);
    assert.equal((await call('POST', '/api/auth/login', { email: 'beat@test.ch', password: 'Neues-Passwort-9' })).status, 401);
    assert.equal((await call('GET', '/api/admin/overview', null, A)).json.users.length, 1);
    assert.ok(fs.readdirSync(dir).some(f => f.startsWith('afc-vor-konten-')), 'Kopie vor der Umstellung');
  } finally { child.kill(); await mock.close(); }
});

test('Austausch: Beiträge, Antworten, Bin dabei, Tagesbild je Startplatz', async () => {
  const mock = await startMock('good');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afc-grp-'));
  const port = 18798, base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PORT: String(port), AFC_DATA_DIR: dir, AFC_OPENMETEO_URL: mock.url, AFC_SMN_URL: mock.url, AFC_STATION_META_URL: mock.url + '/meta_stations.csv', AFC_UPDATE_CHECK: '0', AFC_AIRSPACE_URL: mock.url, AFC_BACKUP_DIR: '', XPC_SERVICE_NAME: '', AFC_AUTOSTART: '' }, stdio: 'ignore' });
  const H = { 'X-AFC-Client': 'testgeraet-12345', 'Content-Type': 'application/json' };
  const call = async (method, p, body, cookie) => {
    const r = await fetch(base + p, { method, headers: { ...H, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    return { status: r.status, json: await r.json().catch(() => null), cookie: set ? set.split(';')[0] : null };
  };
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/api/plan')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 250)); }
    const A = (await call('POST', '/api/auth/setup', { name: 'Lars', email: 'lars@test.ch', password: 'Niesen-Soaring' })).cookie;
    const inv = await call('POST', '/api/admin/invite', { note: 'Beat' }, A);
    const B = (await call('POST', '/api/auth/register', { invite: inv.json.code, name: 'Beat', email: 'beat@test.ch', password: 'Grindelwald-1' })).cookie;
      // Austausch: Beiträge, Antwort, «Bin dabei», Tagesbild je Startplatz, Namen nur mit Freigabe
        const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' });
        assert.equal((await call('GET', '/api/community')).status, 401);
        assert.equal((await call('PUT', '/api/logbook/flight/cf1', { date: today, siteId: 'niesen-x', siteName: 'Niesen', durMin: 75, rating: 5, km: 12 }, B)).status, 200);
        let c = await call('GET', '/api/community', null, A);
        assert.equal(c.status, 200);
        const ni = c.json.sites.find(x => x.siteId === 'niesen-x');
        assert.equal(ni.flights, 1); assert.equal(ni.rating, 5); assert.deepEqual(ni.names, [], 'ohne Freigabe kein Name');
        assert.equal((await call('PUT', '/api/me', { prefs: { shareName: true } }, B)).status, 200);
        c = await call('GET', '/api/community', null, A);
        assert.deepEqual(c.json.sites.find(x => x.siteId === 'niesen-x').names, ['Beat']);
        assert.equal((await call('POST', '/api/community', { text: '  ' }, B)).status, 400);
        const po = await call('POST', '/api/community', { kind: 'plan', text: 'Morgen 11 Uhr Niesen, wer kommt?', siteId: 'niesen-x', siteName: 'Niesen', date: '2000-01-01' }, B);
        assert.equal(po.status, 200);
        const plan = po.json.posts[0];
        assert.equal(plan.kind, 'plan'); assert.equal(plan.date, today, 'Datum in der Vergangenheit wird heute'); assert.equal(plan.who.name, 'Beat'); assert.equal(plan.mine, true);
        c = await call('POST', `/api/community/${plan.id}/like`, null, A);
        assert.equal(c.json.posts[0].likes, 1); assert.equal(c.json.posts[0].liked, true);
        c = await call('POST', '/api/community', { parent: plan.id, text: 'Bin dabei!' }, A);
        assert.equal(c.json.posts[0].replies[0].who.name, 'Lars');
        assert.equal((await call('DELETE', `/api/community/${plan.id}`, null, A)).status, 200, 'Admin darf löschen');
        const p2 = await call('POST', '/api/community', { kind: 'warn', text: 'Bise am Start' }, A);
        assert.equal((await call('DELETE', `/api/community/${p2.json.posts[0].id}`, null, B)).status, 403, 'fremde Beiträge nicht');
        assert.equal(p2.json.posts.length, 1, 'gelöschter Beitrag samt Antwort weg');
        assert.equal((await call('DELETE', '/api/logbook/flight/cf1', null, B)).status, 200);

  } finally { child.kill(); await mock.close(); }
});
