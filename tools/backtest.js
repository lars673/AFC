#!/usr/bin/env node
// Rückblick-Test: Rechnet AFC mit archivierten Prognosen für vergangene Tage durch und vergleicht
// das Urteil mit dem, was die MeteoSchweiz-Stationen tatsächlich gemessen haben.
//
//   node tools/backtest.js              letzte 45 Tage
//   node tools/backtest.js --days 90
//   node tools/backtest.js --from 2026-08-01 --to 2026-09-30
//
// Ergebnis: Zusammenfassung im Terminal und in data/backtest-<datum>.txt, Einzelwerte in data/backtest-<datum>.csv.
//
// Grenzen: Das Open-Meteo-Archiv enthält die jeweils kürzesten Vorhersagen (wenige Stunden voraus). Getestet
// wird also die Bewertungslogik, nicht wie gut eine Prognose von gestern für heute war. Die «Wahrheit» kommt von
// Talstationen; Wind am Startplatz misst niemand. Ein Ergebnis ist ein Hinweis, kein Urteil.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpGet } from '../lib/http.js';
import { PlanModel, areasOf, isRanked, REF_POINT } from '../lib/plan.js';
import { CORE_STATIONS, parseCSVLine, loadStationList } from '../lib/stations.js';
import { regionalFromObs } from '../lib/regional.js';
import { PRESSURE_LEVELS } from '../lib/openmeteo.js';
import { omTimeToMs, zurichParts, haversineKm, isNum } from '../lib/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST = (process.env.AFC_HISTORY_URL || 'https://historical-forecast-api.open-meteo.com').replace(/\/$/, '');
const SMN = (process.env.AFC_SMN_URL || 'https://data.geo.admin.ch').replace(/\/$/, '');
const DAY = 86400000;
const OUT = process.env.AFC_DATA_DIR ? path.resolve(process.env.AFC_DATA_DIR) : path.join(ROOT, 'data');

/* ---------------------------------------------------------------- Argumente */
const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const today = new Date(); today.setUTCHours(0, 0, 0, 0);
const to = arg('to') ? Date.parse(arg('to')) : today.getTime() - DAY;
const from = arg('from') ? Date.parse(arg('from')) : to - (Number(arg('days') || 45) - 1) * DAY;
if (!(to >= from)) { console.error('Zeitraum ungültig'); process.exit(1); }
const ymd = ms => new Date(ms).toISOString().slice(0, 10);

/* ---------------------------------------------------------------- Prognose-Archiv */
const SURFACE = ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'temperature_2m', 'relative_humidity_2m', 'pressure_msl', 'cloud_cover', 'cloud_cover_low', 'precipitation', 'shortwave_radiation', 'cape'];
const PL = PRESSURE_LEVELS.flatMap(l => [`wind_speed_${l}hPa`, `wind_direction_${l}hPa`, `geopotential_height_${l}hPa`, `temperature_${l}hPa`]);

