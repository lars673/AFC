import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './mock-upstream.js';
import http from 'node:http';
import crypto from 'node:crypto';

async function boot(scenario, port, extraEnv = {}) {
  const mock = await startMock(scenario);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afc-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), AFC_DATA_DIR: dir, AFC_OPENMETEO_URL: mock.url, AFC_SMN_URL: mock.url, AFC_STATION_META_URL: mock.url + '/meta_stations.csv', AFC_FETCH_TIMEOUT_MS: '5000', AFC_TRUSTED_PROXY_HOPS: '1', AFC_UPDATE_CHECK: '0', AFC_AIRSPACE_URL: mock.url, XPC_SERVICE_NAME: '', AFC_AUTOSTART: '', AFC_BACKUP_DIR: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => (log += d)); child.stderr.on('data', d => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/api/plan'); if (r.status === 200) break; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  return { base, mock, log: () => log, stop: async () => { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); await mock.close(); } };
}

test('Server liefert Plan, Detail, Health – guter Tag', async () => {
  const s = await boot('good', 18781);
  try {
    assert.equal((await fetch(s.base + '/healthz')).status, 200);
    const r = await fetch(s.base + '/api/plan?level=normal');
    assert.equal(r.status, 200, s.log());
    const p = await r.json();
    assert.equal(p.ok, true);
    assert.ok(p.sites.length >= 35 && p.landings.length >= 15);
    assert.ok(p.areas.length >= 8);
    assert.ok(p.dates.length >= 4);
    assert.ok(p.headline.text.length > 10);
    const best = p.days[0].top || p.days[1].top;
    assert.ok(best.best.score >= 55, 'bester Score ' + best.best.score);
    assert.ok(r.headers.get('etag'));
    const r2 = await fetch(s.base + '/api/plan?level=normal', { headers: { 'If-None-Match': r.headers.get('etag') } });
    assert.equal(r2.status, 304);
    assert.ok(p.stations.length >= 5);
    assert.ok(p.region.days[0].hours.length > 0);
    // Detail
    const d = await (await fetch(s.base + '/api/site/' + p.sites[0].id)).json();
    assert.equal(d.ok, true);
    assert.ok(d.days[1].hours.length > 8);
    assert.ok(d.days[1].hours[5].prof.length >= 3);
    // Validierung
    assert.equal((await fetch(s.base + '/api/plan?level=hacker')).status, 400);
    assert.equal((await fetch(s.base + '/api/site/..%2Fetc')).status, 404);
    assert.equal((await fetch(s.base + '/api/forecast-snapshot', { method: 'POST' })).status, 404);
    const h = await (await fetch(s.base + '/api/health')).json();
    assert.equal(h.ingest.observations.ok, true);
    assert.equal(h.ingest.forecast.ok, true);
    assert.equal(h.ingest.pressure.ok, true);
    // Windkarte
    let wr;
    for (let i = 0; i < 40; i++) { wr = await fetch(s.base + '/api/wind?level=800'); if (wr.status === 200) break; await new Promise(r => setTimeout(r, 250)); }
    assert.equal(wr.status, 200, s.log());
    const wg = await wr.json();
    assert.equal(wg.u.length, wg.grid.nx * wg.grid.ny);
    assert.ok(wg.u.every(Number.isFinite) && wg.v.every(Number.isFinite));
    // Wind aus Süden (ca. 205°) strömt nach Norden: v > 0
    assert.ok(wg.v[0] > 0, 'v ' + wg.v[0]);
    assert.equal((await fetch(s.base + '/api/wind?level=500')).status, 400);
    // Thermikkarte: Wetterwerte je Rasterpunkt und Geländeraster
    const noon = new Date(); noon.setUTCHours(11, 0, 0, 0);
    const tr = await fetch(s.base + '/api/thermal?t=' + noon.toISOString());
    assert.equal(tr.status, 200);
    const th = await tr.json();
    assert.equal(th.sun.length, th.grid.nx * th.grid.ny);
    assert.ok(th.sunPos.elev > 20, 'Sonnenhöhe ' + th.sunPos.elev);
    assert.ok(th.top.every(x => x === null || x > 1000) && th.top.some(x => x > 1500), 'Thermikhöhe ' + th.top.slice(0, 3));
    assert.equal(th.wind['800'].u.length, th.grid.nx * th.grid.ny);
    assert.equal((await fetch(s.base + '/kk7-grid.bin')).status, 404);   // nur nach lokalem kk7-Abgleich vorhanden
    const gr = await fetch(s.base + '/terrain-grid.bin');
    assert.equal(gr.status, 200);
    const buf = Buffer.from(await gr.arrayBuffer()), hl = buf.readUInt32LE(0), meta = JSON.parse(buf.subarray(4, 4 + hl));
    assert.equal(buf.length, 4 + hl + ((4 + hl) % 2) + meta.nx * meta.ny * 5);
  } finally { await s.stop(); }
});

