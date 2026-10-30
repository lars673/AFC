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

test('Modellböen bei schwachem Wind werden begrenzt (Bergstationen: 5/43 prognostiziert, 5/10 gemessen)', () => {
  assert.ok(gustAtLaunch(5, 4, 43) <= 20, String(gustAtLaunch(5, 4, 43)));
  assert.ok(gustAtLaunch(19, 15, 70) <= 38, String(gustAtLaunch(19, 15, 70)));
  assert.ok(gustAtLaunch(30, 25, 55) >= 55, 'bei kräftigem Wind bleiben echte Böen');
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
  // Föhn hält länger als Bise und Talwind
  assert.equal(localForHour(st, 4).foehn, 'danger');
  assert.equal(localForHour(st, 8).foehn, 'warn');
  assert.ok(localForHour(st, 4).biseScore < 50);
  assert.equal(localForHour(st, 10), null);
});

test('Taupunkt', () => {
  assert.ok(Math.abs(dewPoint(20, 50) - 9.3) < 0.3);
  assert.equal(decisionFor(90).id, 'go');
});

test('Windstille wird nicht bestraft, Richtung ist dann egal', () => {
  const base = assessHour(site, good()).score;
  const calm = assessHour(site, good({ speed: 3, gust: 6, dir: 0 }));
  assert.equal(calm.hard.length, 0);
  assert.ok(base - calm.score <= 6, `Differenz ${base - calm.score}`);
});

test('Schwacher Rückenwind ist Abzug, kein K.-o.', () => {
  const r = assessHour(site, good({ speed: 6, gust: 9, dir: 0 }));
  assert.equal(r.hard.length, 0);
  assert.ok(r.score < assessHour(site, good()).score);
});

test('Seitenwind wird nur einmal abgezogen', () => {
  const diff = assessHour(site, good()).score - assessHour(site, good({ dir: 270 })).score;
  assert.ok(diff > 0 && diff <= 20, `Differenz ${diff}`);
});

test('Starker Gegenwind: Erfahrene bekommen kein K.-o. unter ihrer Windgrenze', () => {
  const w = good({ speed: 34, gust: 40, speed10: 34 });
  assert.equal(assessHour(site, w, LEVELS.expert).hard.length, 0);
  assert.ok(assessHour(site, w, LEVELS.careful).hard.length > 0);
});

test('Bergschatten im Horizont senkt das Thermiksignal', () => {
  const morning = Date.UTC(2026, 5, 21, 6, 0); // Sonne tief im Osten
  const open = { ...site, aspects: [90], terrain: { slopeDeg: 25, horizonAngles: { 75: 2, 90: 2, 105: 2 } } };
  const shaded = { ...site, aspects: [90], terrain: { slopeDeg: 25, horizonAngles: { 75: 40, 90: 40, 105: 40 } } };
  const w = good({ ms: morning, dir: 90, sun: 400 });
  assert.ok(assessHour(open, w).thermal > assessHour(shaded, w).thermal);
});

test('Alle Startplätze haben Geländedaten', async () => {
  const { default: data } = await import('../lib/sites.json', { with: { type: 'json' } });
  const starts = data.sites.filter(s => s.type === 'start');
  for (const s of starts) {
    assert.ok(Number.isFinite(s.terrain?.slopeDeg), s.id + ' ohne Neigung');
    assert.equal(Object.keys(s.terrain.horizonAngles).length, 24, s.id + ' Horizont unvollständig');
    assert.ok(Number.isFinite(s.alt), s.id + ' ohne Höhe');
  }
});

test('Sonnenstand: Mittag, Auf- und Untergang in Bern stimmen', async () => {
  const { solarPosition } = await import('../lib/util.js');
  const noon = solarPosition(Date.UTC(2026, 5, 21, 11, 24), 46.95, 7.45);
  assert.ok(Math.abs(noon.elevationDeg - 66.5) < 1 && Math.abs(noon.azimuthDeg - 180) < 8);
  assert.ok(solarPosition(Date.UTC(2026, 5, 21, 17, 0), 46.95, 7.45).elevationDeg > 15, 'Sommer 19 Uhr: Sonne noch hoch');
  assert.ok(solarPosition(Date.UTC(2026, 11, 21, 17, 0), 46.95, 7.45).elevationDeg < 0, 'Winter 18 Uhr: Nacht');
});

