// Windfeld für die Karte: regelmässiges Raster über dem Berner Oberland, Boden (10 m) und zwei Höhen.
// Quelle: MeteoSwiss ICON (10 m) und DWD ICON (Druckflächen) über Open-Meteo.
import { httpGet } from './http.js';
import { omTimeToMs, isNum, toVector, solarPosition } from './util.js';
import { thermalProfile } from './scoring.js';

const BASE = () => (process.env.AFC_OPENMETEO_URL || 'https://api.open-meteo.com').replace(/\/$/, '');
// Süd-West-Ecke und Maschenweite (ca. 9 x 8.5 km). Open-Meteo zählt jeden Punkt als Abruf (Gratislimit 10 000/Tag),
// deshalb grob und nur alle 3 Stunden; für die Darstellung wird dazwischen interpoliert.
export const GRID = { la0: 46.22, lo0: 6.98, dla: 0.08, dlo: 0.11, ny: 10, nx: 15 };
export const WIND_LEVELS = { '10m': { label: 'Boden', hourly: ['wind_speed_10m', 'wind_direction_10m'] }, '800': { label: 'ca. 2000 m', hourly: ['wind_speed_800hPa', 'wind_direction_800hPa'] }, '700': { label: 'ca. 3000 m', hourly: ['wind_speed_700hPa', 'wind_direction_700hPa'] } };
// Zusätzliche Werte für die Thermik-Wärmekarte. Open-Meteo zählt je 10 Variablen einen Abruf:
// Boden 2 + 5 = 7 und Höhe 4 + 4 = 8 Variablen, also keine zusätzlichen Abrufe.
const THERMAL_SFC = ['shortwave_radiation', 'cloud_cover_low', 'precipitation', 'cape', 'temperature_2m'];
const THERMAL_PL = { 850: 1460, 800: 1950, 700: 3010, 600: 4200 };   // Standardhöhe der Druckflächen in m
const CHUNK = 100;
const DAYS = 5;

/** Rasterpunkte zeilenweise von Süden nach Norden, je Zeile von Westen nach Osten. */
export function gridPoints(g = GRID) {
  const out = [];
  for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) out.push({ lat: +(g.la0 + y * g.dla).toFixed(4), lon: +(g.lo0 + x * g.dlo).toFixed(4) });
  return out;
}

async function fetchSet(points, path, vars, extra = '') {
  const res = [];
  for (let i = 0; i < points.length; i += CHUNK) {
    const chunk = points.slice(i, i + CHUNK);
    const url = `${BASE()}${path}?latitude=${chunk.map(p => p.lat).join(',')}&longitude=${chunk.map(p => p.lon).join(',')}&hourly=${vars.join(',')}&forecast_days=${DAYS}&timezone=UTC&wind_speed_unit=kmh${extra}`;
    const raw = await (await httpGet(url, { accept: 'application/json' })).json();
    const arr = Array.isArray(raw) ? raw : [raw];
    if (arr.length !== chunk.length) throw new Error(`Windraster: erwartete ${chunk.length} Punkte, erhielt ${arr.length}`);
    res.push(...arr);
  }
  return res;
}

/**
 * Lädt das Windfeld. -> { fetchedAt, grid, t:[ms], levels: { '10m': { u: [[...je Punkt]...je Stunde], v }, ... } }
 * u/v in km/h (Ostwärts-/Nordwärtskomponente, wohin der Wind weht), auf 0.1 gerundet.
 */
export async function fetchWindGrid() {
  const pts = gridPoints();
  const [sfc, pl] = await Promise.all([
    fetchSet(pts, '/v1/forecast', [...WIND_LEVELS['10m'].hourly, ...THERMAL_SFC], '&models=meteoswiss_icon_seamless'),
    fetchSet(pts, '/v1/dwd-icon', [...WIND_LEVELS['800'].hourly, ...WIND_LEVELS['700'].hourly, ...Object.keys(THERMAL_PL).map(l => `temperature_${l}hPa`)])
  ]);
  const t = (sfc[0]?.hourly?.time || []).map(omTimeToMs);
  if (!t.length) throw new Error('Windraster: leere Zeitreihe');
  const levels = {};
  for (const [id, def] of Object.entries(WIND_LEVELS)) {
    const src = id === '10m' ? sfc : pl;
    const key = k => (id === '10m' ? `${k}_meteoswiss_icon_seamless` : k);
    const u = [], v = [];
    for (let h = 0; h < t.length; h++) {
      const ur = new Array(pts.length), vr = new Array(pts.length);
      for (let p = 0; p < pts.length; p++) {
        const hr = src[p]?.hourly || {};
        const s = (hr[key(def.hourly[0])] ?? hr[def.hourly[0]])?.[h], d = (hr[key(def.hourly[1])] ?? hr[def.hourly[1]])?.[h];
        if (isNum(s) && isNum(d)) {
          const w = toVector(s, d);   // meteorologische u/v: Richtung, in die die Luft strömt
          ur[p] = Math.round(w.u * 10) / 10; vr[p] = Math.round(w.v * 10) / 10;
        } else { ur[p] = null; vr[p] = null; }
      }
      u.push(ur); v.push(vr);
    }
    levels[id] = { u, v };
  }
  return { fetchedAt: Date.now(), grid: GRID, t, levels, thermal: thermalFields(sfc, pl, t.length) };
}