test('Frontlage: heute K.-o., Vorsicht-Kopfzeile', async () => {
  const s = await boot('front', 18782);
  try {
    const p = await (await fetch(s.base + '/api/plan')).json();
    // Mock-Front gilt für den UTC-Tag: kurz vor Mitternacht ist das in Zürich schon «gestern»
    const today = p.region.days.slice(0, 2).flatMap(d => d.hours);
    assert.ok(today.some(h => h.front === 'danger' || h.front === 'warn'), JSON.stringify(today.map(h => h.front)));
    const t = p.days[0].top;
    if (t) assert.ok(t.best.score < 60, 'Score trotz Front ' + t.best.score);
  } finally { await s.stop(); }
});

test('Föhn aus Messwerten wirkt auf die Lage', async () => {
  const s = await boot('foehn', 18783);
  try {
    const p = await (await fetch(s.base + '/api/plan')).json();
    assert.ok(['warn', 'danger'].includes(p.region.now.foehn), JSON.stringify(p.region.now));
    assert.ok(p.region.days[0].hours.some(h => h.foehn !== 'ok'));
  } finally { await s.stop(); }
});

test('Flugbericht: Validierung, Limit und Datenschutz', async () => {
  const s = await boot('good', 18784);
  try {
    const H = { 'Content-Type': 'application/json', 'X-AFC-Client': 'test-client-0001' };
    const post = (b, h = H) => fetch(s.base + '/api/flight-report', { method: 'POST', headers: h, body: JSON.stringify(b) });
    const t = new Date(Date.now() - 3600000).toISOString();
    assert.equal((await post({ siteId: 'nope', launchTime: t, quality: 3 })).status, 400);
    assert.equal((await post({ siteId: 'x', launchTime: t, quality: 3 }, { 'Content-Type': 'application/json' })).status, 400);
    const plan = await (await fetch(s.base + '/api/plan')).json();
    const id = plan.sites[0].id;
    assert.equal((await post({ siteId: id, launchTime: new Date(Date.now() + 86400000).toISOString(), quality: 3 })).status, 422);
    assert.equal((await post({ siteId: id, launchTime: t, quality: 9 })).status, 422);
    assert.equal((await post({ siteId: id, launchTime: t, quality: 4, launched: true, afcScore: 77, note: 'gut\u0000' })).status, 200);
    assert.equal((await post({ siteId: id, launchTime: t, quality: 4 })).status, 409);
    const ex = await (await fetch(s.base + '/api/privacy/export', { headers: H })).json();
    assert.equal(ex.flightReports.length, 1);
    assert.equal((await fetch(s.base + '/api/privacy/delete', { method: 'DELETE', headers: H })).status, 200);
    const ex2 = await (await fetch(s.base + '/api/privacy/export', { headers: H })).json();
    assert.equal(ex2.flightReports.length, 0);
    const big = await fetch(s.base + '/api/flight-report', { method: 'POST', headers: H, body: 'x'.repeat(40000) });
    assert.equal(big.status, 413);
  } finally { await s.stop(); }
});

test('Rate-Limit nach X-Forwarded-For', async () => {
  const s = await boot('good', 18785);
  try {
    let limited = 0;
    for (let i = 0; i < 200; i++) {
      const r = await fetch(s.base + '/api/meta', { headers: { 'X-Forwarded-For': '203.0.113.7' } });
      if (r.status === 429) limited++;
    }
    assert.ok(limited > 0);
    const other = await fetch(s.base + '/api/meta', { headers: { 'X-Forwarded-For': '203.0.113.99' } });
    assert.equal(other.status, 200);
  } finally { await s.stop(); }
});

