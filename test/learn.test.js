import test from 'node:test';
import assert from 'node:assert/strict';
import { learnedVerdict, thermalLearn, thermalSamples } from '../lib/learn.js';

test('Selbstprüfung: Lernen pausiert, wenn es den Rückblick-Test gefährlicher macht', () => {
  const s = (g, bg, mild) => ({ gefaehrlich: g, berg: { gefaehrlich: bg, zuMild: mild } });
  assert.equal(learnedVerdict(s(0, 0, 5), s(0, 0, 3)).off, false);
  assert.equal(learnedVerdict(s(0, 0, 5), s(0, 1, 3)).off, true);
  assert.match(learnedVerdict(s(0, 0, 2), s(0, 0, 5)).reason, /5× «zu mild» am Berg, ohne 2/);
  assert.equal(learnedVerdict(s(0, 0, 2), s(0, 0, 3)).off, false);   // eins mehr ist Rauschen
});

const fl = (id, date, start, tops) => ({ id, siteId: 'niesen', date, start, durMin: 90, track: { thermals: tops.map(alt => ({ alt })) } });
const fcMap = (entries) => new Map(entries);

test('Thermik lernen: einheitlich höher geflogen gibt eine Korrektur, gemischt keine', () => {
  const flights = ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22'].map((d, i) => fl('f' + i, d, '12:10', [2600, 2900 + i * 20]));
  const fc = fcMap(flights.flatMap(f => [12, 13].map(h => [`niesen|${f.date}|${h}`, 2500])));
  assert.equal(thermalSamples(flights, fc)[0].diff, 400);
  const r = thermalLearn(flights, fc, { niesen: 'niesen' }, Date.parse('2026-07-01'));
  assert.equal(r.niesen.n, 4);
  assert.ok(r.niesen.add >= 200 && r.niesen.add <= 300, String(r.niesen.add));
  // zu wenige Flüge
  assert.equal(thermalLearn(flights.slice(0, 2), fc, { niesen: 'niesen' }, Date.parse('2026-07-01')).niesen.add, 0);
  // widersprüchlich: einmal viel höher, einmal viel tiefer
  const mixed = [fl('a', '2026-06-01', '12:00', [3300]), fl('b', '2026-06-08', '12:00', [1800]), fl('c', '2026-06-15', '12:00', [3200]), fl('d', '2026-06-22', '12:00', [1900])];
  const fc2 = fcMap(mixed.map(f => [`niesen|${f.date}|12`, 2500]));
  assert.equal(thermalLearn(mixed, fc2, { niesen: 'niesen' }, Date.parse('2026-07-01')).niesen.add, 0);
  // nach unten nur halb so stark und höchstens 300 m
  const low = ['2026-06-01', '2026-06-08', '2026-06-15'].map((d, i) => fl('l' + i, d, '12:00', [1800 + i * 10]));
  const r3 = thermalLearn(low, fcMap(low.map(f => [`niesen|${f.date}|12`, 2600])), { niesen: 'niesen' }, Date.parse('2026-07-01'));
  assert.equal(r3.niesen.add, -250);
  // ohne Prognose zur Flugzeit kein Vergleich
  assert.deepEqual(thermalSamples([fl('x', '2026-06-01', '12:00', [3000])], new Map()), []);
});