function normalize(d) {
  const h = d?.hourly;
  if (!h?.time?.length) return null;
  const out = { elevation: isNum(d.elevation) ? d.elevation : null, t: h.time.map(omTimeToMs) };
  for (const k of Object.keys(h)) if (k !== 'time') out[k.replace(/_(meteoswiss_icon_seamless|icon_seamless)$/, '')] = h[k];
  return out;
}
async function history(points, vars, models) {
  const byId = {};
  const start = ymd(from - 2 * DAY), end = ymd(Math.min(to + 5 * DAY, today.getTime() - DAY));
  // Open-Meteo gewichtet Abrufe nach Orten, Variablen und Zeitraum und erlaubt rund 600 pro Minute.
  // Deshalb kleine Pakete mit Pause nach Gewicht und bei «HTTP 429» (zu viele Abrufe) warten und wiederholen.
  const SIZE = 5;
  const weight = SIZE * Math.max(1, vars.length / 10) * Math.max(1, (Date.parse(end) - Date.parse(start)) / DAY / 14);
  for (let i = 0; i < points.length; i += SIZE) {
    const chunk = points.slice(i, i + SIZE);
    let lastErr;
    for (const model of models) {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const url = `${HIST}/v1/forecast?latitude=${chunk.map(p => p.lat.toFixed(4)).join(',')}&longitude=${chunk.map(p => p.lon.toFixed(4)).join(',')}&hourly=${vars.join(',')}&models=${model}&start_date=${start}&end_date=${end}&timezone=UTC&wind_speed_unit=kmh`;
          const raw = await (await httpGet(url, { accept: 'application/json', timeoutMs: 60000, retries: 0 })).json();
          const arr = Array.isArray(raw) ? raw : [raw];
          chunk.forEach((p, k) => { const n = normalize(arr[k]); if (n) byId[p.id] = n; });
          lastErr = null;
        } catch (e) {
          lastErr = e;
          if (/HTTP 429/.test(e.message)) { process.stdout.write(' (Open-Meteo bremst, warte 1 Minute) '); await new Promise(r => setTimeout(r, 65000)); continue; }
        }
        break;
      }
      if (!lastErr) break;
    }
    if (lastErr) throw new Error(`Prognose-Archiv (${vars.length} Variablen): ${lastErr.message}`);
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, Math.min(60000, weight / 400 * 60000)));
  }
  return byId;
}

/* ---------------------------------------------------------------- Messungen (MeteoSchweiz, stündlich) */
async function stationHours(code) {
  const c = code.toLowerCase();
  const text = await (await httpGet(`${SMN}/ch.meteoschweiz.ogd-smn/${c}/ogd-smn_${c}_h_recent.csv`, { accept: 'text/csv', timeoutMs: 60000 })).text();
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const h = parseCSVLine(lines[0]).map(s => s.trim());
  const col = (...names) => names.map(n => h.indexOf(n)).find(i => i >= 0);
  const ti = col('reference_timestamp'), wi = col('fu3010h0'), gi = col('fu3010h1'), di = col('dkl010h0'), pi = col('rre150h0');
  if (ti == null || wi == null) throw new Error(`${code}: Spalten nicht erkannt (${h.slice(0, 12).join(', ')})`);
  const n = (r, i) => { if (i == null) return null; const v = Number(String(r[i] ?? '').replace(',', '.')); return String(r[i] ?? '').trim() === '' || !Number.isFinite(v) ? null : v; };
  const out = new Map();
  for (const line of lines.slice(1)) {
    const r = parseCSVLine(line);
    const m = String(r[ti]).match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})/);
    const ms = m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) : Date.parse(r[ti]);
    if (!Number.isFinite(ms) || ms < from - DAY || ms > to + 2 * DAY) continue;
    out.set(ms, { wind: n(r, wi), gust: n(r, gi), dir: n(r, di), precip: n(r, pi) });
  }
  return out;
}

/* ---------------------------------------------------------------- Ablauf */
const sitesFile = JSON.parse(await fs.readFile(path.join(ROOT, 'lib', 'sites.json'), 'utf8'));
const sites = sitesFile.sites;
const ranked = sites.filter(isRanked);
const areas = areasOf(sites.map(s => ({ ...s })));
console.log(`Rückblick ${ymd(from)} bis ${ymd(to)}: ${ranked.length} Startplätze, ${areas.length} Gebiete`);

// Archivdaten zwischenspeichern: ein zweiter Lauf über denselben Zeitraum braucht keine Abrufe
const cacheFile = path.join(OUT, `backtest-cache-${ymd(from)}-${ymd(to)}.json`);
let cache = null;
if (!process.argv.includes('--fresh')) { try { cache = JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch { /* kein Cache */ } }
let sfcSites, sfcAreas, plAreas;
if (cache) { ({ sfcSites, sfcAreas, plAreas } = cache); console.log('Prognose-Archiv aus Zwischenspeicher (--fresh lädt neu)'); }
else {
  process.stdout.write('Prognose-Archiv laden ');
  const sitePts = ranked.map(s => ({ id: s.id, lat: s.lat, lon: s.lon }));
  const areaPts = [...areas.map(a => ({ id: a.id, lat: a.lat, lon: a.lon })), REF_POINT];
  sfcSites = await history(sitePts, SURFACE, ['meteoswiss_icon_seamless', 'icon_seamless', 'best_match']);
  sfcAreas = await history(areaPts, SURFACE, ['meteoswiss_icon_seamless', 'icon_seamless', 'best_match']);
  plAreas = await history(areaPts, PL, ['icon_seamless', 'best_match']);
  console.log(' ok');
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify({ sfcSites, sfcAreas, plAreas }));
}