test('Rückblick-Test läuft gegen das Archiv und erkennt gefährliche Tage', async () => {
  const mock = await startMock('good');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afc-bt-'));
  try {
    const code = await new Promise(r => spawn(process.execPath, ['tools/backtest.js', '--days', '15', '--auto'], {
      cwd: path.resolve(import.meta.dirname, '..'), stdio: 'ignore',
      env: { ...process.env, AFC_HISTORY_URL: mock.url, AFC_SMN_URL: mock.url, AFC_DATA_DIR: dir }
    }).on('exit', r));
    assert.equal(code, 0);
    const txt = fs.readFileSync(path.join(dir, fs.readdirSync(dir).find(f => f.endsWith('.txt'))), 'utf8');
    assert.match(txt, /Bewertete Gebietstage: \d+/);
    // Im Mock ist die Prognose immer gut, gemessen wird jeden 7. Tag Sturm: die Messung muss als «schlecht» auffallen.
    // Weil der Test wie die App die Morgenmessung mitnimmt, darf AFC diese Tage selbst erkennen (dann kein GEFÄHRLICH).
    assert.match(txt, /schlecht \d+/);
    assert.match(txt, /GEFÄHRLICH: +\d+/);
    // Kurzfassung für die App, Zwischenspeicher nach automatischem Lauf gelöscht
    const hist = JSON.parse(fs.readFileSync(path.join(dir, 'backtest-history.json'), 'utf8'));
    assert.equal(hist.length, 1);
    assert.ok(hist[0].auto && hist[0].n > 0 && hist[0].passt + hist[0].gefaehrlich + hist[0].zuStreng <= hist[0].n);
    assert.ok(!fs.readdirSync(dir).some(f => f.startsWith('backtest-cache-')));
  } finally { await mock.close(); }
});

test('Status zeigt Open-Meteo-Verbrauch, Update nur mit Autostart', async () => {
  const s = await boot('good', 18789);
  try {
    const j = await (await fetch(s.base + '/api/status')).json();
    assert.equal(j.ok, true);
    assert.ok(j.openMeteo.calls > 0 && j.openMeteo.requests > 0, JSON.stringify(j.openMeteo));
    assert.equal(j.openMeteo.limitDay, 10000);
    assert.equal(j.update.enabled, false);
    assert.equal(j.update.canApply, false);
    assert.equal((await fetch(s.base + '/api/update', { method: 'POST', headers: { 'X-AFC-Client': 'x' } })).status, 403);
  } finally { await s.stop(); }
});

test('Open-Meteo-Gewichtung: Orte x angefangene 10 Variablen', async () => {
  const { openMeteoWeight } = await import('../lib/http.js');
  assert.equal(openMeteoWeight('https://api.open-meteo.com/v1/forecast?latitude=1,2,3&longitude=1,2,3&hourly=a,b,c&forecast_days=5'), 3);
  assert.equal(openMeteoWeight('https://api.open-meteo.com/v1/forecast?latitude=1,2&longitude=1,2&hourly=' + 'v,'.repeat(14) + 'v&forecast_days=7'), 4);
  assert.equal(openMeteoWeight('https://data.geo.admin.ch/x.csv'), 0);
});

test('Lufträume: Server liefert SHV-Lufträume und Wildschutz, Klasse E ausserhalb des Gebiets fehlt', async () => {
  const s = await boot('good', 18790);
  try {
    let r;
    for (let i = 0; i < 40; i++) { r = await fetch(s.base + '/api/airspace'); if (r.status === 200) break; await new Promise(res => setTimeout(res, 250)); }
    assert.equal(r.status, 200, s.log());
    const j = await r.json();
    assert.deepEqual(j.items.map(a => a.k).sort(), ['block', 'block', 'warn', 'wild']);
    assert.ok(j.items.every(a => a.p.length >= 3 && a.b.length === 4 && a.lo && a.hi));
    assert.match(s.log(), /Lufträume: 4/);
  } finally { await s.stop(); }
});

