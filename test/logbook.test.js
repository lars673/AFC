import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanFlight, cleanGear, cleanSettings, logStats, seasonStats, gearStatus, profileFromLog, fmtDur, cleanBackup, flightsCsv, siteFeedback } from '../lib/logbook.js';

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
  assert.deepEqual(cleanSettings({ flightsBefore: -3, defaults: { glider: 'a1' } }), { flightsBefore: 0, hoursBefore: 0, defaults: { glider: 'a1', harness: null, reserve: null }, cams: {}, lands: {} });
  assert.deepEqual(cleanSettings({ cams: { niesen: 'https://example.org/cam', stockhorn: 'http://x.org', 'bad id': 'https://a.b', amis: 'javascript:alert(1)' } }).cams, { niesen: 'https://example.org/cam' });
  assert.deepEqual(cleanSettings({ lands: { 'niesen-land': { dir: 182.4, side: 'R' }, x: { dir: 'abc' }, 'bad id': { dir: 90 }, y: { dir: 90, side: 'Q' } } }).lands, { 'niesen-land': { dir: 182, side: 'R' }, y: { dir: 90, side: 'L' } });
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

test('Rückmeldungen nach Pilotentyp: «zu streng» gilt für die eigene und erfahrenere Stufen, «zu mild» für alle', async () => {
  const { siteFeedbackByLevel, voterLevel } = await import('../lib/logbook.js');
  const f = (afcVerdict, pilot) => ({ siteId: 'a', afcVerdict, date: '2026-09-01', pilot });
  const xc = { level: 'expert', styles: ['xc'] }, schueler = { level: 'expert', license: 'student' };
  assert.equal(voterLevel(schueler), 'careful'); assert.equal(voterLevel(null), 'normal');
  // drei Streckenpiloten finden AFC zu streng: nur für «Erfahren» lockerer
  let r = siteFeedbackByLevel([f('streng', xc), f('streng', xc), f('streng', xc)], NOW);
  assert.equal(r.expert.a.adj, 4); assert.equal(r.normal.a, undefined); assert.equal(r.careful.a, undefined);
  // drei Schüler finden AFC zu mild: gilt für alle Stufen
  r = siteFeedbackByLevel([f('mild', schueler), f('mild', schueler), f('mild', schueler)], NOW);
  assert.equal(r.careful.a.adj, -8); assert.equal(r.expert.a.adj, -8); assert.equal(r.expert.a.other, 3);
  // vorsichtige Piloten finden AFC zu streng: gilt auch für Erfahrene
  r = siteFeedbackByLevel([f('streng', { level: 'careful' }), f('streng', { level: 'careful' }), f('streng', null)], NOW);
  assert.equal(r.careful.a.n, 2); assert.equal(r.careful.a.adj, 0); assert.equal(r.normal.a.n, 3); assert.equal(r.expert.a.adj, 4);
  assert.equal(cleanFlight({ date: '2026-09-01', pilot: { level: 'x', styles: ['xc', 'bla'], load: 4.2 } }).pilot.styles[0], 'xc');
});

test('Rückblick: Prognose gegen IGC-Flug', async () => {
  const { flightReview, cleanFlight } = await import('../lib/logbook.js');
  const f = cleanFlight({ date: '2026-07-12', start: '11:10', durMin: 95, afcFc: { h: 11, score: 82, top: 2400, base: 2600, wstar: 1.5, from: 10, to: 16 },
    track: { thermals: [{ alt: 2900, rate: 2.4 }, { alt: 2700, rate: 2.0 }] } });
  assert.equal(f.afcFc.top, 2400);
  const r = flightReview(f);
  const by = Object.fromEntries(r.map(x => [x.k, x]));
  assert.equal(by['Thermik-Obergrenze'].lvl, 'more');
  assert.match(by['Thermik-Obergrenze'].note, /500 m höher/);
  assert.equal(by['Steigen im Mittel'].lvl, 'more');
  assert.equal(by['Wolkenbasis'].lvl, 'more');
  assert.equal(by['Zeitfenster'].lvl, 'ok');
  assert.deepEqual(flightReview(cleanFlight({ date: '2026-07-12' })), []);
});

