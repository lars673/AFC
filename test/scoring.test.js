import test from 'node:test';
import assert from 'node:assert/strict';
import { assessHour, LEVELS, pickWindow, frontRiskSeries, foehnFromAloft, windProfile, gustAtLaunch, regionVerdict, decisionFor } from '../lib/scoring.js';
import { regionalFromObs, localForHour } from '../lib/regional.js';
import { dewPoint } from '../lib/plan.js';

const site = { id: 't', name: 'Test', alt: 1500, lat: 46.7, lon: 7.8, aspects: [180], terrain: {} };
const noon = Date.UTC(2026, 5, 21, 10, 0);
const good = (o = {}) => ({ ms: noon, speed: 14, gust: 19, dir: 180, speed10: 14, cloudBase: 3200, cloudCover: 20, cloudCoverLow: 10, pop: 5, precip: 0, cape: 150, sun: 600, valley: { speed: 6, gust: 10 }, up800: 20, up700: 25, ...o });

test('gute Bedingungen ergeben Startsignal', () => {
  const r = assessHour(site, good());
  assert.ok(r.score >= 80, 'Score ' + r.score);
  assert.equal(r.hard.length, 0);
});

test('Kaltfront deckelt den Score auf 30, egal wie gut die Thermik ist', () => {
  const r = assessHour(site, good({ front: { level: 'danger', why: ['Druckfall 4.0 hPa in 6 h'] } }));
  assert.ok(r.score <= 30);
  assert.ok(r.hard.some(h => h.startsWith('K.-o.')));
  assert.equal(r.decision.id, 'nogo');
});

test('Höhenwind ist nur ein leichter Abzug', () => {
  const a = assessHour(site, good());
  const b = assessHour(site, good({ up800: 55, up700: 80 }));
  assert.ok(a.score - b.score <= 16, `Differenz ${a.score - b.score}`);
  assert.ok(b.score >= 60);
});

test('Föhn und Gewitter deckeln auf 35', () => {
  assert.ok(assessHour(site, good({ foehn: 'danger' })).score <= 35);
  assert.ok(assessHour(site, good({ cape: 1500 })).score <= 35);
});

test('Rückenwind ist K.-o.', () => {
  const r = assessHour(site, good({ dir: 0, speed: 14 }));
  assert.ok(r.score <= 45);
  assert.ok(r.hard.length > 0);
});

test('Erfahrungsstufe verschiebt die Windgrenzen', () => {
  const w = good({ speed: 30, gust: 34, speed10: 30 });
  const c = assessHour(site, w, LEVELS.careful).score, e = assessHour(site, w, LEVELS.expert).score;
  assert.ok(e > c, `${e} > ${c}`);
});

test('Scherung senkt den Score, Erfahrung relativiert', () => {
  const base = assessHour(site, good()).score;
  const sh = assessHour(site, good({ shear: { shear500: 35, turn1000: 20 } })).score;
  assert.ok(sh < base);
});

test('Nacht/gesperrter Startplatz', () => {
  assert.equal(assessHour({ ...site, blocked: true }, good()).score, 0);
});

test('Frontserie: nur ein Signal reicht nicht für K.-o., zwei Signale schon', () => {
  const n = 12, P = Array.from({ length: n }, (_, i) => 1015 - i * 0.2);
  const lh = Array.from({ length: n }, (_, i) => 8 + i);
  const one = frontRiskSeries({ P: P.map((p, i) => 1015 - i * 1.0), T: Array(n).fill(15), D800: Array(n).fill(200), S800: Array(n).fill(20), CAPE: Array(n).fill(0), POP: Array(n).fill(0), lh });
  assert.ok(one.every(x => x.level !== 'danger'));
  const two = frontRiskSeries({ P: P.map((p, i) => 1015 - i * 1.0), T: Array(n).fill(15), D800: Array.from({ length: n }, (_, i) => (i < 6 ? 200 : 290)), S800: Array(n).fill(30), CAPE: Array(n).fill(0), POP: Array(n).fill(0), lh });
  assert.ok(two.some(x => x.level === 'danger'));
});

test('Frontrisiko schaut 3 h voraus', () => {
  const n = 14, lh = Array.from({ length: n }, (_, i) => 6 + i);
  const D = Array.from({ length: n }, (_, i) => (i < 8 ? 200 : 290));
  const P = Array.from({ length: n }, (_, i) => (i < 6 ? 1015 : 1015 - (i - 5) * 1.5));
  const s = frontRiskSeries({ P, T: Array(n).fill(15), D800: D, S800: Array(n).fill(30), CAPE: Array(n).fill(0), POP: Array(n).fill(0), lh });
  const first = s.findIndex(x => x.level === 'danger');
  assert.ok(first >= 0);
  const raw = s.map(x => x.level);
  assert.ok(raw[Math.max(0, first - 1)] !== 'ok' || first === 0);
});

test('Föhn aus Höhenwind: 3000 m entscheidet', () => {
  assert.equal(foehnFromAloft({ speed: 20, dir: 200 }, { speed: 50, dir: 190 }), 'danger');
  assert.equal(foehnFromAloft({ speed: 20, dir: 200 }, { speed: 10, dir: 190 }), 'ok');
  assert.equal(foehnFromAloft({ speed: 35, dir: 190 }, { speed: 10, dir: 190 }), 'warn');
});

test('Windprofil und Scherung', () => {
  const lv = [{ z: 1500, speed: 10, dir: 180 }, { z: 2000, speed: 30, dir: 270 }, { z: 3000, speed: 40, dir: 270 }];
  const p = windProfile(lv, 1500);
  assert.ok(p.shear500 > 25);
  assert.ok(p.turn1000 >= 90);
});

test('Böen am Startplatz nicht kleiner als 10-m-Böen', () => {
  assert.ok(gustAtLaunch(30, 12, 20) >= 20);
  assert.ok(gustAtLaunch(30, 12, 20) > 30);
});

test('Regionsurteil: Front ist K.-o., Höhenwind nur Abzug', () => {
  assert.equal(regionVerdict({ front: { level: 'danger' }, cape: 0, pop: 0 }).score, 0);
  assert.ok(regionVerdict({ front: { level: 'ok' }, up800: { speed: 55 }, cape: 0, pop: 0 }).score >= 80);
});

test('Startfenster wählt den besten zusammenhängenden Block', () => {
  const h = [50, 60, 85, 88, 84, 60, 40].map(s => ({ score: s, cap: null }));
  const w = pickWindow(h, 0);
  assert.ok(w.from <= 3 && w.to >= 3 && w.score >= 80);
  assert.equal(pickWindow([null, null], 0), null);
});

test('Regionale Messwerte: Süd-Grimsel + Gütsch ergibt Föhn', () => {
  const r = regionalFromObs({ GRH: { wind: 30, gust: 45, dir: 170 }, GUE: { wind: 40, dir: 190 }, MER: { wind: 20, dir: 180, gust: 32 } }, {});
  assert.equal(r.foehn, 'danger');
});

test('Messwerte verlieren mit der Zeit an Gewicht', () => {
  const st = { foehn: 'danger', biseScore: 50, talwindScore: 0 };
  assert.equal(localForHour(st, 0).foehn, 'danger');
  assert.equal(localForHour(st, 4).foehn, 'warn');
  assert.equal(localForHour(st, 6), null);
});

test('Taupunkt', () => {
  assert.ok(Math.abs(dewPoint(20, 50) - 9.3) < 0.3);
  assert.equal(decisionFor(90).id, 'go');
});