test('Flugbuch-API: speichern, lesen, löschen, nur mit Gerätekennung', async () => {
  const s = await boot('good', 18791);
  try {
    const H = { 'Content-Type': 'application/json', 'X-AFC-Client': 'test-client-0001' };
    assert.equal((await fetch(s.base + '/api/logbook')).status, 400);
    const put = (kind, id, b) => fetch(`${s.base}/api/logbook/${kind}/${id}`, { method: 'PUT', headers: H, body: JSON.stringify(b) });
    assert.equal((await put('flight', 'f1', { note: 'ohne Datum' })).status, 400);
    assert.equal((await put('gear', 'g1', { type: 'glider', brand: 'Advance', model: 'Iota' })).status, 200);
    assert.equal((await put('flight', 'f1', { date: '2026-07-01', durMin: 75, gliderId: 'g1', siteName: 'Niesen' })).status, 200);
    assert.equal((await put('flight', 'f2', { date: '2026-08-01', durMin: 20 })).status, 200);
    assert.equal((await put('settings', 'main', { flightsBefore: 40 })).status, 200);
    let j = await (await fetch(s.base + '/api/logbook', { headers: H })).json();
    assert.deepEqual(j.flights.map(f => f.id), ['f2', 'f1']);
    assert.equal((await put('flight', 'f3', { date: '2026-08-02', kind: 'thermik' })).status, 200);
    assert.equal((await (await fetch(s.base + '/api/logbook', { headers: H })).json()).flights[0].kind, 'thermik');
    await fetch(s.base + '/api/logbook/flight/f3', { method: 'DELETE', headers: H });
    assert.equal(j.gear[0].model, 'Iota');
    assert.equal(j.settings.flightsBefore, 40);
    assert.equal((await fetch(s.base + '/api/logbook/flight/f2', { method: 'DELETE', headers: H })).status, 200);
    j = await (await fetch(s.base + '/api/logbook', { headers: H })).json();
    assert.equal(j.flights.length, 1);
  } finally { await s.stop(); }
});

test('Flugbuch: Export als Tabelle und Datei, Sicherung in einen zweiten Ordner, Einspielen', async () => {
  const cloud = fs.mkdtempSync(path.join(os.tmpdir(), 'afc-cloud-'));
  const s = await boot('good', 18793, { AFC_BACKUP_DIR: cloud, AFC_LB_BACKUP_DELAY_MS: '300' });
  try {
    const H = { 'Content-Type': 'application/json', 'X-AFC-Client': 'test-client-0001' };
    const put = (kind, id, b) => fetch(`${s.base}/api/logbook/${kind}/${id}`, { method: 'PUT', headers: H, body: JSON.stringify(b) });
    await put('gear', 'g1', { type: 'glider', brand: 'Advance', model: 'Iota' });
    await put('flight', 'f1', { date: '2026-07-01', start: '11:05', durMin: 75, gliderId: 'g1', siteName: 'Niesen', km: 4.5, note: 'Thermik; gut' });
    await put('flight', 'f2', { date: '2026-08-01', durMin: 20, siteName: '=HYPERLINK("x")' });
    assert.equal((await fetch(s.base + '/api/logbook/export.csv')).status, 400);   // ohne Gerätekennung nicht
    const raw = Buffer.from(await (await fetch(s.base + '/api/logbook/export.csv', { headers: H })).arrayBuffer());
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);   // BOM, damit Excel die Umlaute richtig liest
    const csv = raw.toString('utf8').slice(1);
    const lines = csv.trim().split('\r\n');
    assert.equal(lines.length, 3);
    assert.ok(lines[0].startsWith('Nr.;Datum'));
    assert.match(lines[1], /^1;01\.07\.2026;11:05;1:15;75;Niesen;;;Advance Iota;;;4,5;/);
    assert.match(lines[1], /"Thermik; gut"$/);
    assert.match(lines[2], /;"'=HYPERLINK\(""x""\)";/);   // keine Formel in Excel
    const file = await (await fetch(s.base + '/api/logbook/export.json', { headers: H })).json();
    assert.equal(file.type, 'flugbuch');
    assert.equal(file.flights.length, 2);
    // Sicherung kurz nach der Änderung, lokal und im zweiten Ordner
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) { await new Promise(r => setTimeout(r, 150)); ok = fs.readdirSync(cloud).some(f => /^flugbuch-\d{4}-\d{2}-\d{2}\.json$/.test(f)); }
    assert.ok(ok, 'keine Sicherung im Ordner: ' + s.log());
    assert.ok(fs.existsSync(path.join(cloud, 'flugbuch-tabelle.csv')));
    const st = (await (await fetch(s.base + '/api/logbook', { headers: H })).json()).backup;
    assert.equal(st.flights, 2);
    assert.ok(st.cloud && !st.cloudError);
    // Einspielen: f1 geändert, f9 neu, nichts gelöscht; fremde Dateien abgelehnt
    file.flights[0].note = 'geändert';
    file.flights.push({ id: 'f9', date: '2025-05-05', durMin: 30 });
    const imp = r => fetch(s.base + '/api/logbook/import', { method: 'POST', headers: H, body: JSON.stringify(r) });
    assert.equal((await imp({ hallo: 1 })).status, 400);
    await fetch(s.base + '/api/logbook/flight/f2', { method: 'DELETE', headers: H });
    const n = await (await imp(file)).json();
    assert.deepEqual([n.added, n.updated, n.gear], [2, 1, 1]);
    const j = await (await fetch(s.base + '/api/logbook', { headers: H })).json();
    assert.deepEqual(j.flights.map(f => f.id).sort(), ['f1', 'f2', 'f9']);
    assert.ok(j.flights.some(f => f.note === 'geändert'));
  } finally { await s.stop(); fs.rmSync(cloud, { recursive: true, force: true }); }
});

