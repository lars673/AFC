import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './mock-upstream.js';

async function boot(scenario, port) {
  const mock = await startMock(scenario);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afc-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), AFC_DATA_DIR: dir, AFC_OPENMETEO_URL: mock.url, AFC_SMN_URL: mock.url, AFC_STATION_META_URL: mock.url + '/meta_stations.csv', AFC_FETCH_TIMEOUT_MS: '5000', AFC_TRUSTED_PROXY_HOPS: '1' },
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
  } finally { await s.stop(); }
});

test('Frontlage: heute K.-o., Vorsicht-Kopfzeile', async () => {
  const s = await boot('front', 18782);
  try {
    const p = await (await fetch(s.base + '/api/plan')).json();
    const today = p.region.days[0].hours;
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
