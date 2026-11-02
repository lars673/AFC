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