test('Lernen aus Messwerten: Nachmittag bei West mehr Böen wird erkannt, Rauschen nicht übernommen', async () => {
  const { stationLearn, stationCorrection, simplifyLearned } = await import('../lib/learn.js');
  const NOW = Date.UTC(2026, 10, 1), rows = [];
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 4;   // ±2 km/h Rauschen
  for (let d = 1; d <= 25; d++) for (let h = 9; h <= 18; h++) {
    const ms = NOW - d * 86400000 + (h - 1) * 3600000, west = d % 2 === 0;
    rows.push({ code: 'NIE', ms, hour: h, pg: 20, pw: 15, pd: west ? 270 : 90, og: 20 + (west && h >= 15 ? 9 : 0) + rnd(), ow: 15 });
    rows.push({ code: 'RND', ms, hour: h, pg: 20, pw: 15, pd: 180, og: 20 + rnd(), ow: 15 });
  }
  const l = stationLearn(rows, NOW);
  assert.equal(l.NIE.mode, 'bucket');
  assert.ok(l.NIE.gain > 1, 'Fehler wird kleiner');
  const pmW = stationCorrection(l.NIE, 16, 270, 15), amO = stationCorrection(l.NIE, 10, 90, 15);
  assert.ok(pmW.gust > 6 && pmW.gust < 10, 'am Nachmittag bei West rund +9: ' + pmW.gust);
  assert.ok(Math.abs(amO.gust) < 1.5, 'am Vormittag bei Ost kaum etwas: ' + amO.gust);
  assert.equal(l.RND.mode, 'none', 'reines Rauschen wird nicht übernommen');
  assert.equal(stationCorrection(l.RND, 16, 180, 15), null);
  const s = simplifyLearned(l);
  assert.equal(s.NIE.mode, 'overall'); assert.equal(s.NIE.raiseOnly, true);
});

test('Selbstprüfung in Stufen: alles, nur das Einfache oder pausiert', async () => {
  const { chooseLearnMode } = await import('../lib/learn.js');
  const s = (g, bg, mild) => ({ gefaehrlich: g, berg: { gefaehrlich: bg, zuMild: mild } });
  assert.equal(chooseLearnMode(s(0, 0, 3), s(0, 0, 3), s(0, 0, 3)).mode, 'full');
  assert.equal(chooseLearnMode(s(0, 0, 3), s(0, 0, 3), s(1, 0, 3)).mode, 'simple');
  assert.equal(chooseLearnMode(s(0, 0, 3), s(1, 0, 3), s(1, 0, 3)).mode, 'off');
  assert.equal(chooseLearnMode(s(0, 0, 3), null, s(0, 0, 6)).mode, 'off');
});

test('Steigen lernen: Flüge stiegen deutlich besser als prognostiziert', async () => {
  const { thermalLearn } = await import('../lib/learn.js');
  const fl = (id, date) => ({ id, siteId: 'niesen', date, start: '12:00', durMin: 60, track: { thermals: [{ alt: 2500, rate: 2.6 }, { alt: 2450, rate: 2.4 }] } });
  const flights = ['2026-06-01', '2026-06-08', '2026-06-15', '2026-06-22'].map((d, i) => fl('c' + i, d));
  const fc = new Map(flights.flatMap(f => [12, 13].map(h => [`niesen|${f.date}|${h}`, { top: 2500, wstar: 1.6 }])));
  const r = thermalLearn(flights, fc, { niesen: 'niesen' }, Date.parse('2026-07-01'));
  assert.ok(r.niesen.climb.factor > 1.1 && r.niesen.climb.factor <= 1.3, 'Faktor ' + r.niesen.climb.factor);
  // nur zwei Flüge: noch nichts
  assert.equal(thermalLearn(flights.slice(0, 2), fc, { niesen: 'niesen' }, Date.parse('2026-07-01')).niesen.climb.factor, 1);
});

test('Gelernte Böen im Modell: anheben bis 10, senken halb und höchstens 4, «nur anheben» senkt nie', async () => {
  const { PlanModel } = await import('../lib/plan.js');
  const la = (l, h = 16, dir = 270) => PlanModel.prototype.learnedAdd.call({}, { l }, h, dir, 15);
  const base = { n: 100, mode: 'bucket', gust: 1, buckets: { 'pm|W': { n: 40, gust: 12 }, 'pm|O': { n: 40, gust: -15 } } };
  assert.equal(la(base).add, 7.2);                       // 12 × 0.6
  assert.equal(la({ ...base, buckets: { 'pm|W': { n: 40, gust: 30 } } }).add, 10);
  assert.equal(la(base, 16, 90).add, -4);                // −15 × 0.6 × 0.5 = −4.5, höchstens −4
  assert.equal(la({ ...base, raiseOnly: true }, 16, 90).add, 0);
  assert.equal(la({ ...base, mode: 'none' }), null);
  assert.equal(la(base, 10, 270).add, 0.6);              // keine Gruppe: Stationsmittel
});
