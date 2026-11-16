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

test('Wie lange: so lange die Prognose den Nebel hat plus eine Stunde, sonst 1½ Stunden sicher und bis 4 unsicher', () => {
  const f = { at: time, top: 1250 }, H = h => at + h * 3600000;
  const seen = fogTimeline(f, { [H(0)]: 1200, [H(1)]: 1150, [H(2)]: 1100, [H(3)]: null, [H(4)]: null });
  assert.equal(seen.lift, H(4));
  assert.equal(fogStateAt(seen, H(3)), 'measured');
  assert.equal(fogStateAt(seen, H(4)), null);
  const blind = fogTimeline(f, { [H(0)]: null, [H(1)]: null });
  assert.equal(fogStateAt(blind, H(1)), 'measured');
  assert.equal(fogStateAt(blind, H(3)), 'unsure');
  assert.equal(fogStateAt(blind, H(5)), null);
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

test('Nebel ist Sache des Tals: ferne Stationen im Nebel zählen nicht, Sonne nahe am Landeplatz hebt ihn auf (14.11.2026)', () => {
  const t = Date.UTC(2026, 10, 14, 9, 30), tm = new Date(t).toISOString();
  const M = {
    INT: { name: 'Interlaken', lat: 46.6655, lon: 7.8706, alt: 577 }, BOL: { name: 'Boltigen', lat: 46.6243, lon: 7.392, alt: 820 },
    ABO: { name: 'Adelboden', lat: 46.4917, lon: 7.5607, alt: 1321 }, ANT: { name: 'Andermatt', lat: 46.6308, lon: 8.5808, alt: 1438 },
    GRH: { name: 'Grimsel Hospiz', lat: 46.5717, lon: 8.3333, alt: 1980 }, GIH: { name: 'Giswilerstock', lat: 46.8337, lon: 8.0233, alt: 2011 }
  };
  const ob = (rh, sun, temp = 6) => ({ time: tm, rh, sun, temp, dew: temp - (100 - rh) / 5 });
  const amis = { lat: 46.7138, lon: 7.8241 }, hoehe = { lat: 46.6862, lon: 7.8582 };
  // Boltigen (Simmental) noch im Nebel, Interlaken schon in der Sonne
  const f = fogFromObs({ INT: ob(86, 380), BOL: ob(99, 40), ABO: ob(60, 420, 8), ANT: ob(55, 420, 7), GRH: ob(50, 430, 4) }, M, t + 60000);
  assert.ok(f?.top, 'Schicht aus Boltigen erkannt');
  assert.ok(fogConflict(f, 1572, 569), 'ohne Ort: wie bisher');
  assert.equal(fogConflict(f, 1572, 569, { launch: amis, land: hoehe }), null, 'Amisbühl: Boltigen ist 35 km weg');
  // Interlaken selbst im Nebel: K.-o. bleibt, aber Wolken am Grimsel/Giswilerstock heben die Schicht vor Ort nicht über den Start
  const g = fogFromObs({ INT: ob(99, 20), BOL: ob(99, 40), GRH: ob(99, 40, 1), GIH: ob(99, 30, 1), ABO: ob(60, 420, 8), ANT: ob(55, 420, 7) }, M, t + 60000);
  const c = fogConflict(g, 1572, 569, { launch: amis, land: hoehe });
  assert.equal(c.kind, 'land');
  assert.ok(c.top < 1572, String(c.top));
});

test('Föhn nur am Kamm, im Bödeli ruhig: tiefe geschützte Plätze höchstens 69 statt K.-o. (15.11.2026)', async () => {
  const { regionalFromObs } = await import('../lib/regional.js');
  const now = Date.UTC(2026, 10, 15, 11, 0), tm = new Date(now).toISOString();
  const q = dp => ({ LUG: { qff: 1000 + dp, time: tm }, KLO: { qff: 1000, time: tm }, GVE: { qff: 1000, time: tm } });
  const crest = { GUE: { dir: 147, wind: 40, gust: 51 }, GRH: { dir: 154, wind: 36, gust: 47 } };
  const calm = { INT: { dir: 53, wind: 6, gust: 10 }, BRZ: { dir: 110, wind: 4, gust: 8 }, MER: { dir: 248, wind: 4, gust: 7 }, THU: { dir: 20, wind: 2, gust: 4 } };
  const r = regionalFromObs({ ...crest, ...calm }, {}, q(6), now);
  assert.equal(r.foehn, 'danger');
  assert.equal(r.foehnCrestOnly, true);
  // Meiringen mit Südwind, Interlaken böig, starker Druck oder Föhnindex: keine Ausnahme
  assert.equal(regionalFromObs({ ...crest, ...calm, MER: { dir: 170, wind: 16, gust: 28 } }, {}, q(6), now).foehnCrestOnly, false);
  assert.equal(regionalFromObs({ ...crest, ...calm, INT: { dir: 200, wind: 12, gust: 34 } }, {}, q(6), now).foehnCrestOnly, false);
  assert.equal(regionalFromObs({ ...crest, ...calm }, {}, q(8.5), now).foehnCrestOnly, false);
  assert.equal(regionalFromObs({ ...crest, ...calm }, { INT: { value: 1 } }, q(6), now).foehnCrestOnly, false);
  assert.equal(regionalFromObs({ ...crest, BRZ: calm.BRZ }, {}, q(6), now).foehnCrestOnly, false, 'ohne Interlaken keine Ausnahme');

  const site = { id: 't', alt: 1300, lat: 46.71, lon: 7.82, aspects: [180], terrain: {} };
  const w = { ms: now, speed: 8, gust: 12, dir: 180, cloudBase: 3200, cloudCover: 10, cloudCoverLow: 0, pop: 0, precip: 0, cape: 0, sun: 300, valley: { speed: 4, gust: 6 }, foehn: 'danger', foehnDp: 6, local: r };
  const ko = assessHour(site, w);
  assert.ok(ko.hard.some(h => /Föhn/.test(h)) && ko.score <= 45, 'ohne Schutz bleibt K.-o.');
  const sh = assessHour(site, { ...w, foehnShelter: true });
  assert.ok(!sh.hard.length && sh.score <= 69 && sh.score >= 55, String(sh.score));
  assert.ok(sh.reasons.some(x => /nur tief/.test(x)));
  assert.ok(explainHour(sh, { ...w, foehnShelter: true }).some(x => x.k === 'Wetterlage' && x.lvl === 'warn' && /tief/.test(x.t)));
  assert.ok(assessHour(site, { ...w, foehnShelter: true, foehnDp: 8.4 }).hard.length, 'ab 8 hPa K.-o.');
  assert.ok(assessHour(site, { ...w, foehnShelter: true, local: null }).hard.length, 'ohne Messung (morgen) K.-o.');
});
