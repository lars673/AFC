import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnsemble, pairDiff, ensembleCheck, membersAt, ensIdx } from '../lib/ensemble.js';
import { PlanModel, dayConfidence } from '../lib/plan.js';
import { assessHour, LEVELS } from '../lib/scoring.js';

test('Varianten lesen: Variante 0 ohne Zusatz, weitere mit _memberNN, Modellname dahinter egal', () => {
  const d = { elevation: 600, hourly: { time: ['2026-06-20T00:00', '2026-06-20T01:00'], wind_gusts_10m: [10, 11], wind_gusts_10m_member01: [12, 13], wind_gusts_10m_member02_meteoswiss_icon_ch2_eps: [14, 15], wind_speed_10m_spread: [1, 1], pressure_msl: [1010, 1011] } };
  const e = parseEnsemble(d);
  assert.equal(e.m.wind_gusts_10m.length, 3);
  assert.deepEqual(membersAt(e, 'wind_gusts_10m', 1), [11, 13, 15]);
  assert.equal(e.m.wind_speed_10m, undefined, 'unbekannter Zusatz zählt nicht als Variante');
  assert.equal(ensIdx(e, Date.UTC(2026, 5, 20, 1)), 1);
});

test('Druckunterschied je Variante paarweise, Selbstprüfung schaltet ab, wenn «unter 10 %» oft trotzdem Bise brachte', () => {
  const t = ['2026-06-20T00:00'];
  const a = parseEnsemble({ hourly: { time: t, pressure_msl: [1012], pressure_msl_member01: [1015] } });
  const b = parseEnsemble({ hourly: { time: t, pressure_msl: [1010], pressure_msl_member01: [1010] } });
  assert.deepEqual(pairDiff(a, b, Date.UTC(2026, 5, 20, 0), 0.5), [2.5, 5.5]);
  assert.equal(ensembleCheck(Array.from({ length: 10 }, () => ({ p: 0, hit: true }))).mode, 'lernt');
  assert.equal(ensembleCheck(Array.from({ length: 30 }, (_, i) => ({ p: 0.05, hit: i < 2 }))).ok, true);
  assert.equal(ensembleCheck(Array.from({ length: 30 }, (_, i) => ({ p: 0.05, hit: i < 9 }))).ok, false);
});

// Kleine erfundene Lage: Bise ab 14 Uhr (12 UTC) am 20.6., vorher ruhig. Ohne Varianten gilt die Warnung den ganzen
// Tag, mit Varianten, die bis 13 Uhr alle ruhig sind, bleiben die Stunden davor frei (mit Hinweis), danach nicht.
const T0 = Date.UTC(2026, 5, 19, 0), N = 72, H = k => T0 + k * 3600000;
const series = f => Array.from({ length: N }, (_, k) => f(k, new Date(H(k))));
const biseOn = d => d.getUTCDate() === 20 && d.getUTCHours() >= 12;
function raw() {
  const sea = { t: series(k => H(k)), elevation: 600, temperature_2m: series(() => 16), relative_humidity_2m: series(() => 50), pressure_msl: series(() => 1016), cape: series(() => 0), precipitation_probability: series(() => 0), shortwave_radiation: series((k, d) => (d.getUTCHours() >= 6 && d.getUTCHours() <= 16 ? 600 : 0)), cloud_cover: series(() => 10), cloud_cover_low: series(() => 0), precipitation: series(() => 0), wind_speed_10m: series(() => 8), wind_gusts_10m: series(() => 14), wind_direction_10m: series(() => 200) };
  const p = v => ({ t: sea.t, pressure_msl: series((k, d) => v(d)) });
  return { ref: { sea, pl: null }, sites: {}, areas: { niederhorn: { sea, pl: null, ecmwf: null } }, grad: { LUG: p(() => 1016), KLO: p(d => (biseOn(d) ? 1019 : 1016.5)), GVE: p(() => 1016) } };
}
function ens() {
  const t = series((k, d) => d.toISOString().slice(0, 16));
  const pres = (v, j) => series((k, d) => v(d) + (j % 5) * 0.1);
  const pt = v => { const hourly = { time: t }; for (let j = 0; j < 21; j++) hourly['pressure_msl' + (j ? '_member' + String(j).padStart(2, '0') : '')] = pres(v, j); return parseEnsemble({ hourly }); };
  const area = (() => { const hourly = { time: t }; for (let j = 0; j < 21; j++) { const s = j ? '_member' + String(j).padStart(2, '0') : ''; hourly['wind_gusts_10m' + s] = series(() => 12 + j * 0.5); hourly['wind_speed_10m' + s] = series(() => 7 + j * 0.2); hourly['precipitation' + s] = series(() => 0); } return parseEnsemble({ hourly }); })();
  return { byId: { LUG: pt(() => 1016), KLO: pt(d => (biseOn(d) ? 1019 : 1016.4)), GVE: pt(() => 1016), niederhorn: area }, model: 'test', members: 21, at: T0 };
}
const SITES = [
  { id: 'niederhorn-1', name: 'Niederhorn W', type: 'start', lat: 46.7101, lon: 7.7733, alt: 1930, aspects: [270], area: 'niederhorn' },
  { id: 'niederhorn-land-1', name: 'Lehn', type: 'landing', lat: 46.681, lon: 7.8239, alt: 565, aspects: [], area: 'niederhorn' }
];
const hourOf = (m, local) => m.t.findIndex((t, i) => m.parts[i].date === '2026-06-20' && m.parts[i].hour === local);

