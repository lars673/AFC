// «Wind jetzt»: die Windkarte der laufenden Stunde, an die Messwerte der Stationen angepasst.
// Jede Station sagt, um wie viel die Prognose an ihrem Ort und auf ihrer Höhe daneben liegt (gemessen minus Prognose,
// als Windvektor). Diese Abweichung wird auf die Rasterpunkte in der Nähe übertragen: stark bis etwa 20 km und
// 500 Höhenmeter, weiter weg bleibt die Prognose. An einer Station selbst zeigt die Karte fast genau den Messwert.
// Zwischen den Stationen bleibt es eine Schätzung; gemessen ist nur, was an den Stationen steht.
import { haversineKm } from './util.js';

export const WNOW = { km: 20, dz: 500, reg: 0.15, maxAge: 40, levelAlt: { 800: 2000, 700: 3000 } };
const D2R = Math.PI / 180;

/** Windvektor (wohin die Luft strömt) aus Stärke und Herkunftsrichtung. */
export const uvOf = (speed, dirFrom) => [-speed * Math.sin(dirFrom * D2R), -speed * Math.cos(dirFrom * D2R)];
export const dirOf = (u, v) => (Math.atan2(-u, -v) / D2R + 360) % 360;

function sample(g, arr, lat, lon) {
  const fx = (lon - g.lo0) / g.dlo, fy = (lat - g.la0) / g.dla;
  if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return null;
  const x0 = Math.min(Math.floor(fx), g.nx - 2), y0 = Math.min(Math.floor(fy), g.ny - 2), tx = fx - x0, ty = fy - y0, i = y0 * g.nx + x0, j = i + g.nx;
  const a = arr[i], b = arr[i + 1], c = arr[j], e = arr[j + 1];
  if (a == null || b == null || c == null || e == null) return null;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
}
/** Gleiche Höhenmischung wie in der App (Boden bis 1200 m, dann zu 2000 m, dann zu 3000 m). */
function mixAt(lv, elev) {
  const mix = (a, b, t) => (!a ? b : !b ? a : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  if (elev <= 1200) return lv[0] || lv[1];
  if (elev <= 1950) return mix(lv[0], lv[1], (elev - 1200) / 750);
  return mix(lv[1], lv[2], Math.min(1, (elev - 1950) / 1060));
}

/**
 * levels: { '10m': {u, v}, '800': {u, v}, '700': {u, v} } (Felder je Rasterpunkt, km/h), grid: { la0, lo0, dla, dlo, nx, ny },
 * nodeElev: Geländehöhe je Rasterpunkt (für den Bodenwind), stations: [{ lat, lon, alt, wind, dir, age }].
 * Gibt die angepassten Felder und je Station Messwert und Prognose zurück.
 */
export function measuredWind(levels, grid, nodeElev, stations) {
  const used = [];
  for (const s of stations || []) {
    if (![s.lat, s.lon, s.alt, s.wind, s.dir].every(Number.isFinite) || s.age > WNOW.maxAge || s.wind < 0 || s.wind > 250) continue;
    const lv = ['10m', '800', '700'].map(k => { const l = levels[k]; if (!l) return null; const u = sample(grid, l.u, s.lat, s.lon), v = sample(grid, l.v, s.lat, s.lon); return u == null || v == null ? null : [u, v]; });
    const fc = mixAt(lv, s.alt);
    if (!fc) continue;
    const ob = uvOf(s.wind, s.dir);
    used.push({ ...s, ru: ob[0] - fc[0], rv: ob[1] - fc[1], fcWind: Math.round(Math.hypot(fc[0], fc[1])), fcDir: Math.round(dirOf(fc[0], fc[1])) });
  }
  const out = {}, N = grid.nx * grid.ny;
  for (const [k, l] of Object.entries(levels)) {
    const u = new Array(N), v = new Array(N);
    for (let i = 0; i < N; i++) {
      u[i] = l.u[i]; v[i] = l.v[i];
      if (u[i] == null || v[i] == null || !used.length) continue;
      const x = i % grid.nx, y = (i - x) / grid.nx, lat = grid.la0 + y * grid.dla, lon = grid.lo0 + x * grid.dlo;
      const z = k === '10m' ? Math.min(nodeElev?.[i] ?? 800, 1900) : WNOW.levelAlt[k];
      let sw = 0, su = 0, sv = 0;
      for (const s of used) {
        const d = haversineKm(lat, lon, s.lat, s.lon);
        if (d > WNOW.km * 2.5) continue;
        const w = Math.exp(-((d / WNOW.km) ** 2) - ((z - s.alt) / WNOW.dz) ** 2);
        sw += w; su += w * s.ru; sv += w * s.rv;
      }
      if (sw < 0.01) continue;
      u[i] = Math.round((u[i] + su / (sw + WNOW.reg)) * 10) / 10;
      v[i] = Math.round((v[i] + sv / (sw + WNOW.reg)) * 10) / 10;
    }
    out[k] = { u, v };
  }
  return { levels: out, stations: used.map(s => ({ name: s.name, lat: s.lat, lon: s.lon, alt: s.alt, wind: Math.round(s.wind), gust: Number.isFinite(s.gust) ? Math.round(s.gust) : null, dir: Math.round(s.dir), age: s.age, fcWind: s.fcWind, fcDir: s.fcDir })) };
}
