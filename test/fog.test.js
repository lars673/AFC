import test from 'node:test';
import assert from 'node:assert/strict';
import { fogFromObs, fogTimeline, fogStateAt, fogConflict } from '../lib/fog.js';
import { assessHour, explainHour } from '../lib/scoring.js';

// Novembermorgen, 10 Uhr: unten im Nebel (feucht, kaum Sonne), Adelboden darüber in der Sonne
const at = Date.UTC(2026, 10, 12, 9, 0), time = new Date(at).toISOString();
const meta = {
  THU: { name: 'Thun', lat: 46.75, lon: 7.585, alt: 570 }, INT: { name: 'Interlaken', lat: 46.6655, lon: 7.8706, alt: 577 },
  KAS: { name: 'Kandersteg', lat: 46.5, lon: 7.67, alt: 1176 }, ABO: { name: 'Adelboden', lat: 46.49, lon: 7.56, alt: 1321 },
  GRH: { name: 'Grimsel Hospiz', lat: 46.57, lon: 8.33, alt: 1980 }
};
const o = (rh, sun, temp = 3) => ({ time, rh, sun, temp, dew: temp - (100 - rh) / 5 });

test('Nebelmeer aus den Stationen: Obergrenze zwischen der höchsten im Nebel und der tiefsten in der Sonne', () => {
  const f = fogFromObs({ THU: o(99, 15), INT: o(98, 20), KAS: o(99, 30), ABO: o(62, 260, 8), GRH: o(55, 300, 5) }, meta, at + 5 * 60000);
  assert.equal(f.top, 1250);
  assert.equal(f.ground, true);
  assert.deepEqual(f.above.map(x => x.name), ['Adelboden', 'Grimsel Hospiz']);
  assert.equal(fogConflict(f, 1930, 565).kind, 'land', 'Start in der Sonne, Landeplatz im Nebel');
  assert.equal(fogConflict(f, 1200, 565).kind, 'launch');
  // überall Sonne: kein Nebel
  assert.equal(fogFromObs({ THU: o(70, 250), INT: o(65, 255), KAS: o(60, 260), ABO: o(55, 270) }, meta, at).none, true);
  // überall grau ohne Sonne darüber (bedeckt): kein Nebelmeer
  assert.equal(fogFromObs({ THU: o(90, 20), INT: o(91, 15), KAS: o(88, 25), ABO: o(85, 30) }, meta, at), null);
});

test('Hochnebel mit Decke darüber: Start oben, Landung unten heisst durch den Nebel hinunter', () => {
  const f = fogFromObs({ THU: o(88, 20), INT: o(86, 25), KAS: o(99, 20), ABO: o(60, 260, 8), GRH: o(50, 300) }, meta, at);
  assert.equal(f.ground, false);
  assert.ok(f.base > 577 && f.base < 1176, String(f.base));
  assert.equal(fogConflict(f, 1930, 565).kind, 'through');
  assert.equal(fogConflict(f, 700, 565).kind, 'under');
});

test('Wie lange: so lange die Prognose den Nebel hat plus eine Stunde, sonst 3 Stunden sicher und bis 6 unsicher', () => {
  const f = { at: time, top: 1250 }, H = h => at + h * 3600000;
  const seen = fogTimeline(f, { [H(0)]: 1200, [H(1)]: 1150, [H(2)]: 1100, [H(3)]: null, [H(4)]: null });
  assert.equal(seen.lift, H(4));
  assert.equal(fogStateAt(seen, H(3)), 'measured');
  assert.equal(fogStateAt(seen, H(4)), null);
  const blind = fogTimeline(f, { [H(0)]: null, [H(1)]: null });
  assert.equal(fogStateAt(blind, H(2)), 'measured');
  assert.equal(fogStateAt(blind, H(5)), 'unsure');
  assert.equal(fogStateAt(blind, H(7)), null);
});

test('Landeplatz im Nebel ist K.-o. mit Begründung, unsicherer Nebel nur Vorsicht', () => {
  const site = { id: 't', alt: 1930, lat: 46.71, lon: 7.77, aspects: [180], terrain: {} };
  const w = { ms: at, speed: 8, gust: 12, dir: 180, cloudBase: 3200, cloudCover: 10, cloudCoverLow: 0, pop: 0, precip: 0, cape: 0, sun: 300, valley: { speed: 4, gust: 6 } };
  const ko = assessHour(site, { ...w, fog: { kind: 'land', state: 'measured', top: 1250, base: 500, land: 'Lehn', src: 'Interlaken 577 m im Nebel, Adelboden 1321 m in der Sonne' } });
  assert.ok(ko.score <= 45 && ko.hard.some(h => /Landeplatz im Nebel \(Lehn\)/.test(h)), ko.hard.join(' | '));
  assert.ok(explainHour(ko, { ...w, fog: { kind: 'land', top: 1250 } }).some(x => x.k === 'Wolken' && x.lvl === 'danger'));
  const unsure = assessHour(site, { ...w, fog: { kind: 'land', state: 'unsure', top: 1250, base: 500 } });
  assert.ok(unsure.score <= 70 && !unsure.hard.length);
});
