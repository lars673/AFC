// Zweite Wetterquelle: Lokalprognose von MeteoSchweiz (Open Government Data, CC BY 4.0).
// Springt nur ein, wenn Open-Meteo ausfällt. Dann bleibt die letzte volle Open-Meteo-Prognose
// (Höhenwind, Thermik, Labilität) die Grundlage, und für die kommenden Stunden ersetzt AFC am Boden
// Wind, Böen, Windrichtung, Regen, Wolken und Strahlung durch die frische MeteoSchweiz-Prognose.
// Ein Punkt gilt nur, wenn er nah genug und auf ähnlicher Höhe liegt; sonst bleibt der alte Wert.
import { httpGet } from './http.js';

const BASE = () => (process.env.AFC_MSFC_URL || process.env.AFC_SMN_URL || 'https://data.geo.admin.ch').replace(/\/$/, '');
const COLL = 'ch.meteoschweiz.ogd-local-forecasting';

/** MeteoSchweiz-Parameter -> Variablenname wie bei Open-Meteo (Wolken 0..1 -> Prozent). */
export const MS_PARAMS = {
  fu3010h0: { k: 'wind_speed_10m' },
  fu3010h1: { k: 'wind_gusts_10m' },
  dkl010h0: { k: 'wind_direction_10m' },
  rre150h0: { k: 'precipitation' },
  gre000h0: { k: 'shortwave_radiation' },
  nprolohs: { k: 'cloud_cover_low', f: 100 },
  npromths: { k: '_cloud_mid', f: 100 },
  nprohihs: { k: '_cloud_high', f: 100 }
};
export const MS_MAX_KM = 15, MS_MAX_DZ = 600;

/** Punktliste (ogd-local-forecasting_meta_point.csv) -> [{id, name, lat, lon, z}]. */
export function parsePoints(text) {
  const lines = String(text || '').split(/\r?\n/), head = (lines.shift() || '').split(';');
  const ix = n => head.indexOf(n);
  const iId = ix('point_id'), iN = ix('point_name'), iZ = ix('point_height_masl'), iLa = ix('point_coordinates_wgs84_lat'), iLo = ix('point_coordinates_wgs84_lon');
  if ([iId, iZ, iLa, iLo].some(i => i < 0)) return [];
  const out = [];
  for (const l of lines) {
    const c = l.split(';');
    const lat = Number(c[iLa]), lon = Number(c[iLo]), z = Number(c[iZ]);
    if (c[iId] && Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(z)) out.push({ id: c[iId], name: c[iN] || '', lat, lon, z });
  }
  return out;
}

const km = (a, b) => {
  const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
};
/** Bester Punkt für einen Ort: nah und auf ähnlicher Höhe (100 m Höhe zählen wie 1 km Distanz). */
export function nearestPoint(points, at) {
  let best = null;
  for (const p of points) {
    const d = km(at, p), dz = at.alt != null ? Math.abs(p.z - at.alt) : 0;
    if (d > MS_MAX_KM || dz > MS_MAX_DZ) continue;
    const s = d + dz / 100;
    if (!best || s < best.s) best = { id: p.id, name: p.name, d: Math.round(d * 10) / 10, dz: Math.round(dz), s };
  }
  return best;
}

/** «202611181500» (UTC) -> ms. */
export const msTime = s => (/^\d{12}$/.test(s) ? Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)) : NaN);

/** Eine Parameter-Datei zeilenweise lesen, nur die gesuchten Punkte behalten -> Map(id -> Map(ms -> Wert)). */
export function makeParamParser(wanted) {
  const out = new Map();
  let rest = '', cols = null;
  const line = l => {
    if (!l) return;
    const c = l.split(';');
    if (!cols) { cols = c; return; }
    if (!wanted.has(c[0])) return;
    const t = msTime(c[2]), v = Number(c[3]);
    if (!Number.isFinite(t) || c[3] === '' || !Number.isFinite(v)) return;
    if (!out.has(c[0])) out.set(c[0], new Map());
    out.get(c[0]).set(t, v);
  };
  return {
    push(chunk) { const parts = (rest + chunk).split(/\r?\n/); rest = parts.pop(); for (const l of parts) line(l); },
    end() { line(rest); rest = ''; return out; }
  };
}

/**
 * Eine Zeitreihe (Open-Meteo-Form {t:[ms], wind_speed_10m:[…], …}) ab fromMs mit MeteoSchweiz-Werten überschreiben.
 * vals: { <param>: Map(ms -> Wert) } für den passenden Punkt. Gibt die Zahl ersetzter Stunden zurück.
 */