test('Rückblick-Test: Status zeigt den letzten Lauf aus dem Verlauf', async () => {
  const s = await boot('good', 18792);
  try {
    let j = await (await fetch(s.base + '/api/status')).json();
    assert.equal(j.backtest.auto, false);
    assert.equal(j.backtest.last, null);
    assert.equal((await fetch(s.base + '/api/backtest', { method: 'POST' })).status, 403);
  } finally { await s.stop(); }
});

test('Handy: Karte kommt vom eigenen Server, nichts von cdnjs', async () => {
  const s = await boot('good', 18793);
  try {
    const html = await (await fetch(s.base + '/')).text();
    assert.ok(!/cdnjs/.test(html));
    for (const f of ['/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/vendor/leaflet/images/marker-icon.png', '/igc.js', '/sw.js']) assert.equal((await fetch(s.base + f)).status, 200, f);
  } finally { await s.stop(); }
});

test('Benachrichtigungen: anmelden, Test, Ausrüstung fällig nur einmal, abgelaufenes Abo wird entfernt', async () => {
  const got = [];
  let answer = 201;
  const rx = http.createServer((req, res) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => { got.push({ path: req.url, headers: req.headers, body: Buffer.concat(c) }); res.writeHead(answer); res.end(); }); });
  await new Promise(r => rx.listen(0, '127.0.0.1', r));
  const s = await boot('good', 18794, { AFC_PUSH_TEST_URL: `http://127.0.0.1:${rx.address().port}`, AFC_HEALTH_GRACE_MIN: '0' });
  try {
    const H = { 'Content-Type': 'application/json', 'X-AFC-Client': 'test-client-0001' };
    const post = (u, b) => fetch(s.base + u, { method: 'POST', headers: H, body: JSON.stringify(b) });
    const key = await (await fetch(s.base + '/api/push/key', { headers: H })).json();
    assert.equal(Buffer.from(key.publicKey, 'base64url').length, 65);
    const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
    const auth = crypto.randomBytes(16);
    const endpoint = 'https://web.push.apple.com/QTestGeraet';
    const subscription = { endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
    assert.equal((await post('/api/push/subscribe', { subscription: { ...subscription, endpoint: 'https://evil.example/x' } })).status, 400);
    const sj = await (await post('/api/push/subscribe', { subscription, prefs: { threshold: 80, level: 'careful', favs: ['a', '../x'] } })).json();
    assert.deepEqual([sj.prefs.threshold, sj.prefs.level, sj.prefs.favs], [80, 'careful', ['a']]);
    const decrypt = body => {
      const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
      const ikm = Buffer.from(crypto.hkdfSync('sha256', ua.computeSecret(asPub), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32));
      const d = crypto.createDecipheriv('aes-128-gcm', Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)));
      d.setAuthTag(ct.subarray(-16));
      return JSON.parse(Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]).subarray(0, -1).toString());
    };
    assert.equal((await post('/api/push/test', { endpoint })).status, 200);
    assert.equal(got.length, 1);
    assert.equal(got[0].path, '/QTestGeraet');
    assert.match(got[0].headers.authorization, /^vapid t=.+, k=/);
    assert.equal(decrypt(got[0].body).title, 'AFC-Test');
    // Retter seit 7 Monaten nicht gepackt: morgens eine Meldung, beim zweiten Durchlauf keine mehr
    await fetch(s.base + '/api/logbook/gear/r1', { method: 'PUT', headers: H, body: JSON.stringify({ type: 'reserve', brand: 'Supair', model: 'Light', packedLast: new Date(Date.now() - 210 * 86400000).toISOString().slice(0, 10), packMonths: 6 }) });
    assert.equal((await (await post('/api/push/run', { phase: 'morning' })).json()).sent, 1);
    const m = decrypt(got[1].body);
    assert.equal(m.title, 'Retter packen fällig');
    assert.match(m.body, /Supair Light/);
    assert.equal((await (await post('/api/push/run', { phase: 'morning' })).json()).sent, 0);
    // Flugtag-Wächter
    const wpost = b => fetch(s.base + '/api/watch', { method: 'POST', headers: H, body: JSON.stringify(b) });
    assert.equal((await wpost({ siteId: 'gibtsnicht' })).status, 400);
    let wj = await (await wpost({ siteId: 'niesen', level: 'careful' })).json();
    assert.deepEqual(wj.watches.map(w => [w.siteId, w.level]), [['niesen', 'careful']]);
    assert.equal(wj.devices, 1);
    await wpost({ siteId: 'stockhorn-1' }); await wpost({ siteId: 'first' });
    assert.equal((await wpost({ siteId: 'maennlichen' })).status, 400);   // höchstens 3
    assert.equal(typeof (await (await post('/api/push/run', { phase: 'watch', hour: 12 })).json()).sent, 'number');
    wj = await (await wpost({ siteId: 'niesen', on: false })).json();
    assert.deepEqual(wj.watches.map(w => w.siteId).sort(), ['first', 'stockhorn-1']);
    // Selbstüberwachung: im guten Szenario keine Störung, also keine Meldung
    const stat = await (await fetch(s.base + '/api/status')).json();
    assert.deepEqual(stat.problems, []);
    assert.equal(stat.awake.enabled, false);
    assert.equal((await (await post('/api/push/run', { phase: 'health', hour: 12 })).json()).sent, 0);
    let st = await (await post('/api/push/status', { endpoint })).json();
    assert.ok(st.subscribed && st.lastOk);
    // Gerät hat das Abo gelöscht: der Push-Dienst meldet 410, AFC vergisst das Gerät
    answer = 410;
    assert.equal((await post('/api/push/test', { endpoint })).status, 502);
    st = await (await post('/api/push/status', { endpoint })).json();
    assert.equal(st.subscribed, false);
  } finally { await s.stop(); rx.close(); }
});

