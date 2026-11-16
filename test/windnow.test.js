import test from 'node:test';
import assert from 'node:assert/strict';
import { measuredWind, uvOf, dirOf } from '../lib/windnow.js';

const grid = { la0: 46.2, lo0: 7.0, dla: 0.1, dlo: 0.1, nx: 11, ny: 8 }, N = grid.nx * grid.ny;
const field = (speed, dir) => { const [u, v] = uvOf(speed, dir); return { u: Array(N).fill(u), v: Array(N).fill(v) }; };
const at = (f, lat, lon) => { const i = Math.round((lat - grid.la0) / grid.dla) * grid.nx + Math.round((lon - grid.lo0) / grid.dlo); return [Math.hypot(f.u[i], f.v[i]), dirOf(f.u[i], f.v[i])]; };

test('Wind jetzt: an der Station fast der Messwert, weit weg die Prognose, andere Höhe bleibt', () => {
  const levels = { '10m': field(10, 270), 800: field(20, 270), 700: field(30, 270) };
  const elev = Array(N).fill(600);
  // Talstation misst 30 km/h aus Süd, Prognose 10 aus West
  const r = measuredWind(levels, grid, elev, [{ name: 'Tal', lat: 46.6, lon: 7.5, alt: 580, wind: 30, gust: 45, dir: 180, age: 5 }]);
  const [sp, dir] = at(r.levels['10m'], 46.6, 7.5);
  assert.ok(sp > 24 && sp < 31, 'Stärke nahe am Messwert: ' + sp);
  assert.ok(Math.abs(dir - 180) < 15, 'Richtung nahe am Messwert: ' + dir);
  const far = at(r.levels['10m'], 46.2, 8.0);
  assert.ok(Math.abs(far[0] - 10) < 0.5 && Math.abs(far[1] - 270) < 2, 'weit weg bleibt die Prognose');
  const up = at(r.levels[700], 46.6, 7.5);
  assert.ok(Math.abs(up[0] - 30) < 0.5, 'auf 3000 m ändert eine Talstation nichts');
  assert.deepEqual(r.stations.map(s => [s.name, s.wind, s.fcWind, s.fcDir]), [['Tal', 30, 10, 270]]);
  assert.equal(levels['10m'].u[0], uvOf(10, 270)[0], 'die Prognose selbst bleibt unverändert');
});

test('Wind jetzt: alte oder kaputte Messwerte zählen nicht, ohne Stationen bleibt die Prognose', () => {
  const levels = { '10m': field(10, 270), 800: field(20, 270), 700: field(30, 270) };
  const r = measuredWind(levels, grid, null, [{ name: 'alt', lat: 46.6, lon: 7.5, alt: 580, wind: 40, dir: 90, age: 90 }, { name: 'kaputt', lat: 46.6, lon: 7.5, alt: 580, wind: null, dir: 90, age: 2 }]);
  assert.equal(r.stations.length, 0);
  assert.ok(Math.abs(at(r.levels['10m'], 46.6, 7.5)[0] - 10) < 0.01);
  // Bergstation auf 2100 m wirkt auf 2000 m, kaum am Talboden
  const b = measuredWind(levels, grid, Array(N).fill(600), [{ name: 'Berg', lat: 46.6, lon: 7.5, alt: 2100, wind: 50, dir: 270, age: 3 }]);
  assert.ok(at(b.levels[800], 46.6, 7.5)[0] > 40);
  assert.ok(at(b.levels['10m'], 46.6, 7.5)[0] < 11);
});