export function patchSeries(series, vals, fromMs) {
  if (!series?.t?.length || !vals) return 0;
  let n = 0;
  series.t.forEach((t, i) => {
    if (t < fromMs) return;
    let hit = false;
    const cl = {};
    for (const [p, def] of Object.entries(MS_PARAMS)) {
      const v = vals[p]?.get(t);
      if (v == null) continue;
      const x = def.f ? Math.round(v * def.f) : v;
      if (def.k.startsWith('_')) { cl[def.k] = x; continue; }
      if (!Array.isArray(series[def.k])) series[def.k] = new Array(series.t.length).fill(null);
      series[def.k][i] = x; hit = true;
    }
    // Gesamtbewölkung grob aus tief, mittel und hoch (überlappend angenommen)
    const lo = vals.nprolohs?.get(t);
    if (lo != null && cl._cloud_mid != null && cl._cloud_high != null && Array.isArray(series.cloud_cover)) {
      const free = (1 - lo) * (1 - cl._cloud_mid / 100) * (1 - cl._cloud_high / 100);
      series.cloud_cover[i] = Math.round((1 - free) * 100);
    }
    if (hit) n++;
  });
  return n;
}

async function text(url, timeoutMs = 60000) { return (await httpGet(url, { accept: 'text/csv', timeoutMs })).text(); }
async function json(url) { return (await httpGet(url, { accept: 'application/json' })).json(); }

/** Neuester vollständiger Lauf (alle Parameter vorhanden): heute, sonst gestern. -> { item, run, files: {param: url} } */
export async function latestRun(now = Date.now()) {
  for (const back of [0, 1]) {
    const day = new Date(now - back * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
    let it;
    try { it = await json(`${BASE()}/api/stac/v1/collections/${COLL}/items/${day}-ch`); } catch { continue; }
    const runs = new Map();
    for (const [k, a] of Object.entries(it.assets || {})) {
      const m = k.match(/\.(\d{12})\.([a-z0-9]{8})\.csv$/);
      if (!m || !MS_PARAMS[m[2]]) continue;
      if (!runs.has(m[1])) runs.set(m[1], {});
      runs.get(m[1])[m[2]] = a.href;
    }
    const full = [...runs.entries()].filter(([, f]) => Object.keys(MS_PARAMS).every(p => f[p])).sort((a, b) => b[0].localeCompare(a[0]));
    if (full.length) return { run: full[0][0], files: full[0][1] };
  }
  return null;
}

let POINTS = null, POINTS_AT = 0;
/** Punktliste, einmal am Tag. */
export async function msPoints() {
  if (POINTS && Date.now() - POINTS_AT < 86400000) return POINTS;
  const buf = await (await httpGet(`${BASE()}/${COLL}/ogd-local-forecasting_meta_point.csv`, { accept: 'text/csv' })).arrayBuffer();
  POINTS = parsePoints(new TextDecoder('latin1').decode(buf)); POINTS_AT = Date.now();
  return POINTS;
}

/** Datei streamen und nur die gesuchten Punkte behalten (die Dateien sind je rund 30 MB). */
async function streamParam(url, wanted) {
  const r = await httpGet(url, { accept: 'text/csv', timeoutMs: 120000 });
  const p = makeParamParser(wanted), dec = new TextDecoder('latin1');
  for await (const chunk of r.body) p.push(dec.decode(chunk, { stream: true }));
  return p.end();
}

/**
 * Lokalprognose für Orte holen. targets: [{key, lat, lon, alt}].
 * -> { run, at, byKey: { key: { point, vals: {param: Map} } }, missing: [key] }
 */
export async function fetchMsForecast(targets) {
  const [pts, lr] = await Promise.all([msPoints(), latestRun()]);
  if (!lr) throw new Error('MeteoSchweiz: kein vollständiger Prognoselauf gefunden');
  const pick = {}, missing = [];
  for (const t of targets) { const p = nearestPoint(pts, t); if (p) pick[t.key] = p; else missing.push(t.key); }
  const wanted = new Set(Object.values(pick).map(p => p.id));
  const data = {};
  for (const [param, url] of Object.entries(lr.files)) data[param] = await streamParam(url, wanted);
  const byKey = {};
  for (const [key, p] of Object.entries(pick)) {
    const vals = {};
    for (const param of Object.keys(MS_PARAMS)) vals[param] = data[param]?.get(p.id) || new Map();
    byKey[key] = { point: p, vals };
  }
  return { run: lr.run, at: Date.now(), byKey, missing };
}