test('Selbstüberwachung: fehlende Messwerte melden, einmal pro Tag', async () => {
  const got = [];
  const rx = http.createServer((req, res) => { req.resume(); req.on('end', () => { got.push(req.url); res.writeHead(201); res.end(); }); });
  await new Promise(r => rx.listen(0, '127.0.0.1', r));
  const s = await boot('good', 18795, { AFC_PUSH_TEST_URL: `http://127.0.0.1:${rx.address().port}`, AFC_HEALTH_GRACE_MIN: '0', AFC_SMN_URL: 'http://127.0.0.1:9' });
  try {
    const H = { 'Content-Type': 'application/json', 'X-AFC-Client': 'test-client-0001' };
    const post = (u, b) => fetch(s.base + u, { method: 'POST', headers: H, body: JSON.stringify(b) });
    const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
    const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
    await post('/api/push/subscribe', { subscription: { endpoint: 'https://web.push.apple.com/QHealth', keys }, prefs: {} });
    const stat = await (await fetch(s.base + '/api/status')).json();
    assert.deepEqual(stat.problems.map(p => p.id), ['obs']);
    assert.equal((await (await post('/api/push/run', { phase: 'health', hour: 12 })).json()).sent, 1);
    assert.equal((await (await post('/api/push/run', { phase: 'health', hour: 12 })).json()).sent, 0);
    assert.equal((await (await post('/api/push/run', { phase: 'health', hour: 23 })).json()).sent, 0);   // nachts nie
    await post('/api/push/subscribe', { subscription: { endpoint: 'https://web.push.apple.com/QHealth2', keys }, prefs: { health: false } });
    assert.equal((await (await post('/api/push/run', { phase: 'health', hour: 12 })).json()).sent, 0);
  } finally { await s.stop(); rx.close(); }
});
