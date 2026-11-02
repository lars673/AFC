import test from 'node:test';
import assert from 'node:assert/strict';
import { watchCheck } from '../lib/watch.js';

const T0 = Date.parse('2026-07-01T09:00:00Z');
const det = ({ gust = 20, wind = 12, age = 10, hours } = {}) => ({
  site: { id: 'niesen', name: 'Niesen' },
  nowcast: { name: 'Niesen-Kulm', dist: 0.5, obs: wind, obsGust: gust, ageMin: age },
  days: [{ hours: hours || [{ h: 11, score: 80, status: 'ok', hard: [], reasons: [] }, { h: 12, score: 78, status: 'warn', hard: [], reasons: [] }, { h: 13, score: 75, status: 'warn', hard: [], reasons: [] }] }]
});

test('Wächter: Böen kippen, Meldung einmal, Entwarnung danach', () => {
  let r = watchCheck(det(), 'normal', {}, 11, T0);
  assert.equal(r.alerts.length, 0);
  r = watchCheck(det({ gust: 38 }), 'normal', r.state, 11, T0 + 600000);
  assert.deepEqual(r.alerts.map(a => a.title), ['Niesen: Böen jetzt 38 km/h']);
  assert.match(r.alerts[0].body, /Niesen-Kulm, 0.5 km vom Start/);
  r = watchCheck(det({ gust: 40 }), 'normal', r.state, 11, T0 + 1200000);
  assert.equal(r.alerts.length, 0);   // bleibt schlecht: keine zweite Meldung
  r = watchCheck(det({ gust: 22 }), 'normal', r.state, 11, T0 + 1800000);
  assert.deepEqual(r.alerts.map(a => a.title), ['Niesen: Wind beruhigt sich']);
  // vorsichtige Stufe: tiefere Grenze
  assert.equal(watchCheck(det({ gust: 31 }), 'careful', {}, 11, T0).alerts.length, 1);
  assert.equal(watchCheck(det({ gust: 31 }), 'normal', {}, 11, T0).alerts.length, 0);
  // alte Messung zählt nicht
  assert.equal(watchCheck(det({ gust: 50, age: 90 }), 'normal', {}, 11, T0).alerts.length, 0);
});

test('Wächter: Bewertung kippt in den nächsten 2 Stunden, mit Grund', () => {
  const hours = [{ h: 11, score: 80, status: 'ok', hard: [], reasons: [] }, { h: 12, score: 70, status: 'warn', hard: [], reasons: [] }, { h: 13, score: 40, status: 'danger', hard: ['K.-o.: Gewitterrisiko hoch'], reasons: [] }, { h: 14, score: 20, status: 'danger', hard: [], reasons: [] }];
  const r = watchCheck(det({ hours }), 'normal', {}, 11, T0);
  assert.deepEqual(r.alerts.map(a => a.title), ['Niesen: ab 13 Uhr nur noch 40']);
  assert.match(r.alerts[0].body, /^Gewitterrisiko hoch\./);
  assert.equal(watchCheck(det({ hours }), 'normal', {}, 10, T0).alerts.length, 0);   // 13 Uhr liegt noch zu weit weg
  const ok = watchCheck(det(), 'normal', r.state, 11, T0 + 3700000);
  assert.deepEqual(ok.alerts.map(a => a.title), ['Niesen: wieder 80']);
});