const obs = {};
if (cache?.obs) for (const [c, rows] of Object.entries(cache.obs)) obs[c] = new Map(rows);
else {
  process.stdout.write('Messwerte MeteoSchweiz laden ');
  for (const code of Object.keys(CORE_STATIONS)) {
    try { obs[code] = await stationHours(code); process.stdout.write('.'); } catch (e) { console.log(`\n  ${e.message}`); }
  }
  console.log(' ok');
  await fs.writeFile(cacheFile, JSON.stringify({ sfcSites, sfcAreas, plAreas, obs: Object.fromEntries(Object.entries(obs).map(([c, m]) => [c, [...m]])) }));
}
if (!Object.keys(obs).length) { console.error('Keine Messwerte, Abbruch.'); process.exit(1); }

// Bergstationen (ab 1500 m): messen Wind und Böen dort, wo gestartet wird, nicht im Tal
const mountain = {};
if (cache?.mountain) for (const [c, v] of Object.entries(cache.mountain)) mountain[c] = { ...v.meta, rows: new Map(v.rows) };
else {
  process.stdout.write('Bergstationen laden ');
  const { list } = await loadStationList();
  for (const st of Object.values(list).filter(x => isNum(x.alt) && x.alt >= 1500)) {
    try { mountain[st.code] = { code: st.code, name: st.name, lat: st.lat, lon: st.lon, alt: st.alt, rows: await stationHours(st.code) }; process.stdout.write('.'); } catch (e) { console.log(`\n  ${st.code}: ${e.message}`); }
  }
  console.log(` ${Object.keys(mountain).length} Stationen`);
  const prev = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  prev.mountain = Object.fromEntries(Object.entries(mountain).map(([c, m]) => [c, { meta: { code: m.code, name: m.name, lat: m.lat, lon: m.lon, alt: m.alt }, rows: [...m.rows] }]));
  await fs.writeFile(cacheFile, JSON.stringify(prev));
}
/** Nächste Bergstation zu einem Startplatz: höchstens 20 km entfernt und 700 m Höhenunterschied. */
const mountainFor = site => Object.values(mountain).map(m => ({ m, d: haversineKm(site.lat, site.lon, m.lat, m.lon), dz: Math.abs((site.alt ?? 0) - m.alt) }))
  .filter(x => x.d <= 20 && x.dz <= 700).sort((a, b) => a.d + a.dz / 100 - (b.d + b.dz / 100))[0]?.m || null;
const mRows = [];

const raw = { fetchedAt: to, model: 'Archiv', sites: sfcSites, areas: {}, ref: { sea: sfcAreas.REF, pl: plAreas.REF || null }, stations: {} };
for (const a of areas) raw.areas[a.id] = { sea: sfcAreas[a.id] || null, pl: plAreas[a.id] || null, ecmwf: null };
if (!raw.ref.sea) { console.error('Keine Referenzprognose, Abbruch.'); process.exit(1); }

/** Messungen einer Stunde für alle Stationen (für Föhnerkennung). */
const obsAt = ms => Object.fromEntries(Object.entries(obs).map(([c, m]) => [c, m.get(ms)]).filter(([, v]) => v));
/** Nächste Kernstation mit Messwerten zu einem Gebiet. */
const nearestStation = a => Object.entries(CORE_STATIONS).filter(([c]) => obs[c]).map(([c, s]) => ({ c, d: haversineKm(a.lat, a.lon, s.lat, s.lon) })).sort((x, y) => x.d - y.d)[0];

