import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readGrid, buildPanos, panorama } from '../lib/pano.js';

const read = f => fs.readFileSync(new URL('../' + f, import.meta.url));
const grid = readGrid(read('lib/terrain-grid.bin'));
const { sites } = JSON.parse(read('lib/sites.json'));

test('Bergpanorama: lib/pano.json ist aktuell (sonst: node tools/build-pano.js)', () => {
  assert.deepEqual(JSON.parse(read('lib/pano.json')), buildPanos(grid, sites));
});

test('Bergpanorama: jeder Startplatz im Gelände hat eine Silhouette, nah ≤ mittel ≤ weit', () => {
  const p = JSON.parse(read('lib/pano.json'));
  for (const s of sites.filter(x => x.type === 'start')) {
    const inGrid = s.lat > grid.la0 && s.lon > grid.lo0 && s.lat < grid.la0 + grid.dla * (grid.ny - 1) && s.lon < grid.lo0 + grid.dlo * (grid.nx - 1);
    if (!inGrid) continue;
    const x = p.sites[s.id];
    assert.ok(x, s.id);
    assert.equal(x.f.length, p.fov / p.step + 1);
    x.f.forEach((f, i) => assert.ok(x.n[i] <= x.m[i] && x.m[i] <= f, s.id));
  }
});

test('Bergpanorama: ausserhalb des Rasters keine Silhouette', () => {
  assert.equal(panorama(grid, { lat: 47.5, lon: 8.5, alt: 500, aspects: [180] }), null);
});
