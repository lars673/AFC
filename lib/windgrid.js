// Windfeld für die Karte: regelmässiges Raster über dem Berner Oberland, Boden (10 m) und zwei Höhen.
// Quelle: MeteoSwiss ICON (10 m) und DWD ICON (Druckflächen) über Open-Meteo.
import { httpGet } from './http.js';
import { omTimeToMs, isNum, toVector } from './util.js';

const BASE = () => (process.env.AFC_OPENMETEO_URL || 'https://api.open-meteo.com').replace(/\/$/, '');
// Süd-West-Ecke und Maschenweite (ca. 9 x 8.5 km). Open-Meteo zählt jeden Punkt als Abruf (Gratislimit 10 000/Tag),
// deshalb grob und nur alle 3 Stunden; für die Darstellung wird dazwischen interpoliert.
export const GRID = { la0: 46.22, lo0: 6.98, dla: 0.08, dlo: 0.11, ny: 10, nx: 15 };
export const WIND_LEVELS = { '10m': { label: 'Boden', hourly: ['wind_speed_10m', 'wind_direction_10m'] }, '800': { label: 'ca. 2000 m', hourly: ['wind_speed_800hPa', 'wind_direction_800hPa'] }, '700': { label: 'ca. 3000 m', hourly: ['wind_speed_700hPa', 'wind_direction_700hPa'] } };
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
    fetchSet(pts, '/v1/forecast', WIND_LEVELS['10m'].hourly, '&models=meteoswiss_icon_seamless'),
    fetchSet(pts, '/v1/dwd-icon', [...WIND_LEVELS['800'].hourly, ...WIND_LEVELS['700'].hourly])
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
  return { fetchedAt: Date.now(), grid: GRID, t, levels };
}

/** Eine Stunde und Höhe für die App. */
export function windSlice(wg, ms, level) {
  if (!wg || !wg.levels[level]) return null;
  let h = 0, bd = Infinity;
  for (let i = 0; i < wg.t.length; i++) { const d = Math.abs(wg.t[i] - ms); if (d < bd) { bd = d; h = i; } }
  if (bd > 90 * 60000) return null;
  return { t: new Date(wg.t[h]).toISOString(), level, label: WIND_LEVELS[level].label, grid: wg.grid, u: wg.levels[level].u[h], v: wg.levels[level].v[h], fetchedAt: new Date(wg.fetchedAt).toISOString() };
}