const rows = [], dayLines = [];
for (let d = from; d <= to; d += DAY) {
  const date = ymd(d);
  const model = new PlanModel({ now: d + 5 * 3600000, raw, obs: {}, stationMeta: {}, regional: null, trend: null, sites, fetchedAt: d });
  if (!model.ok) continue;
  const plan = model.planPayload('normal');
  const di = plan.dates.indexOf(date);
  if (di < 0) continue;
  const hrs = [];
  for (let ms = d; ms < d + DAY; ms += 3600000) { const h = zurichParts(ms).hour; if (h >= 10 && h <= 16) hrs.push(ms); }
  // Föhn aus Messungen (gleiche Logik wie live), mindestens 2 Stunden
  const foehnHours = hrs.filter(ms => regionalFromObs(obsAt(ms), {}).foehn === 'danger').length;
  const parts = [];
  for (const a of plan.areas) {
    const bestObj = a.days[di] ?? null;
    const best = bestObj?.best?.score ?? null;
    // Was hat AFC zu diesem Urteil gebracht? Gründe zur besten Stunde des besten Startplatzes
    let ko = '', reasons = '', fc = {};
    if (bestObj) {
      const hr = model.siteDetail(bestObj.siteId, 'normal')?.days[di]?.hours.find(h => h.h === bestObj.best.peak);
      if (hr) {
        ko = hr.hard.map(x => x.replace(/^K\.-o\.: /, '')).join(', ');
        reasons = hr.reasons.slice(0, 3).join(', ');
        fc = { wind: hr.speed, gust: hr.gust, cape: hr.cape, pop: hr.pop, therm: hr.thermal, site: bestObj.siteId, hour: hr.h };
      }
    }
    const area = areas.find(x => x.id === a.id);
    const st = nearestStation(area);
    const series = hrs.map(ms => obs[st.c].get(ms)).filter(Boolean);
    const maxGust = Math.max(0, ...series.map(o => o.gust ?? 0));
    const maxWind = Math.max(0, ...series.map(o => o.wind ?? 0));
    const rain = series.reduce((s, o) => s + (o.precip ?? 0), 0);
    const rainHours = series.filter(o => (o.precip ?? 0) >= 0.3).length;
    const why = [];
    if (foehnHours >= 2) why.push('Föhn gemessen');
    if (maxGust >= 45 || maxWind >= 30) why.push(`Wind ${Math.round(maxWind)}/${Math.round(maxGust)} km/h (${st.c})`);
    if (rain >= 1 || rainHours >= 2) why.push(`Regen ${rain.toFixed(1)} mm (${st.c})`);
    const truth = why.length ? 'schlecht' : (rain === 0 && maxGust < 30 ? 'gut' : 'mittel');
    const afc = best === null ? '–' : best >= 80 ? 'Start' : best >= 55 ? 'Prüfen' : 'Nein';
    const verdict = best === null ? 'keine Bewertung' : afc === 'Start' && truth === 'schlecht' ? 'GEFÄHRLICH' : afc === 'Nein' && truth === 'gut' ? 'zu streng' : 'passt';
    // Vergleich mit der Bergstation zur besten Stunde (± 1 Stunde)
    const site = fc.site ? sites.find(x => x.id === fc.site) : null, mst = site ? mountainFor(site) : null;
    if (mst && best !== null) {
      const peakMs = hrs.find(ms => zurichParts(ms).hour === fc.hour);
      const near = peakMs ? [peakMs - 3600000, peakMs, peakMs + 3600000].map(ms => mst.rows.get(ms)).filter(o => o && isNum(o.wind)) : [];
      if (near.length) {
        const mw = Math.max(...near.map(o => o.wind)), mg = Math.max(...near.map(o => o.gust ?? o.wind));
        // nur zählen, wenn Wind oder Böen den Score wirklich gedrückt haben (K.-o. oder deutlicher Abzug)
        const windKo = /Wind|Böen/.test(ko) || /deutliche Böen|kräftiger Wind|stärkerer Wind/.test(reasons);
        const mv = afc === 'Start' && (mg >= 40 || mw >= 28) ? 'GEFÄHRLICH' : afc === 'Nein' && windKo && mg < 25 ? 'zu streng' : 'passt';
        mRows.push({ date, area: a.name, site: site.name, station: mst.code, stationName: mst.name, best, afc, fcWind: fc.wind, fcGust: fc.gust, obsWind: Math.round(mw), obsGust: Math.round(mg), verdict: mv });
      }
    }
    rows.push({ date, area: a.name, best, afc, truth, verdict, why: why.join('; '), station: st.c, maxWind: Math.round(maxWind), maxGust: Math.round(maxGust), rain: +rain.toFixed(1), site: fc.site ?? '', hour: fc.hour ?? '', fcWind: fc.wind ?? '', fcGust: fc.gust ?? '', fcCape: fc.cape ?? '', fcPop: fc.pop ?? '', thermal: fc.therm ?? '', ko, reasons });
    if (verdict !== 'passt' && best !== null) parts.push(`${a.name} ${best} → ${verdict}${why.length ? ' (' + why.join('; ') + ')' : ''}`);
  }
  dayLines.push(`${date}  ${parts.length ? parts.join(' | ') : 'alles passt'}`);
  process.stdout.write('.');
}
console.log('');