test('Lernen aus Flügen: ohne Urteil halb, «nicht gestartet» als Warnung, jüngere zählen mehr', async () => {
  const { siteFeedback } = await import('../lib/logbook.js');
  const d = '2026-09-01';
  // zweimal «nicht starten» angezeigt, trotzdem super geflogen, plus zwei echte «zu streng»
  let r = siteFeedback([{ siteId: 'a', date: d, afcScore: 40, rating: 5 }, { siteId: 'a', date: d, afcScore: 45, rating: 4 }, { siteId: 'a', date: d, afcVerdict: 'streng' }, { siteId: 'a', date: d, afcVerdict: 'streng' }], NOW);
  assert.equal(r.a.n, 4); assert.equal(r.a.implicit, 2); assert.equal(r.a.adj, 4);
  // drei Piloten nicht gestartet wegen Wind, obwohl AFC 80 zeigte: vorsichtiger
  r = siteFeedback([0, 1, 2].map(() => ({ kind: 'nofly', siteId: 'b', date: d, reason: 'wind', afcScore: 80 })), NOW);
  assert.equal(r.b.adj, -8);
  // «keine Zeit» zählt nicht
  r = siteFeedback([0, 1, 2].map(() => ({ kind: 'nofly', siteId: 'c', date: d, reason: 'time', afcScore: 80 })), NOW);
  assert.equal(r.c, undefined);
  // altes «zu streng», neue «zu mild»: die neuen wiegen schwerer
  r = siteFeedback([{ siteId: 'e', date: '2025-01-10', afcVerdict: 'streng' }, { siteId: 'e', date: '2025-01-11', afcVerdict: 'streng' }, { siteId: 'e', date: d, afcVerdict: 'mild' }], NOW);
  assert.ok(r.e.wm > r.e.ws / 2, 'neue Warnung wiegt mehr als die alten zwei');
});

test('Flugbuch: Höhe Start und Landung, Höhendifferenz', async () => {
  const { altDiff } = await import('../lib/logbook.js');
  const f = cleanFlight({ date: '2026-09-01', startAlt: 1924, landAlt: 1060 });
  assert.equal(f.startAlt, 1924);
  assert.equal(f.landAlt, 1060);
  assert.equal(altDiff(f), 864);
  assert.equal(altDiff(cleanFlight({ date: '2026-09-01', startAlt: 1924 })), null);
  assert.equal(cleanFlight({ date: '2026-09-01', startAlt: 99999 }).startAlt, 9000);
  const csv = flightsCsv([f], []);
  assert.match(csv, /;1924;1060;864;/);
});

test('seasonStats: Zahlen eines Flugjahrs für den Rückblick', () => {
  const fl = [
    { date: '2026-06-06', start: '12:10', durMin: 95, km: 12.4, maxAlt: 2810, siteId: 'amis', siteName: 'Amisbühl', track: { climbMax: 3.1 } },
    { date: '2026-06-06', start: '16:20', durMin: 12, km: 2.1, maxAlt: 1340, siteId: 'amis', siteName: 'Amisbühl' },
    { date: '2026-07-04', start: '11:55', durMin: 130, km: 8, maxAlt: 3120, siteId: 'niesen', siteName: 'Niesen', track: { climbMax: 2.2 } },
    { date: '2026-03-14', start: '13:00', durMin: 0, siteName: 'Wiese' },
    { date: '2025-08-23', start: '13:00', durMin: 300, km: 60, maxAlt: 3900, siteId: 'first', siteName: 'First' }
  ];
  const s = seasonStats(fl, '2026');
  assert.equal(s.n, 4);
  assert.equal(s.min, 237);
  assert.equal(s.km, 23);
  assert.equal(s.days, 3);
  assert.deepEqual(s.per.map(m => m.n), [0, 0, 1, 0, 0, 2, 1, 0, 0, 0, 0, 0]);
  assert.equal(s.per[5].min, 107);
  assert.equal(s.bestDay.date, '2026-07-04');            // meiste Flugzeit an einem Tag
  assert.equal(s.longest.durMin, 130);
  assert.equal(s.highest.maxAlt, 3120);
  assert.equal(s.farthest.km, 12.4);
  assert.equal(s.climb.track.climbMax, 3.1);
  assert.deepEqual(s.sites.map(x => [x.name, x.n]), [['Amisbühl', 2], ['Niesen', 1], ['Wiese', 1]]);
  assert.equal(s.flights[0].date, '2026-03-14');         // nach Datum geordnet
  const e = seasonStats(fl, '2024');
  assert.equal(e.n, 0); assert.equal(e.bestDay, null); assert.equal(e.longest, null); assert.deepEqual(e.sites, []);
  assert.equal(seasonStats([{ date: '2026-05-01' }], 2026).longest, null);   // ohne Dauer kein «längster Flug»
});
