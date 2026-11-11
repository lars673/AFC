import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudField, cloudPoints } from '../lib/clouds.js';

const G = { la0: 46.22, lo0: 6.98, dla: 0.08, dlo: 0.11, ny: 10, nx: 15 };
const pt = (elev, t2, rh, low, lat = 46.6, lon = 7.9) => ({ lat, lon, elev, t2, rh, low });

test('Wolken: Basis aus Temperatur und Feuchte, auf das Raster verteilt', () => {
  const r = cloudField([pt(1300, 12, 60, 40, 46.7, 7.8), pt(2100, 6, 70, 30, 46.6, 8.0)], G);
  assert.equal(r.fog, null);
  assert.equal(r.base.length, 150);
  // 125 m je Grad Taupunktdifferenz: beide Punkte liegen bei rund 2250 bis 2750 m
  assert.ok(Math.min(...r.base) > 2100 && Math.max(...r.base) < 2900, `${Math.min(...r.base)}–${Math.max(...r.base)}`);
});

test('Wolken: Nebelmeer, wenn es unten zu ist und oben frei', () => {
  const r = cloudField([pt(585, 3, 99, 100, null, null), pt(1106, 2, 98, 95), pt(1320, 6, 55, 10), pt(2100, 2, 40, 0)], G);
  assert.ok(r.fog, 'Nebelmeer erkannt');
  assert.ok(r.fog.top > 1106 && r.fog.top < 1320, 'Obergrenze zwischen dem höchsten Nebelpunkt und dem tiefsten freien: ' + r.fog.top);
  assert.equal(r.up, 5);
  // die Basis darüber stammt nur von den freien Punkten
  assert.ok(Math.min(...r.base) > 1500);
});

test('Wolken: kein Nebelmeer bei durchgehend tiefer Bewölkung oder nur feuchter Höhe', () => {
  assert.equal(cloudField([pt(585, 5, 99, 100), pt(1300, 3, 98, 100), pt(2100, 0, 97, 100)], G).fog, null);
  assert.equal(cloudField([pt(585, 8, 70, 20), pt(1800, 2, 99, 100)], G).fog, null);
  // unten zu, einzelne Punkte frei, aber im Mittel bedeckt: Schlechtwetter, kein Nebelmeer
  assert.equal(cloudField([pt(585, 5, 99, 100), pt(1300, 4, 80, 40), pt(1800, 2, 90, 100), pt(2100, 1, 92, 90)], G).fog, null);
  assert.equal(cloudField([], G), null);
  assert.equal(cloudField([{ lat: 46.6, lon: 7.9, elev: 1000, t2: null, rh: 50 }], G), null);
});

test('Wolken: Punkte einer Stunde aus dem Rohstand', () => {
  const t0 = Date.parse('2026-11-12T00:00:00Z'), t = [t0, t0 + 3600000, t0 + 7200000];
  const fc = (elevation, rh) => ({ elevation, t, temperature_2m: [1, 2, 3], relative_humidity_2m: [rh, rh, rh], cloud_cover_low: [0, 50, 100] });
  const raw = { sites: { a: fc(1300, 60) }, areas: { x: { sea: fc(900, 80) } }, ref: { sea: fc(585, 99) }, stations: { INT: fc(577, 97) } };
  const p = cloudPoints(raw, t0 + 3600000, [{ id: 'a', lat: 46.7, lon: 7.8 }, { id: 'fehlt', lat: 1, lon: 1 }], [{ id: 'x', lat: 46.6, lon: 7.9 }], { lat: 46.68, lon: 7.86 });
  assert.deepEqual(p.map(q => [q.elev, q.t2, q.low, q.lat]), [[1300, 2, 50, 46.7], [900, 2, 50, 46.6], [585, 2, 50, 46.68], [577, 2, 50, null]]);
  assert.equal(cloudPoints(raw, t0 + 10 * 3600000, [{ id: 'a', lat: 46.7, lon: 7.8 }], [], null).length, 0);
});
