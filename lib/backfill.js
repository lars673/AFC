// Nachlernen aus den vergangenen Tagen: Föhn- und Bisedruck (Prognose-Archiv von Open-Meteo) und die stündlichen
// Messungen der MeteoSchweiz. So muss AFC nicht warten, bis es selber genug Föhn- und Bisetage gesammelt hat.
import { httpGet } from './http.js';
import { parseCSVLine } from './stations.js';
import { regionalFromObs } from './regional.js';
import { isNum, omTimeToMs } from './util.js';
import { FOEHN_POINTS } from './plan.js';

/** Stationen, die für die Föhn- und Bise-Erkennung zählen (lib/regional.js), plus die Druckstationen. */
export const BACKFILL_STATIONS = ['GRH', 'THU', 'INT', 'MER', 'ABO', 'GUE', 'BER', 'PLF', 'BRZ', 'LUG', 'KLO', 'GVE'];
const HOUR = 3600000, DAY = 86400000;

/** Stündliche Messdatei der MeteoSchweiz (…_h_recent.csv) lesen: Mittelwind, stärkste Böe, Richtung, QFF. */
export function parseHourlyCSV(text, fromMs = -Infinity, toMs = Infinity) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const out = new Map();
  if (!lines.length) return out;
  const h = parseCSVLine(lines[0]).map(s => s.trim());
  const col = n => { const i = h.indexOf(n); return i >= 0 ? i : null; };
  const ti = col('reference_timestamp'), wi = col('fu3010h0'), gi = col('fu3010h1'), di = col('dkl010h0'), qi = col('pp0qffh0');
  if (ti == null) return out;
  const n = (r, i) => { if (i == null) return null; const s = String(r[i] ?? '').trim(); const v = Number(s.replace(',', '.')); return s === '' || !Number.isFinite(v) ? null : v; };
  for (const line of lines.slice(1)) {
    const r = parseCSVLine(line);
    const m = String(r[ti]).match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2})/);
    const ms = m ? Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) : Date.parse(r[ti]);
    if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) continue;
    out.set(ms, { wind: n(r, wi), gust: n(r, gi), dir: n(r, di), qff: n(r, qi) });
  }
  return out;
}

/**
 * Gemessene Lage je Stunde aus den Stationsreihen: Druckunterschiede und Föhn-/Bise-Signal wie in der App.
 * obsByCode: { CODE: Map(ms → {wind,gust,dir,qff}) }. Rückgabe: Zeilen für die Tabelle reg_obs.
 */
export function regionalRows(obsByCode, fromMs, toMs) {
  const rows = [];
  for (let ms = Math.ceil(fromMs / HOUR) * HOUR; ms <= toMs; ms += HOUR) {
    const obs = {}, qff = {}, time = new Date(ms).toISOString();
    for (const [c, m] of Object.entries(obsByCode)) {
      const v = m.get(ms);
      if (!v) continue;
      obs[c] = v;
      if (isNum(v.qff)) qff[c] = { qff: v.qff, time };
    }
    if (Object.keys(obs).length < 3) continue;
    const r = regionalFromObs(obs, {}, qff, ms);
    rows.push({ time, odp: r.dp?.foehn ?? null, obdp: r.dp?.bise ?? null, foehn: r.foehnScore, bise: r.biseScore });
  }
  return rows;
}

/** Prognostizierte Druckunterschiede je Stunde aus den Reihen Lugano, Kloten, Genf (Open-Meteo-Format). */
export function gradRows(grad) {
  const series = c => { const s = grad?.[c]; return s?.time && s.pressure_msl ? new Map(s.time.map((t, i) => [omTimeToMs(t), s.pressure_msl[i]])) : new Map(); };
  const lug = series('LUG'), klo = series('KLO'), gve = series('GVE');
  const rows = [];
  for (const [ms, k] of klo) {
    if (!isNum(k)) continue;
    const l = lug.get(ms), g = gve.get(ms);
    const fdp = isNum(l) ? Math.round((l - k) * 10) / 10 : null, bdp = isNum(g) ? Math.round((k - g) * 10) / 10 : null;
    if (isNum(fdp) || isNum(bdp)) rows.push({ time: new Date(ms).toISOString(), fdp, bdp });
  }
  return rows.sort((a, b) => a.time.localeCompare(b.time));
}

/** Tage mit gemessener Bise oder Föhn (Signal ab 40 in mindestens einer Stunde, Zürcher Kalendertag). */
export function eventDays(rows, key) {
  const days = new Map();
  for (const r of rows) {
    if (!(r[key] >= 40)) continue;
    const d = new Date(Date.parse(r.time)).toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' });
    days.set(d, Math.max(days.get(d) || 0, r[key]));
  }
  return [...days.entries()].map(([day, max]) => ({ day, max: Math.round(max) }));
}

/**
 * Archiv laden: Prognose-Druck für Lugano, Kloten, Genf und stündliche Messungen der Stationen.
 * Einzelne fehlende Stationen sind kein Fehler; ohne Druckprognose gibt es keine Prognosezeilen.
 */
export async function fetchRegionalHistory({ smn, hist, days = 90, now = Date.now(), get = httpGet }) {
  const toMs = Math.floor(now / HOUR) * HOUR - HOUR, fromMs = toMs - days * DAY;
  const ymd = ms => new Date(ms).toISOString().slice(0, 10);
  const pts = FOEHN_POINTS;
  let grad = {}, gradError = null;
  try {
    const url = `${hist}/v1/forecast?latitude=${pts.map(p => p.lat.toFixed(4)).join(',')}&longitude=${pts.map(p => p.lon.toFixed(4)).join(',')}&hourly=pressure_msl&models=meteoswiss_icon_seamless&start_date=${ymd(fromMs)}&end_date=${ymd(toMs)}&timezone=UTC`;
    const raw = await (await get(url, { accept: 'application/json', timeoutMs: 60000 })).json();
    const arr = Array.isArray(raw) ? raw : [raw];
    pts.forEach((p, k) => { const h = arr[k]?.hourly; if (h?.time) grad[p.id] = { time: h.time, pressure_msl: h.pressure_msl || h.pressure_msl_meteoswiss_icon_seamless }; });
  } catch (e) { gradError = e.message; grad = {}; }
  const obs = {}, missing = [];
  for (const code of BACKFILL_STATIONS) {
    const c = code.toLowerCase();
    try {
      const text = await (await get(`${smn}/ch.meteoschweiz.ogd-smn/${c}/ogd-smn_${c}_h_recent.csv`, { accept: 'text/csv', timeoutMs: 60000 })).text();
      const m = parseHourlyCSV(text, fromMs, toMs);
      if (m.size) obs[code] = m; else missing.push(code);
    } catch { missing.push(code); }
  }
  return { fc: gradRows(grad), obs: regionalRows(obs, fromMs, toMs), fromMs, toMs, missing, gradError };
}
