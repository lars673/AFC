import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LC_FACTOR, lv95ToWgs } from '../lib/landcover.js';
import { rasterCells } from '../lib/iconch.js';

test('Boden: LV95 nach WGS84 (Bern, Zimmerwald)', () => {
  const [la, lo] = lv95ToWgs(2600000, 1200000);
  assert.ok(Math.abs(la - 46.95108) < 0.0005 && Math.abs(lo - 7.43864) < 0.0005, `${la} ${lo}`);
});

test('Boden: Fels heizt mehr als Wiese, Wald weniger, Wasser kaum', () => {
  assert.ok(LC_FACTOR[51] > LC_FACTOR[21] && LC_FACTOR[41] < LC_FACTOR[21] && LC_FACTOR[61] < 0.3 && LC_FACTOR[62] < 0.3);
});

test('Boden: Raster passt zum Geländeraster, Seen und Gletscher erkannt', () => {
  const b = readFileSync(new URL('../lib/landcover-grid.bin', import.meta.url)), l = b.readUInt32LE(0), m = JSON.parse(b.subarray(4, 4 + l)), d = b.subarray(4 + l);
  const t = readFileSync(new URL('../lib/terrain-grid.bin', import.meta.url)), tl = t.readUInt32LE(0), tm = JSON.parse(t.subarray(4, 4 + tl));
  assert.equal(m.nx, tm.nx); assert.equal(m.ny, tm.ny); assert.equal(d.length, m.nx * m.ny);
  const at = (la, lo) => d[Math.round((la - m.la0) / m.dla) * m.nx + Math.round((lo - m.lo0) / m.dlo)];
  assert.ok(at(46.69, 7.73) < 30, 'Thunersee'); assert.ok(at(46.50, 8.03) < 40, 'Aletschgletscher');
});

test('Schneekarte: jede Rasterzelle bekommt die nächste ICON-Zelle', () => {
  const g = { la0: 46.6, lo0: 7.8, dla: 0.005, dlo: 0.005, nx: 3, ny: 2 };
  const lat = Float32Array.from([40, 46.6, 46.605, 46.6]), lon = Float32Array.from([0, 7.8, 7.81, 7.81]);
  const r = rasterCells(lat, lon, g);
  assert.equal(r.lo, 1); assert.equal(r.hi, 3);
  assert.deepEqual([...r.map], [0, 0, 2, 0, 1, 1]);
});