test('Thermikprofil: labile Luft trägt hoch, Inversion deckelt', async () => {
  const { thermalProfile } = await import('../lib/scoring.js');
  const std = [1500, 2000, 2500, 3000, 4000].map(z => ({ z, temp: 18 - 0.0085 * (z - 1000) }));
  const inv = [{ z: 1500, temp: 15 }, { z: 2000, temp: 16 }, { z: 3000, temp: 10 }, { z: 4000, temp: 3 }];
  const a = thermalProfile(std, 18, 1000, 650), b = thermalProfile(inv, 18, 1000, 650);
  assert.ok(a.top > 2500, 'labil ' + a.top);
  assert.ok(b.top < 1700, 'Inversion ' + b.top);
  assert.equal(b.inversion, 1500);
  assert.ok(a.wstar > b.wstar);
  assert.equal(thermalProfile(std, 18, 1000, 0).top, 1000, 'ohne Sonne keine Thermik');
});

test('Ruhiger Tag ohne Thermik ist höchstens «Prüfen», nicht «Starten»', () => {
  const stable = { top: 1550, inversion: 1500, wstar: 0.4 };
  const r = assessHour(site, good({ speed: 4, gust: 6, thermik: stable }));
  assert.equal(r.hard.length, 0);
  assert.ok(r.score <= 74 && r.score >= 60, 'Score ' + r.score);
  const unstable = { top: 3400, inversion: null, wstar: 2.2 };
  assert.ok(assessHour(site, good({ speed: 4, gust: 6, thermik: unstable })).score >= 80);
});

test('Abendliche Abkühlung ist kein Frontsignal', () => {
  const n = 14, lh = Array.from({ length: n }, (_, i) => 8 + i);
  const T = lh.map(h => (h <= 15 ? 20 : 20 - (h - 15) * 1.5));   // ab 15 Uhr 1.5 °C pro Stunde kühler
  const P = Array.from({ length: n }, (_, i) => 1015 - i * 0.3);  // leichter Druckfall
  const s = frontRiskSeries({ P, T, D800: Array(n).fill(200), S800: Array(n).fill(15), CAPE: Array(n).fill(0), POP: Array(n).fill(0), lh });
  assert.ok(s.every(x => x.level === 'ok'), s.map(x => x.level).join(','));
});

test('Ruhiger Herbsttag mit mässiger Thermik bleibt unter «Startbereit»', () => {
  // echte Werte Kuonisbergli 30.10.2026, 12 Uhr: kaum Wind, Sonne 500 W/m², trockene Luft
  const r = assessHour({ ...site, alt: 1700, aspects: [90] }, good({ ms: Date.UTC(2026, 9, 30, 11), speed: 4, gust: 11, dir: 81, cloudBase: 2700, cloudCover: 0, cloudCoverLow: 0, sun: 500, cape: 0 }));
  assert.ok(r.score < 80 && r.score >= 65, 'Score ' + r.score);
});

test('Kurz erklärt: fünf Punkte, Gefahren rot', async () => {
  const { explainHour } = await import('../lib/scoring.js');
  const w = good();
  const ok = explainHour(assessHour(site, w), w);
  assert.deepEqual(ok.map(f => f.k), ['Start', 'Thermik', 'Wolken', 'Wetterlage', 'Landung']);
  assert.ok(ok.every(f => f.lvl === 'ok'), JSON.stringify(ok));
  const wf = good({ front: { level: 'danger', why: ['Druckfall 4.0 hPa in 6 h'] } });
  const bad = explainHour(assessHour(site, wf), wf);
  assert.equal(bad.find(f => f.k === 'Wetterlage').lvl, 'danger');
  const wt = good({ dir: 0, speed: 14 });
  assert.equal(explainHour(assessHour(site, wt), wt).find(f => f.k === 'Start').lvl, 'danger');
});

test('Schauer am Nachmittag senken das Startfenster am Mittag (Rückblick 3.8.2026)', () => {
  const unstable = { top: 3400, inversion: null, wstar: 2.2 };
  const dry = assessHour(site, good({ thermik: unstable })).score;
  const r = assessHour(site, good({ thermik: unstable, later: { precip: 2.3, cape: 860, hour: 16 } }));
  assert.ok(dry >= 80 && r.score < 80, `${dry} -> ${r.score}`);
  assert.ok(r.reasons.some(x => /ab ca. 16 Uhr/.test(x)), r.reasons.join(' | '));
});

