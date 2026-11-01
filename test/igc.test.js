import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIgc, analyzeIgc, nearestPlace, localCH } from '../lib/igc.js';
import { cleanFlight } from '../lib/logbook.js';
import { makeIgc } from './igc-fixture.js';

test('IGC: Datum, Punkte, Pilot und Schirm werden gelesen', () => {
  const r = parseIgc(makeIgc());
  assert.equal(r.date, '2026-07-12');
  assert.equal(r.fixes.length, 1680);
  assert.equal(r.glider, 'Advance Iota DLS');
  assert.ok(Math.abs(r.fixes[0].lat - 46.6461) < 1e-4);
  assert.equal(r.fixes[0].alt, 2330);
});

test('IGC: Start, Landung, Dauer, Höhe und Thermik werden erkannt', () => {
  const f = analyzeIgc(makeIgc(), 'niesen.igc');
  assert.equal(f.date, '2026-07-12');
  assert.match(f.start, /^11:2[12]$/);          // Abflug 09:22 UTC = 11:22 Sommerzeit
  assert.ok(f.durMin >= 23 && f.durMin <= 25, String(f.durMin));
  assert.ok(f.maxAlt >= 2440 && f.maxAlt <= 2500, String(f.maxAlt));
  assert.equal(f.track.thermals.length, 1);
  const t = f.track.thermals[0];
  assert.ok(t.gain >= 400 && t.rate >= 1.7 && t.rate <= 2.2, JSON.stringify(t));
  assert.ok(f.track.climbMax >= 1.8);
  assert.ok(f.km > 9 && f.km < 13, String(f.km));
  assert.ok(f.track.line.length <= 301);
  const c = cleanFlight({ ...f, id: 'x1' });
  assert.equal(c.track.thermals[0].at, t.at);
  assert.ok(JSON.stringify(c).length < 64 * 1024);
});

test('IGC: Mitternacht, Winterzeit und nächster Startplatz', () => {
  const r = parseIgc(makeIgc({ startUtc: 86400 - 60 }));
  assert.ok(r.fixes.at(-1).t > r.fixes[0].t);
  assert.deepEqual(localCH(Date.parse('2026-01-10T10:05:00Z')), { date: '2026-01-10', time: '11:05' });
  const sites = [{ id: 'a', name: 'Niesen', lat: 46.6460, lon: 7.6520 }, { id: 'b', name: 'Weit weg', lat: 46.7, lon: 7.9 }];
  assert.equal(nearestPlace(sites, { lat: 46.6461, lon: 7.6524 }, 800).id, 'a');
  assert.equal(nearestPlace(sites, { lat: 46.0, lon: 7.0 }, 800), null);
  assert.equal(analyzeIgc('kein igc'), null);
});