/* ---------------------------------------------------------------- Bericht */
const n = rows.filter(r => r.best !== null).length;
const cnt = v => rows.filter(r => r.verdict === v).length;
const pct = x => (n ? Math.round(x / n * 100) : 0) + ' %';
const byTruth = t => rows.filter(r => r.truth === t && r.best !== null);
const avg = a => (a.length ? Math.round(a.reduce((s, r) => s + r.best, 0) / a.length) : '–');
const report = [
  `AFC Rückblick-Test ${ymd(from)} bis ${ymd(to)} (Erfahrungsstufe Normal, bestes Startfenster 10–16 Uhr je Gebiet)`,
  '',
  `Bewertete Gebietstage: ${n}`,
  `  passt:       ${cnt('passt')} (${pct(cnt('passt'))})`,
  `  GEFÄHRLICH:  ${cnt('GEFÄHRLICH')} (${pct(cnt('GEFÄHRLICH'))})  AFC sagte «Start» (80+), gemessen wurde Föhn, Starkwind oder Regen`,
  `  zu streng:   ${cnt('zu streng')} (${pct(cnt('zu streng'))})  AFC sagte «Nein» (unter 55), gemessen war es ruhig und trocken`,
  '',
  `Durchschnittlicher AFC-Score nach Messung: gut ${avg(byTruth('gut'))} · mittel ${avg(byTruth('mittel'))} · schlecht ${avg(byTruth('schlecht'))}`,
  '(Ein guter Score trennt diese drei Gruppen deutlich.)',
  '',
  'Gefährliche Fälle:',
  ...(rows.filter(r => r.verdict === 'GEFÄHRLICH').map(r => `  ${r.date} ${r.area}: Score ${r.best} (${r.site} ${r.hour} Uhr: Prognose Wind ${r.fcWind}/${r.fcGust}, CAPE ${r.fcCape}, Regen ${r.fcPop} %), gemessen: ${r.why}`)),
  ...(cnt('GEFÄHRLICH') ? [] : ['  keine']),
  '',
  'Häufigste Gründe, wenn AFC zu streng war:',
  ...Object.entries(rows.filter(r => r.verdict === 'zu streng').reduce((m, r) => { const k = r.ko || r.reasons.split(', ')[0] || '–'; m[k] = (m[k] || 0) + 1; return m; }, {})).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `  ${v}× ${k}`),
  '',
  'Tag für Tag (nur Abweichungen):',
  ...dayLines,
  '',
  'Hinweis: getestet wird die Bewertungslogik mit kurzfristigen Prognosen. Die Messung stammt von Talstationen.',
  '',
  ...mountainReport()
].join('\n');