test('Bise erst ab 14 Uhr: mit Varianten bleiben die Stunden vorher frei, danach gilt die Warnung weiter', () => {
  const now = Date.UTC(2026, 5, 19, 18);
  const without = new PlanModel({ now, raw: raw(), sites: SITES, obs: {}, stationMeta: {} });
  const withE = new PlanModel({ now, raw: raw(), sites: SITES, obs: {}, stationMeta: {}, ens: ens() });
  const i10 = hourOf(withE, 10), i15 = hourOf(withE, 15), i12 = hourOf(withE, 12);
  assert.notEqual(without.region[i10].bise.level, 'ok', 'ohne Varianten ganzer Tag');
  assert.equal(withE.region[i10].bise.level, 'ok');
  assert.equal(withE.region[i10].biseLater.hour, 14);
  assert.notEqual(withE.region[i12].bise.level, 'ok', '12 Uhr: weniger als 2 h bis zur Bise');
  assert.notEqual(withE.region[i15].bise.level, 'ok');
  const a = withE.compute('normal').get('niederhorn-1').hours[i10].a, b = without.compute('normal').get('niederhorn-1').hours[i10].a;
  assert.ok(a.score > b.score, `${a.score} > ${b.score}`);
  assert.ok(a.reasons.some(r => /erst ab ca\. 14 Uhr/.test(r)), a.reasons.join(' | '));
  // Selbstprüfung aus: wieder ganzer Tag
  const off = new PlanModel({ now, raw: raw(), sites: SITES, obs: {}, stationMeta: {}, ens: { ...ens(), check: { ok: false } } });
  assert.notEqual(off.region[i10].bise.level, 'ok');
  // Tagessicherheit mit Varianten
  const p = withE.planPayload('normal');
  assert.match(p.days[1].conf.why.join(' '), /Wettervarianten/);
  const det = withE.siteDetail('niederhorn-1', 'normal');
  const h10 = det.days[1].hours.find(h => h.h === 10);
  assert.equal(h10.ens.n, 21); assert.equal(h10.later.h, 14);
  assert.ok(h10.why.some(x => x.k === 'Wie sicher'));
});

test('Varianten mit starken Böen kosten Punkte, auch wenn die Hauptprognose ruhig ist', () => {
  const site = { id: 't', alt: 1500, lat: 46.7, lon: 7.8, aspects: [180], terrain: {} };
  const w = { ms: Date.UTC(2026, 5, 21, 10), speed: 12, gust: 20, dir: 180, cloudBase: 3200, cloudCover: 10, cloudCoverLow: 0, pop: 0, precip: 0, cape: 100, sun: 600, valley: { speed: 6, gust: 10 } };
  const calm = assessHour(site, { ...w, ens: { n: 21, g: [16, 24], pHard: 0, pRain: 0 } });
  const risky = assessHour(site, { ...w, ens: { n: 21, g: [16, 45], pHard: 0.43, pRain: 0 } });
  assert.ok(calm.score >= 80 && risky.score <= 79, `${risky.score} vs ${calm.score}`);
  assert.ok(risky.reasons.some(r => /9 von 21 Wettervarianten/.test(r)));
  assert.equal(dayConfidence({ lead: 1, ens: { wind: [3], rain: [0], n: 21 } }).level, 'gut');
  assert.ok(LEVELS.normal.gustHard > 20);
});