test('Hohe Schleierwolken lösen kein «Wolke am Startplatz» aus', () => {
  const r = assessHour(site, good({ cloudBase: 1600, cloudCover: 90, cloudCoverLow: 0 }));
  assert.ok(!r.hard.some(x => /Wolke/.test(x)), r.hard.join(' | '));
  assert.ok(assessHour(site, good({ cloudBase: 1600, cloudCover: 90, cloudCoverLow: 60 })).hard.some(x => /Wolke/.test(x)));
});

test('Sicherer Tag ohne Thermik fällt nicht auf «Nicht starten»', () => {
  const stable = { top: 1550, inversion: 1500, wstar: 0.4 };
  // deutliche Böen ohne Thermik: früher unter 55 («Nicht starten»), obwohl nichts gefährlich ist
  const r = assessHour(site, good({ speed: 4, gust: 19, thermik: stable }));
  assert.equal(r.hard.length, 0);
  assert.ok(r.score >= 55 && r.score < 80, 'Score ' + r.score);
});

test('Pilotenprofil: Erfahrung, Übung und Pause bestimmen die Stufe', async () => {
  const { pilotLevel, pilotHint } = await import('../lib/pilot.js');
  const now = Date.UTC(2026, 9, 30);
  assert.equal(pilotLevel({}), null);
  assert.equal(pilotLevel({ flights: 20, hours12: 5, glider: 'A' }, now).level, 'careful');
  assert.equal(pilotLevel({ flights: 150, hours12: 35, glider: 'B', lastFlight: '2026-10-20' }, now).level, 'normal');
  assert.equal(pilotLevel({ flights: 600, hours12: 80, glider: 'C', lastFlight: '2026-10-25' }, now).level, 'expert');
  // lange Pause: eine Stufe vorsichtiger, nach 4 Monaten ganz vorsichtig
  assert.equal(pilotLevel({ flights: 600, hours12: 80, glider: 'C', lastFlight: '2026-09-01' }, now).level, 'normal');
  assert.equal(pilotLevel({ flights: 600, hours12: 80, glider: 'C', lastFlight: '2026-05-01' }, now).level, 'careful');
  assert.equal(pilotLevel({ flights: 600, hours12: 80, glider: 'D', student: true }, now).level, 'careful');
  // kräftige Thermik ist für Einsteiger ein Hinweis, für Erfahrene nicht
  assert.equal(pilotHint({ flights: 20, hours12: 5, glider: 'A' }, { wstar: 2.8, speed: 10, gust: 14 }, now).lvl, 'warn');
  assert.equal(pilotHint({ flights: 600, hours12: 80, glider: 'C', lastFlight: '2026-10-25' }, { wstar: 2.8, speed: 10, gust: 14 }, now).lvl, 'ok');
});

test('Routenplaner: umfliegt zu hohes Gelände, nutzt Thermik, meldet Gegenwind', async () => {
  const { planRoute } = await import('../lib/route.js');
  const nx = 40, ny = 30, N = nx * ny;
  const F = { la0: 46.5, lo0: 7.5, dla: 0.009, dlo: 0.013, nx, ny, q: new Float32Array(N).fill(0.5), top: new Float32Array(N).fill(3000), ground: new Float32Array(N).fill(1500), u: new Float32Array(N), v: new Float32Array(N), wstar: new Float32Array(N).fill(2), needH: new Float32Array(N).fill(0) };
  // Bergkette in der Mitte (x = 20) über der Thermik, mit einer Lücke bei y = 25
  for (let y = 0; y < ny; y++) if (y !== 25) F.ground[y * nx + 20] = 3200;
  const at = (x, y) => [F.la0 + y * F.dla, F.lo0 + x * F.dlo];
  const r = planRoute(F, at(5, 5), at(35, 5));
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.cells.some(k => k === 25 * nx + 20), 'Route muss durch die Lücke');
  assert.ok(r.distKm > 30 && r.hours > 0, `${r.distKm} km ${r.hours} h`);
  // ohne Lücke: keine Route
  F.ground[25 * nx + 20] = 3200;
  assert.equal(planRoute(F, at(5, 5), at(35, 5)).ok, false);
  // starker Gegenwind wird gemeldet
  F.ground[25 * nx + 20] = 1500;
  F.u.fill(-20);
  const h = planRoute(F, at(5, 25), at(35, 25));
  assert.ok(h.issues.some(i => i.kind === 'head'), JSON.stringify(h.issues));
  // sicher meidet Strecken ohne Landeplatz stärker als schnell
  F.u.fill(0);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (y < 20) F.needH[y * nx + x] = Infinity;
  const safe = planRoute(F, at(5, 22), at(35, 22), { mode: 'safe' });
  assert.ok(safe.ok && safe.issues.every(i => i.kind !== 'land'), JSON.stringify(safe.issues));
});

