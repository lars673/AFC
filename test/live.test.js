import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLive, makeTracker, LIVE } from '../lib/live.js';

const row = (lat, lon, alt, age, type, id, gs = 30, vario = 0) => `<m a="${lat},${lon},_a3,${id},${alt},09:56:47,${age},151,${gs},${vario},${type},WFJ,0,${id}"/>`;

test('Live-Piloten: nur Gleitschirme und Deltas, kaputte Zeilen fallen weg', () => {
  const xml = `<markers>${row(46.6, 7.9, 2100, 5, 7, 'aa1')}${row(46.6, 7.9, 9000, 5, 9, 'jet')}${row(46.6, 7.9, 2000, 5, 6, 'del')}<m a="x,y"/>${row('abc', 7.9, 2000, 5, 7, 'bad')}</markers>`;
  const r = parseLive(xml);
  assert.deepEqual(r.map(x => x.kind), ['pg', 'hg']);
  assert.equal(r[0].alt, 2100); assert.equal(r[0].age, 5);
  assert.deepEqual(parseLive(null), []);
});

test('Live-Piloten: Steigen aus dem Höhenverlauf, Steigpunkt, Zeile je Startplatz, keine Kennungen', () => {
  const t = makeTracker(() => 1500), sites = [{ id: 'nah', lat: 46.6, lon: 7.9 }, { id: 'fern', lat: 46.3, lon: 7.2 }];
  const t0 = 1_800_000_000_000;
  t.update(parseLive(row(46.6, 7.9, 2000, 2, 7, 'geheim-1') + row(46.601, 7.9, 1505, 2, 7, 'boden', 0)), t0);
  let s = t.snapshot(sites, t0);
  assert.equal(s.pilots.length, 1, 'wer am Boden steht, zählt nicht');
  assert.equal(s.pilots[0].agl, 500);
  t.update(parseLive(row(46.6005, 7.9, 2120, 2, 7, 'geheim-1')), t0 + 60000);
  s = t.snapshot(sites, t0 + 60000);
  assert.equal(s.pilots[0].climb, 2);                       // 120 m in 60 s
  assert.equal(s.spots.length, 1); assert.equal(s.spots[0].climb, 2); assert.equal(s.spots[0].top, 2120);
  assert.deepEqual(Object.keys(s.sites), ['nah']);
  assert.equal(s.sites.nah.n, 1); assert.equal(s.sites.nah.climb, 2); assert.equal(s.sites.nah.top, 2120);
  assert.ok(!JSON.stringify(s).includes('geheim'), 'Gerätekennung bleibt auf dem Server');
  // Pilot weg: nach drei Minuten nicht mehr «jetzt», der Steigpunkt bleibt bis 40 Minuten
  s = t.snapshot(sites, t0 + 60000 + (LIVE.maxAge + 30) * 1000);
  assert.equal(s.pilots.length, 0); assert.equal(s.sites.nah.n, 0); assert.equal(s.sites.nah.climb, 2);
  t.update([], t0 + LIVE.spotMs + 120000);
  assert.equal(t.snapshot(sites, t0 + LIVE.spotMs + 120000).spots.length, 0);
});
