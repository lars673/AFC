// Wolken für die 3D-Ansicht: Höhe der Wolkenbasis (Kondensationsniveau je Prognosepunkt, auf das Windraster verteilt)
// und Nebelmeer (unten sitzt ein Punkt im Nebel, weiter oben ist es frei). Alles Schätzungen aus der Bodenprognose.
import { isNum } from './util.js';
import { cloudBaseMsl } from './scoring.js';
import { dewPoint } from './plan.js';

/** Ab wann ein Prognosepunkt als «im Nebel» bzw. «frei von tiefen Wolken» gilt. */
export const FOG = { rh: 96, low: 85, clearLow: 50, clearRh: 92, maxFloor: 1000, maxTop: 2200, maxUp: 55 };

/**
 * points: [{ lat, lon, elev, t2, rh, low }] (lat/lon dürfen fehlen: der Punkt zählt dann nur für das Nebelmeer).
 * -> { base: [m ü. M. je Rasterpunkt, zeilenweise von Süden] | null, fog: { top } | null, up: tiefe Bewölkung über dem Nebel in % | null }
 */
export function cloudField(points, grid) {
  const P = (points || []).filter(p => isNum(p.elev) && isNum(p.t2) && isNum(p.rh));
  if (!P.length) return null;
  const foggy = p => p.rh >= FOG.rh && (p.low ?? 0) >= FOG.low;
  const clear = p => isNum(p.low) && p.low <= FOG.clearLow && p.rh <= FOG.clearRh;
  let fog = null, up = null;
  const F = P.filter(foggy);
  if (F.length) {
    const floor = Math.min(...F.map(p => p.elev));
    const above = P.filter(p => clear(p) && p.elev >= floor + 150);
    if (floor <= FOG.maxFloor && above.length) {
      const loClear = Math.min(...above.map(p => p.elev));
      const hiFog = Math.max(...F.filter(p => p.elev < loClear).map(p => p.elev));
      const top = Math.round(Math.min(hiFog + 350, Math.max(hiFog + 60, (hiFog + loClear) / 2)) / 10) * 10;
      const over = P.filter(p => p.elev > top && isNum(p.low));
      const mean = over.length ? Math.round(over.reduce((a, p) => a + p.low, 0) / over.length) : null;
      // ein Nebelmeer ist es nur, wenn es darüber überwiegend frei ist (sonst: Schlechtwetter mit tiefer Basis)
      if (top <= FOG.maxTop && mean != null && mean <= FOG.maxUp) { fog = { top }; up = mean; }
    }
  }
  // Basis: Punkte im Nebel zählen nicht (dort läge die «Basis» am Boden)
  const B = P.filter(p => isNum(p.lat) && isNum(p.lon) && !(fog && p.elev <= fog.top))
    .map(p => ({ lat: p.lat, lon: p.lon, b: cloudBaseMsl(p.t2, dewPoint(p.t2, p.rh), p.elev) })).filter(p => isNum(p.b));
  let base = null;
  if (B.length && grid) {
    base = new Array(grid.nx * grid.ny);
    const kLon = Math.cos((grid.la0 + grid.ny * grid.dla / 2) * Math.PI / 180) * 111.32;
    for (let y = 0; y < grid.ny; y++) for (let x = 0; x < grid.nx; x++) {
      const la = grid.la0 + y * grid.dla, lo = grid.lo0 + x * grid.dlo;
      let s = 0, w = 0;
      for (const p of B) { const dy = (p.lat - la) * 111.32, dx = (p.lon - lo) * kLon, k = 1 / (dx * dx + dy * dy + 9); s += p.b * k; w += k; }
      base[y * grid.nx + x] = Math.round(s / w / 10) * 10;
    }
  }
  return { base, fog, up };
}

/** Prognosepunkte einer Stunde aus dem Rohstand: Startplätze, Gebietspunkte, Bezugspunkt im Tal und Stationen. */
export function cloudPoints(raw, ms, sites, areas, ref) {
  const out = [];
  const add = (fc, lat, lon) => {
    if (!fc?.t?.length) return;
    const i = Math.round((ms - fc.t[0]) / 3600000);
    if (i < 0 || i >= fc.t.length || Math.abs(fc.t[i] - ms) > 1800000) return;
    out.push({ lat, lon, elev: fc.elevation, t2: fc.temperature_2m?.[i], rh: fc.relative_humidity_2m?.[i], low: fc.cloud_cover_low?.[i] });
  };
  for (const s of sites || []) add(raw?.sites?.[s.id], s.lat, s.lon);
  for (const a of areas || []) add(raw?.areas?.[a.id]?.sea, a.lat, a.lon);
  if (ref) add(raw?.ref?.sea, ref.lat, ref.lon);
  for (const st of Object.values(raw?.stations || {})) add(st, null, null);
  return out;
}
