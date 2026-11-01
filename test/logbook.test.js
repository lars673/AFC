import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanFlight, cleanGear, cleanSettings, logStats, gearStatus, profileFromLog, fmtDur, cleanBackup, flightsCsv, siteFeedback } from '../lib/logbook.js';

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

test('Sicherung: nur echte Flugbuch-Dateien, Einträge werden geprüft', () => {
  assert.equal(cleanBackup(null), null);
  assert.equal(cleanBackup({ flights: 'x', gear: [] }), null);
  const b = cleanBackup({ flights: [{ id: 'a', date: '2026-07-01', durMin: 99999 }, { id: 'b' }], gear: [{ type: 'glider' }, { type: 'boot' }], settings: { flightsBefore: -5 } });
  assert.equal(b.flights.length, 1);
  assert.equal(b.flights[0].durMin, 1440);
  assert.equal(b.gear.length, 1);
  assert.equal(b.settings.flightsBefore, 0);
});

test('Tabelle: älteste zuerst, Dezimalkomma, Ausrüstung mit Namen', () => {
  const csv = flightsCsv([{ date: '2026-08-02', start: '', durMin: 30, km: 1.5, gliderId: 'g' }, { date: '2026-08-01', start: '10:00', durMin: 61 }], [{ id: 'g', type: 'glider', brand: 'Ozone', model: 'Rush' }]);
  const l = csv.slice(1).trim().split('\r\n');
  assert.match(l[1], /^1;01\.08\.2026;10:00;1:01;61;/);
  assert.match(l[2], /^2;02\.08\.2026;;0:30;30;;;;Ozone Rush;;;1,5;/);
});

test('Rückmeldungen je Startplatz: ab 3, «zu mild» zählt doppelt, begrenzt', () => {
  const f = (siteId, afcVerdict, date = '2026-09-01') => ({ siteId, afcVerdict, date });
  const r = siteFeedback([f('a', 'streng'), f('a', 'streng'), f('a', 'streng'), f('b', 'mild'), f('b', 'richtig'), f('b', 'richtig'), f('c', 'streng'), f('c', 'streng'), f('d', 'streng', '2023-01-01'), f('e', 'mild'), f('e', 'mild'), f('e', 'mild')], NOW);
  assert.equal(r.a.adj, 4);
  assert.equal(r.b.adj, -5);
  assert.equal(r.c.adj, 0);   // erst 2 Rückmeldungen
  assert.equal(r.d, undefined);   // zu alt
  assert.equal(r.e.adj, -8);
  assert.equal(cleanFlight({ date: '2026-09-01', afcVerdict: 'falsch' }).afcVerdict, '');
  assert.equal(cleanFlight({ date: '2026-09-01', afcVerdict: 'mild' }).afcVerdict, 'mild');
});
