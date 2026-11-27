import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDefaultTime, lastDaylight, clmFor, mapUrl } from '../lib/sat.js';

const grid = { la0: 46.22, lo0: 6.98, dla: 0.00225, dlo: 0.0033, ny: 321, nx: 468 };

test('Satellit: letzte Zeit aus GetCapabilities', () => {
  assert.equal(parseDefaultTime('<Dimension name="time" default="2026-11-27T21:10:00Z" units="ISO8601">…</Dimension>'), Date.UTC(2026, 10, 27, 21, 10));
  assert.equal(parseDefaultTime('<x/>'), null);
});

test('Satellit: nachts das letzte Bild bei Tag, tagsüber das neuste', () => {
  const night = Date.UTC(2026, 10, 27, 21, 10), noon = Date.UTC(2026, 10, 27, 11, 20);
  const t = lastDaylight(night, grid);
  assert.ok(t < night && t > Date.UTC(2026, 10, 27, 13, 0) && t < Date.UTC(2026, 10, 27, 16, 0), new Date(t).toISOString());
  assert.equal(lastDaylight(noon, grid), noon);
  assert.equal(clmFor(Date.UTC(2026, 10, 27, 14, 50), Date.UTC(2026, 10, 27, 21, 0)), Date.UTC(2026, 10, 27, 14, 45));
  assert.equal(clmFor(Date.UTC(2026, 10, 27, 14, 50), Date.UTC(2026, 10, 27, 14, 30)), Date.UTC(2026, 10, 27, 14, 30));
});

test('Satellit: Ausschnitt deckt das Geländeraster genau ab', () => {
  const u = new URL(mapUrl('vis', Date.UTC(2026, 10, 27, 11, 20), grid));
  const [s, w, n, e] = u.searchParams.get('bbox').split(',').map(Number);
  assert.ok(Math.abs(s - (46.22 - 0.001125)) < 1e-4 && Math.abs(e - (6.98 + 467.5 * 0.0033)) < 1e-4);
  assert.equal(u.searchParams.get('layers'), 'mtg_fd:vis06_hrfi');
  assert.equal(u.searchParams.get('width'), '936');
  assert.equal(u.searchParams.get('time'), '2026-11-27T11:20:00Z');
});