test('Routenplaner: Gleitflug ohne Thermik geht, solange die Höhe reicht (Niederhorn nach Interlaken)', async () => {
  const { planRoute } = await import('../lib/route.js');
  const nx = 60, ny = 10, N = nx * ny;
  // 500-m-Raster, Talboden 600 m, keine Thermik
  const F = { la0: 46.6, lo0: 7.6, dla: 0.0045, dlo: 0.0065, nx, ny, q: new Float32Array(N), top: new Float32Array(N).fill(600), ground: new Float32Array(N).fill(600), u: new Float32Array(N), v: new Float32Array(N), wstar: new Float32Array(N), needH: new Float32Array(N).fill(800) };
  const at = (x, y) => [F.la0 + y * F.dla, F.lo0 + x * F.dlo];
  const r = planRoute(F, at(2, 5), at(18, 5), { startAlt: 1950 });   // ca. 8 km
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.arriveAgl > 100 && r.climbs === 0, `Ankunft ${r.arriveAgl} m, Thermik ${r.climbs}`);
  assert.equal(planRoute(F, at(2, 5), at(58, 5), { startAlt: 1950 }).ok, false, '28 km reichen ohne Thermik nicht');
});

test('Routenplaner: Wetter ändert sich während des Flugs (Thermik hört nach einer Stunde auf)', async () => {
  const { planRoute } = await import('../lib/route.js');
  const nx = 120, ny = 6, N = nx * ny;
  const mk = (q, top) => ({ la0: 46.6, lo0: 7.0, dla: 0.0045, dlo: 0.0065, nx, ny, q: new Float32Array(N).fill(q), top: new Float32Array(N).fill(top), ground: new Float32Array(N).fill(1000), u: new Float32Array(N), v: new Float32Array(N), wstar: new Float32Array(N).fill(q ? 2 : 0), needH: new Float32Array(N).fill(0) });
  const good = mk(0.6, 3000), dead = mk(0, 1000);
  const at = x => [46.6 + 3 * 0.0045, 7.0 + x * 0.0065];
  const all = planRoute(good, at(2), at(117), { startAlt: 1800, later: [good, good, good] });   // ca. 57 km
  assert.equal(all.ok, true, all.reason);
  assert.ok(all.hours > 1.2, 'Flug dauert ' + all.hours + ' h');
  assert.equal(planRoute(good, at(2), at(117), { startAlt: 1800, later: [dead] }).ok, false, 'ohne Thermik ab der 2. Stunde nicht machbar');
});

