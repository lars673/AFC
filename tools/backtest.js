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
import { CORE_STATIONS, parseCSVLine } from '../lib/stations.js';
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
  for (let i = 0; i < points.length; i += 10) {
    const chunk = points.slice(i, i + 10);
    let lastErr;
    for (const model of models) {
      try {
        const url = `${HIST}/v1/forecast?latitude=${chunk.map(p => p.lat.toFixed(4)).join(',')}&longitude=${chunk.map(p => p.lon.toFixed(4)).join(',')}&hourly=${vars.join(',')}&models=${model}&start_date=${start}&end_date=${end}&timezone=UTC&wind_speed_unit=kmh`;
        const raw = await (await httpGet(url, { accept: 'application/json', timeoutMs: 60000 })).json();
        const arr = Array.isArray(raw) ? raw : [raw];
        chunk.forEach((p, k) => { const n = normalize(arr[k]); if (n) byId[p.id] = n; });
        lastErr = null;
        break;
      } catch (e) { lastErr = e; }
    }
    if (lastErr) throw new Error(`Prognose-Archiv (${vars.length} Variablen): ${lastErr.message}`);
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 400));   // Open-Meteo schonen
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

process.stdout.write('Prognose-Archiv laden ');
const sitePts = ranked.map(s => ({ id: s.id, lat: s.lat, lon: s.lon }));
const areaPts = [...areas.map(a => ({ id: a.id, lat: a.lat, lon: a.lon })), REF_POINT];
const sfcSites = await history(sitePts, SURFACE, ['meteoswiss_icon_seamless', 'icon_seamless', 'best_match']);
const sfcAreas = await history(areaPts, SURFACE, ['meteoswiss_icon_seamless', 'icon_seamless', 'best_match']);
const plAreas = await history(areaPts, PL, ['icon_seamless', 'best_match']);
console.log(' ok');

process.stdout.write('Messwerte MeteoSchweiz laden ');
const obs = {};
for (const code of Object.keys(CORE_STATIONS)) {
  try { obs[code] = await stationHours(code); process.stdout.write('.'); } catch (e) { console.log(`\n  ${e.message}`); }
}
console.log(' ok');
if (!Object.keys(obs).length) { console.error('Keine Messwerte, Abbruch.'); process.exit(1); }

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
    const best = a.days[di]?.best?.score ?? null;
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
    rows.push({ date, area: a.name, best, afc, truth, verdict, why: why.join('; '), station: st.c, maxWind: Math.round(maxWind), maxGust: Math.round(maxGust), rain: +rain.toFixed(1) });
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
  ...(rows.filter(r => r.verdict === 'GEFÄHRLICH').map(r => `  ${r.date} ${r.area}: Score ${r.best}, ${r.why}`)),
  ...(cnt('GEFÄHRLICH') ? [] : ['  keine']),
  '',
  'Tag für Tag (nur Abweichungen):',
  ...dayLines,
  '',
  'Hinweis: getestet wird die Bewertungslogik mit kurzfristigen Prognosen. Die Messung stammt von Talstationen.'
].join('\n');
console.log('\n' + report);
const stamp = ymd(Date.now());
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, `backtest-${stamp}.txt`), report + '\n');
const head = Object.keys(rows[0] || { date: 0 });
await fs.writeFile(path.join(OUT, `backtest-${stamp}.csv`), [head.join(';'), ...rows.map(r => head.map(k => String(r[k] ?? '').replace(/;/g, ',')).join(';'))].join('\n') + '\n');
console.log(`\nGespeichert: ${path.join(OUT, `backtest-${stamp}.txt`)} und .csv`);