function mountainReport() {
  if (!mRows.length) return ['Bergstationen: keine passenden Messungen (Station höchstens 20 km und 700 m Höhe vom Startplatz).'];
  const c = v => mRows.filter(r => r.verdict === v).length;
  const err = (rs, k) => { const v = rs.filter(r => isNum(r['fc' + k]) && isNum(r['obs' + k])).map(r => r['fc' + k] - r['obs' + k]); return v.length ? { bias: v.reduce((x, y) => x + y, 0) / v.length, mae: v.reduce((x, y) => x + Math.abs(y), 0) / v.length, n: v.length } : null; };
  const f = e => (e ? `${e.bias >= 0 ? '+' : ''}${e.bias.toFixed(1)} km/h (Ø Abweichung ${e.mae.toFixed(1)})` : '–');
  const byStation = Object.values(mRows.reduce((m, r) => { (m[r.station] ||= { name: r.stationName, code: r.station, rs: [] }).rs.push(r); return m; }, {}));
  return [
    'WIND UND BÖEN AUF STARTHÖHE (Bergstationen ab 1500 m, beste Stunde ± 1 h)',
    `Verglichene Gebietstage: ${mRows.length}`,
    `  passt:       ${c('passt')} (${Math.round(c('passt') / mRows.length * 100)} %)`,
    `  GEFÄHRLICH:  ${c('GEFÄHRLICH')}  AFC sagte «Start», oben gemessen Böen ab 40 oder Wind ab 28 km/h`,
    `  zu streng:   ${c('zu streng')}  AFC sagte «Nein» wegen Wind/Böen, oben gemessen Böen unter 25 km/h`,
    `Prognose minus Messung, alle: Wind ${f(err(mRows, 'Wind'))}, Böen ${f(err(mRows, 'Gust'))}`,
    '(Plus = AFC rechnet mit mehr Wind als gemessen, Minus = AFC unterschätzt den Wind.)',
    'Je Station:',
    ...byStation.map(b => `  ${b.name} (${b.code}, ${b.rs.length} Tage): Wind ${f(err(b.rs, 'Wind'))}, Böen ${f(err(b.rs, 'Gust'))}`),
    ...(c('GEFÄHRLICH') ? ['Gefährliche Fälle (oben gemessen):', ...mRows.filter(r => r.verdict === 'GEFÄHRLICH').map(r => `  ${r.date} ${r.area} (${r.site}): Score ${r.best}, Prognose ${r.fcWind}/${r.fcGust}, gemessen ${r.obsWind}/${r.obsGust} km/h (${r.stationName})`)] : []),
    ...(c('zu streng') ? ['Zu streng wegen Wind (oben ruhig):', ...mRows.filter(r => r.verdict === 'zu streng').slice(0, 15).map(r => `  ${r.date} ${r.area} (${r.site}): Score ${r.best}, Prognose ${r.fcWind}/${r.fcGust}, gemessen ${r.obsWind}/${r.obsGust} km/h (${r.stationName})`)] : [])
  ];
}
console.log('\n' + report);
const stamp = ymd(Date.now());
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, `backtest-${stamp}.txt`), report + '\n');
const head = Object.keys(rows[0] || { date: 0 });
await fs.writeFile(path.join(OUT, `backtest-${stamp}.csv`), [head.join(';'), ...rows.map(r => head.map(k => String(r[k] ?? '').replace(/;/g, ',')).join(';'))].join('\n') + '\n');
if (mRows.length) { const mh = Object.keys(mRows[0]); await fs.writeFile(path.join(OUT, `backtest-${stamp}-berg.csv`), [mh.join(';'), ...mRows.map(r => mh.map(k => String(r[k] ?? '').replace(/;/g, ',')).join(';'))].join('\n') + '\n'); }
console.log(`\nGespeichert: ${path.join(OUT, `backtest-${stamp}.txt`)} und .csv`);