test('Lufträume: OpenAir lesen (Kreis, Bogen, Höhen) und Art für Gleitschirme', async () => {
  const { parseOpenAir, parseHeight, airspaceAt, airKind } = await import('../lib/airspace.js');
  const { MOCK_AIR } = await import('./mock-upstream.js');
  const l = parseOpenAir(MOCK_AIR);
  assert.equal(l.length, 4, l.map(a => a.name).join(', '));
  const ctr = l.find(a => /CTR/.test(a.name));
  assert.equal(ctr.kind, 'block');
  assert.deepEqual([ctr.lo.m, ctr.lo.ref, ctr.hi.m], [0, 'AGL', 2300]);
  assert.ok(Math.abs(ctr.poly[0][0] - (46.7417 + 3 * 1.852 / 111.32)) < 0.002, 'Kreis 3 NM um den Mittelpunkt');
  assert.equal(l.find(a => /TMA/.test(a.name)).hi.m, 3962);
  assert.equal(l.find(a => /Gefahren/.test(a.name)).kind, 'warn');
  assert.deepEqual(airspaceAt(l, 46.7417, 8.1083).map(a => a.name), ['TEST CTR Meiringen']);
  assert.deepEqual(airspaceAt(l, 46.70, 8.012).map(a => a.name), ['TEST Gefahrengebiet Axalp'], 'Bogen gegen den Uhrzeigersinn liegt im Westen');
  assert.deepEqual(parseHeight('1000ft AGL'), { m: 305, ref: 'AGL', text: '305 m über Grund' });
  assert.equal(parseHeight('FL 95').m, 2896);
  assert.equal(parseHeight('2900 m AMSL').m, 2900);
  assert.equal(airKind('E', ''), 'info');
  assert.equal(airKind('C', 'TMA'), 'block');
});

test('Routenplaner: bleibt unter einem Luftraum und fliegt um eine Kontrollzone herum', async () => {
  const { planRoute } = await import('../lib/route.js');
  const nx = 60, ny = 30, N = nx * ny;
  const F = { la0: 46.6, lo0: 7.6, dla: 0.0045, dlo: 0.0065, nx, ny, q: new Float32Array(N).fill(0.6), top: new Float32Array(N).fill(3200), ground: new Float32Array(N).fill(800), u: new Float32Array(N), v: new Float32Array(N), wstar: new Float32Array(N).fill(2), needH: new Float32Array(N).fill(0) };
  const at = (x, y) => [F.la0 + y * F.dla, F.lo0 + x * F.dlo];
  const air = { lo: new Float32Array(N).fill(NaN), hi: new Float32Array(N).fill(NaN), name: new Array(N).fill(null) };
  // TMA ab 1700 m über der ganzen rechten Hälfte
  for (let y = 0; y < ny; y++) for (let x = 30; x < nx; x++) { const k = y * nx + x; air.lo[k] = 1700; air.hi[k] = 3962; air.name[k] = 'TMA'; }
  const r = planRoute(F, at(2, 15), at(55, 15), { startAlt: 1800, air });
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.cells.every((k, i) => (k % nx) < 30 || r.heights[i] <= 1650), 'unter der TMA: ' + r.heights.join(','));
  assert.ok(r.issues.some(i => i.kind === 'air' && /TMA/.test(i.text)), JSON.stringify(r.issues));
  // Kontrollzone vom Boden bis 2300 m in der Mitte (x 25–35, y 5–25): die Route geht aussen herum
  air.lo.fill(NaN); air.hi.fill(NaN);
  for (let y = 5; y <= 25; y++) for (let x = 25; x <= 35; x++) { const k = y * nx + x; air.lo[k] = 800; air.hi[k] = 2300; air.name[k] = 'CTR'; }
  F.top.fill(2000);   // Thermik reicht nicht über die CTR
  const c = planRoute(F, at(2, 15), at(55, 15), { startAlt: 1800, air });
  assert.equal(c.ok, true, c.reason);
  assert.ok(c.cells.every(k => { const x = k % nx, y = Math.floor(k / nx); return !(x >= 25 && x <= 35 && y >= 5 && y <= 25); }), 'nicht durch die CTR');
});

test('Föhnregel: Druck Lugano minus Zürich', async () => {
  const { foehnFromGradient, worstLevel } = await import('../lib/scoring.js');
  assert.equal(foehnFromGradient(null), 'ok');
  assert.equal(foehnFromGradient(2.5), 'ok');
  assert.equal(foehnFromGradient(5), 'warn');
  assert.equal(foehnFromGradient(9.2), 'danger');
  assert.equal(worstLevel('ok', 'warn', 'ok'), 'warn');
  assert.equal(worstLevel('warn', 'danger'), 'danger');
  // Föhnsignal: höchstens «Vorsicht» und der Grund nennt den Druckunterschied
  const a = assessHour(site, good({ foehn: 'warn', foehnDp: 5.4 }));
  assert.ok(a.score <= 74, 'Score ' + a.score);
  assert.ok(a.reasons.some(r => /Lugano–Zürich \+5\.4 hPa/.test(r)), a.reasons.join(' | '));
});
