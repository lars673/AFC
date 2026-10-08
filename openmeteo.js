// Open-Meteo-Abruf. Die Basis-URL ist per Umgebungsvariable überschreibbar (Tests mit Mock-Server).
import { httpGet } from './http.js';
import { omTimeToMs, isNum } from './util.js';

const BASE = () => (process.env.AFC_OPENMETEO_URL || 'https://api.open-meteo.com').replace(/\/$/, '');
export const PRESSURE_LEVELS = [950, 925, 900, 850, 800, 700, 600];
const CHUNK = 16;
const FORECAST_DAYS = 5;

const CORE = ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'temperature_2m', 'relative_humidity_2m', 'pressure_msl', 'cloud_cover', 'cloud_cover_low', 'precipitation', 'shortwave_radiation'];
const SETS = [
  [...CORE, 'precipitation_probability', 'cape'],
  [...CORE, 'cape'],
  CORE,
  ['wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'temperature_2m', 'relative_humidity_2m', 'pressure_msl']
];
const MODELS = ['meteoswiss_icon_seamless', null];

/** Open-Meteo-Antwort eines Punktes -> { elevation, t:[ms], <variable>:[...] }. */
function normalize(d, model) {
  const h = d?.hourly;
  if (!h?.time?.length) return null;
  const out = { elevation: isNum(d.elevation) ? d.elevation : null, t: h.time.map(omTimeToMs) };
  for (const k of Object.keys(h)) {
    if (k === 'time') continue;
    const base = model && k.endsWith('_' + model) ? k.slice(0, -model.length - 1) : k;
    out[base] = h[k];
  }
  return out;
}

async function getJson(url) {
  const r = await httpGet(url, { accept: 'application/json' });
  return r.json();
}
const coords = pts => `latitude=${pts.map(p => p.lat.toFixed(4)).join(',')}&longitude=${pts.map(p => p.lon.toFixed(4)).join(',')}`;

/** Wetterprognose für viele Punkte. Degradiert schrittweise statt komplett auszufallen. */
export async function fetchForecast(points, { days = FORECAST_DAYS } = {}) {
  const byId = {}, errors = [];
  let used = null;
  const attempts = [];
  for (const m of MODELS) for (const s of SETS) attempts.push({ model: m, vars: s });
  let start = 0;
  for (let i = 0; i < points.length; i += CHUNK) {
    const chunk = points.slice(i, i + CHUNK);
    let ok = false;
    for (let a = start; a < attempts.length && !ok; a++) {
      const att = attempts[a];
      try {
        const url = `${BASE()}/v1/forecast?${coords(chunk)}&hourly=${att.vars.join(',')}&forecast_days=${days}&timezone=UTC&wind_speed_unit=kmh` + (att.model ? `&models=${att.model}` : '');
        const raw = await getJson(url);
        const arr = Array.isArray(raw) ? raw : [raw];
        if (arr.length !== chunk.length) throw new Error(`erwartete ${chunk.length} Punkte, erhielt ${arr.length}`);
        let n = 0;
        chunk.forEach((p, k) => { const nd = normalize(arr[k], att.model); if (nd) { byId[p.id] = nd; n++; } });
        if (!n) throw new Error('leere Zeitreihe');
        ok = true; start = a;
        used = { model: att.model || 'best_match', vars: att.vars.length };
      } catch (e) {
        errors.push(`${att.model || 'best_match'}/${att.vars.length}: ${e.message}`);
      }
    }
    if (!ok) errors.push(`Block ${i / CHUNK + 1} ohne Daten`);
  }
  return { byId, used, errors };
}

/** Wind auf Druckflächen (DWD ICON) – Höhenwindprofil, Scherung, Föhn-/Frontsignale. */
export async function fetchPressureLevels(points, { days = FORECAST_DAYS } = {}) {
  const vars = PRESSURE_LEVELS.flatMap(l => [`wind_speed_${l}hPa`, `wind_direction_${l}hPa`, `geopotential_height_${l}hPa`]);
  const byId = {}, errors = [];
  for (let i = 0; i < points.length; i += CHUNK) {
    const chunk = points.slice(i, i + CHUNK);
    try {
      const raw = await getJson(`${BASE()}/v1/dwd-icon?${coords(chunk)}&hourly=${vars.join(',')}&forecast_days=${days}&timezone=UTC&wind_speed_unit=kmh`);
      const arr = Array.isArray(raw) ? raw : [raw];
      chunk.forEach((p, k) => { const nd = normalize(arr[k]); if (nd) byId[p.id] = nd; });
    } catch (e) { errors.push(e.message); }
  }
  return { byId, errors };
}

/** Zweites Modell (ECMWF) nur für die Uneinigkeit der Modelle. */
export async function fetchSecondModel(points, { days = FORECAST_DAYS } = {}) {
  const byId = {}, errors = [];
  for (let i = 0; i < points.length; i += CHUNK) {
    const chunk = points.slice(i, i + CHUNK);
    try {
      const raw = await getJson(`${BASE()}/v1/forecast?${coords(chunk)}&hourly=wind_speed_10m,wind_gusts_10m&models=ecmwf_ifs025&forecast_days=${days}&timezone=UTC&wind_speed_unit=kmh`);
      const arr = Array.isArray(raw) ? raw : [raw];
      chunk.forEach((p, k) => { const nd = normalize(arr[k], 'ecmwf_ifs025'); if (nd) byId[p.id] = nd; });
    } catch (e) { errors.push(e.message); }
  }
  return { byId, errors };
}

/** Pressure-Level-Reihe einer Stunde -> [{z, speed, dir}] (Meter über Meer). */
export function levelsAt(pl, i) {
  if (!pl) return [];
  const out = [];
  for (const l of PRESSURE_LEVELS) {
    const z = pl[`geopotential_height_${l}hPa`]?.[i], s = pl[`wind_speed_${l}hPa`]?.[i], d = pl[`wind_direction_${l}hPa`]?.[i];
    if (isNum(z) && isNum(s) && isNum(d)) out.push({ z, speed: s, dir: d, hPa: l });
  }
  return out;
}