/**
 * Je Stunde und Rasterpunkt: Sonne (W/m²), tiefe Wolken (%), Regen (mm), Thermikobergrenze (m ü. M.)
 * und Aufwindgeschwindigkeit w* (m/s) nach dem Thermikprofil der Startplatzbewertung.
 */
function thermalFields(sfc, pl, nt) {
  const out = { sun: [], low: [], rain: [], top: [], wstar: [] };
  const val = (src, p, k, h) => { const hr = src[p]?.hourly || {}; const v = (hr[`${k}_meteoswiss_icon_seamless`] ?? hr[k])?.[h]; return isNum(v) ? v : null; };
  for (let h = 0; h < nt; h++) {
    const row = { sun: [], low: [], rain: [], top: [], wstar: [] };
    for (let p = 0; p < sfc.length; p++) {
      const sun = val(sfc, p, 'shortwave_radiation', h), t2 = val(sfc, p, 'temperature_2m', h), ground = sfc[p]?.elevation;
      const levels = Object.entries(THERMAL_PL).map(([l, z]) => ({ z, temp: val(pl, p, `temperature_${l}hPa`, h) }));
      const tp = isNum(ground) ? thermalProfile(levels, t2, ground, sun || 0) : null;
      row.sun.push(isNum(sun) ? Math.round(sun) : null);
      row.low.push(val(sfc, p, 'cloud_cover_low', h));
      row.rain.push(val(sfc, p, 'precipitation', h));
      row.top.push(tp ? tp.top : null);
      row.wstar.push(tp ? tp.wstar : null);
    }
    for (const k of Object.keys(out)) out[k].push(row[k]);
  }
  return out;
}

/** Eine Stunde Thermikdaten für die Wärmekarte, mit Sonnenstand jetzt und eine Stunde vorher (Aufheizung). */
export function thermalSlice(wg, ms) {
  if (!wg?.thermal) return null;
  let h = 0, bd = Infinity;
  for (let i = 0; i < wg.t.length; i++) { const d = Math.abs(wg.t[i] - ms); if (d < bd) { bd = d; h = i; } }
  if (bd > 90 * 60000) return null;
  const g = wg.grid, lat = g.la0 + (g.ny - 1) * g.dla / 2, lon = g.lo0 + (g.nx - 1) * g.dlo / 2;
  const pos = t => { const s = solarPosition(t, lat, lon); return { elev: Math.round(s.elevationDeg * 10) / 10, az: Math.round(s.azimuthDeg * 10) / 10 }; };
  const th = wg.thermal, prev = Math.max(0, h - 1);
  return {
    t: new Date(wg.t[h]).toISOString(), grid: g, sunPos: pos(wg.t[h]), sunPrev: pos(wg.t[h] - 3600000),
    sun: th.sun[h], sunBefore: th.sun[prev], low: th.low[h], rain: th.rain[h], top: th.top[h], wstar: th.wstar[h],
    fetchedAt: new Date(wg.fetchedAt).toISOString()
  };
}

/** Eine Stunde und Höhe für die App. */
export function windSlice(wg, ms, level) {
  if (!wg || !wg.levels[level]) return null;
  let h = 0, bd = Infinity;
  for (let i = 0; i < wg.t.length; i++) { const d = Math.abs(wg.t[i] - ms); if (d < bd) { bd = d; h = i; } }
  if (bd > 90 * 60000) return null;
  return { t: new Date(wg.t[h]).toISOString(), level, label: WIND_LEVELS[level].label, grid: wg.grid, u: wg.levels[level].u[h], v: wg.levels[level].v[h], fetchedAt: new Date(wg.fetchedAt).toISOString() };
}
