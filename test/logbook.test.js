import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanFlight, cleanGear, cleanSettings, logStats, gearStatus, profileFromLog, fmtDur } from '../lib/logbook.js';

const NOW = Date.parse('2026-10-30T12:00:00Z');

test('Flugbuch: Flug und Ausrüstung werden geprüft und begrenzt', () => {
  assert.equal(cleanFlight({}), null);
  assert.equal(cleanFlight({ date: '2026-13-40' }), null);
  const f = cleanFlight({ date: '2026-07-01', start: '25:00', durMin: 99999, rating: 9, kind: 'xx', note: 'x'.repeat(900), siteId: '../etc' });
  assert.equal(f.start, '');
  assert.equal(f.durMin, 1440);
  assert.equal(f.rating, 5);
  assert.equal(f.kind, '');
  assert.equal(f.note.length, 500);
  assert.equal(f.siteId, null);
  assert.equal(cleanGear({ type: 'auto' }), null);
  const g = cleanGear({ type: 'glider', brand: 'Advance', model: 'Iota', checkLast: 'gestern', checkMonths: '24' });
  assert.equal(g.checkLast, null);
  assert.equal(g.checkMonths, 24);
  assert.deepEqual(cleanSettings({ flightsBefore: -3, defaults: { glider: 'a1' } }), { flightsBefore: 0, hoursBefore: 0, defaults: { glider: 'a1', harness: null, reserve: null } });
});

test('Flugbuch: Statistik zählt Flüge vor dem Flugbuch mit', () => {
  const flights = [
    { date: '2026-10-01', start: '11:00', durMin: 90, siteName: 'Niesen' },
    { date: '2026-03-01', start: '12:00', durMin: 30, siteName: 'Niesen', km: 12 },
    { date: '2025-06-01', start: '', durMin: 60, siteName: 'Amisbühl' }
  ];
  const s = logStats(flights, { flightsBefore: 10, hoursBefore: 5 }, NOW);
  assert.equal(s.total, 13);
  assert.equal(s.totalMin, 180 + 300);
  assert.equal(s.yearFlights, 2);
  assert.equal(s.last.date, '2026-10-01');
  assert.equal(s.longest.durMin, 90);
  assert.equal(s.farthest.km, 12);
  assert.deepEqual(s.sites[0], ['Niesen', 2]);
  assert.equal(profileFromLog(flights, {}, NOW).hours12, 2);
  assert.equal(profileFromLog([], {}, NOW), null);
  assert.equal(fmtDur(95), '1:35');
});

test('Flugbuch: Schirm-Check nach Zeit und Stunden, Retter packen', () => {
  const glider = { id: 'g1', type: 'glider', hoursBefore: 0, checkLast: '2025-01-01', checkMonths: 24, checkHours: 10 };
  const flights = [{ date: '2025-05-01', durMin: 300, gliderId: 'g1' }, { date: '2026-05-01', durMin: 240, gliderId: 'g1' }, { date: '2024-05-01', durMin: 600, gliderId: 'g1' }];
  const s = gearStatus(glider, flights, NOW);
  assert.equal(s.hours, 19);
  assert.equal(s.flights, 3);
  const byH = s.items.find(x => x.label === 'Check nach Stunden');
  assert.equal(byH.level, 'warn');                       // 9 von 10 h seit Check
  assert.equal(s.items.find(x => x.label === 'Schirm-Check').level, 'ok');
  assert.equal(s.level, 'warn');
  const res = gearStatus({ id: 'r1', type: 'reserve', packedLast: '2026-01-15', packMonths: 6 }, [], NOW);
  assert.equal(res.level, 'due');
  assert.match(res.items[0].text, /Retter packen seit \d+ Tagen fällig/);
  const soon = gearStatus({ id: 'r2', type: 'reserve', packedLast: '2026-05-15', packMonths: 6 }, [], NOW);
  assert.equal(soon.level, 'warn');
});
