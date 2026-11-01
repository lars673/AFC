// Lufträume aus OpenAir-Dateien (SHV/FSVL: airspace.shv-fsvl.ch) lesen und für Karte und Routenplaner aufbereiten.
// Läuft im Server (Parser) und im Browser (als /airspace.js: Raster für den Routenplaner, Abfrage an einem Punkt).

const D2R = Math.PI / 180, NM_KM = 1.852, FT = 0.3048;

/** Höhenangabe -> { m, ref: 'MSL'|'AGL', text }. FL über Standarddruck (FL100 = 3048 m). */
export function parseHeight(s) {
  const t = String(s || '').trim().toUpperCase();
  if (!t || /^(GND|SFC|GROUND)$/.test(t)) return { m: 0, ref: 'AGL', text: 'Boden' };
  if (/^(UNL|UNLIM|UNLIMITED)/.test(t)) return { m: 99999, ref: 'MSL', text: 'unbegrenzt' };
  let m = t.match(/^FL\s*(\d+)/);
  if (m) return { m: Math.round(Number(m[1]) * 100 * FT), ref: 'MSL', text: 'FL' + Number(m[1]) };
  m = t.match(/^(\d+(?:\.\d+)?)\s*(M|FT|F)?\b\s*(AMSL|MSL|AGL|AGND|GND|SFC|ASFC)?/);
  if (!m) return null;
  const v = Number(m[1]) * (m[2] === 'M' ? 1 : FT), agl = /AGL|AGND|GND|SFC/.test(m[3] || '');
  return { m: Math.round(v), ref: agl ? 'AGL' : 'MSL', text: `${Math.round(v)} m ${agl ? 'über Grund' : 'ü. M.'}` };
}

/** Koordinate «46:59:13 N 007:31:45 E», «46:59.2N 7:31.75E» oder «46.98 N 7.53 E» -> [lat, lon] */
export function parseCoord(s) {
  const m = String(s).toUpperCase().match(/([\d:.]+)\s*([NS])\s*,?\s*([\d:.]+)\s*([EW])/);
  if (!m) return null;
  const dms = x => { const p = x.split(':').map(Number); return p[0] + (p[1] || 0) / 60 + (p[2] || 0) / 3600; };
  const lat = dms(m[1]) * (m[2] === 'S' ? -1 : 1), lon = dms(m[3]) * (m[4] === 'W' ? -1 : 1);
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
}

// Punkt in Abstand (km) und Richtung (Grad, Nord = 0, im Uhrzeigersinn) von einem Mittelpunkt
const dest = (c, km, brg) => [c[0] + km * Math.cos(brg * D2R) / 111.32, c[1] + km * Math.sin(brg * D2R) / (111.32 * Math.cos(c[0] * D2R))];
const bearing = (c, p) => (Math.atan2((p[1] - c[1]) * Math.cos(c[0] * D2R), p[0] - c[0]) / D2R + 360) % 360;
const distKm = (c, p) => Math.hypot((p[0] - c[0]) * 111.32, (p[1] - c[1]) * 111.32 * Math.cos(c[0] * D2R));
function arc(out, c, km, a1, a2, cw) {
  let span = cw ? (a2 - a1 + 360) % 360 : (a1 - a2 + 360) % 360;
  if (span === 0) span = 360;
  const n = Math.max(4, Math.ceil(span / 5));
  for (let i = 0; i <= n; i++) out.push(dest(c, km, a1 + (cw ? 1 : -1) * span * i / n));
}

/**
 * Art des Luftraums für Gleitschirme:
 *  block: ohne Bewilligung verboten (CTR, Klasse A–D, R, P, TMZ, Segelflugverbot)
 *  warn:  beachten (Gefahrengebiet Q/D, RMZ, Wildschutz)
 *  info:  frei (Klasse E/G, Segelflugsektoren, Funkfrequenzen)
 */
export function airKind(cls, type) {
  const c = String(cls || '').toUpperCase(), y = String(type || '').toUpperCase();
  if (/WILD|NATURE|PROTECT/.test(c + ' ' + y)) return 'wild';
  if (/^(A|B|C|D|CTR|R|P|TMZ|GP|PROHIBITED|RESTRICTED)$/.test(c) || /^(CTR|TMA|CTA|RESTRICTED|PROHIBITED|TMZ)$/.test(y)) return 'block';
  if (/^(Q|DANGER|RMZ)$/.test(c) || /^(DANGER|RMZ)$/.test(y)) return 'warn';
  return 'info';
}

/** OpenAir-Text -> [{ name, cls, type, kind, lo, hi, poly: [[lat, lon], ...] }] */
export function parseOpenAir(text) {
  const out = [];
  let cur = null, center = null, cw = true;
  const close = () => { if (cur && cur.poly.length >= 3 && cur.lo && cur.hi) { cur.kind = airKind(cur.cls, cur.type); out.push(cur); } cur = null; center = null; cw = true; };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\*.*$/, '').trim();
    if (!line) continue;
    const key = line.slice(0, 2).toUpperCase(), rest = line.slice(2).trim();
    if (key === 'AC') { close(); cur = { name: '', cls: rest, type: '', lo: null, hi: null, poly: [] }; continue; }
    if (!cur) continue;
    if (key === 'AN') cur.name = rest;
    else if (key === 'AY') cur.type = rest;
    else if (key === 'AL') cur.lo = parseHeight(rest);
    else if (key === 'AH') cur.hi = parseHeight(rest);
    else if (key === 'AF') cur.freq = rest;
    else if (key === 'DP') { const p = parseCoord(rest); if (p) cur.poly.push(p); }
    else if (key[0] === 'V') {
      const v = line.slice(1).trim();
      const x = v.match(/^X\s*=\s*(.+)$/i), d = v.match(/^D\s*=\s*([+-])/i);
      if (x) center = parseCoord(x[1]);
      if (d) cw = d[1] === '+';
    } else if (key === 'DC' && center) {
      const km = Number(rest) * NM_KM;
      if (km > 0) for (let a = 0; a < 360; a += 5) cur.poly.push(dest(center, km, a));
    } else if (key === 'DA' && center) {
      const [r, a1, a2] = rest.split(',').map(Number);
      if (r > 0) arc(cur.poly, center, r * NM_KM, a1, a2, cw);
    } else if (key === 'DB' && center) {
      const [p1, p2] = rest.split(/,(?=\s*\d)/).map(parseCoord);
      if (p1 && p2) arc(cur.poly, center, (distKm(center, p1) + distKm(center, p2)) / 2, bearing(center, p1), bearing(center, p2), cw);
    }
  }
  close();
  return out;
}

/** Nur Lufträume im Rechteck [s, w, n, e] behalten. */
export function clipToBox(list, [s, w, n, e]) {
  return list.filter(a => a.poly.some(p => p[0] >= s && p[0] <= n && p[1] >= w && p[1] <= e) ||
    (Math.min(...a.poly.map(p => p[0])) < n && Math.max(...a.poly.map(p => p[0])) > s && Math.min(...a.poly.map(p => p[1])) < e && Math.max(...a.poly.map(p => p[1])) > w));
}

export function inPoly(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Höhengrenze in m ü. M. an einem Ort mit Geländehöhe ground. */
export const limitMsl = (h, ground) => (h.ref === 'AGL' ? ground + h.m : h.m);

/** Alle Lufträume an einem Punkt, unterste zuerst. */
export function airspaceAt(list, lat, lon, ground = 0) {
  return list.filter(a => a.bbox ? lat >= a.bbox[0] && lat <= a.bbox[2] && lon >= a.bbox[1] && lon <= a.bbox[3] && inPoly(lat, lon, a.poly) : inPoly(lat, lon, a.poly))
    .sort((a, b) => limitMsl(a.lo, ground) - limitMsl(b.lo, ground));
}

/**
 * Für den Routenplaner: je Rasterzelle das unterste gesperrte Band [lo, hi] in m ü. M. (NaN = frei) und sein Name.
 * grid: { la0, lo0, dla, dlo, nx, ny, ground }
 */
export function airspaceRaster(list, grid) {
  const N = grid.nx * grid.ny, lo = new Float32Array(N).fill(NaN), hi = new Float32Array(N).fill(NaN), name = new Array(N).fill(null);
  for (const a of list) {
    if (a.kind !== 'block') continue;
    const bb = a.bbox || bboxOf(a.poly);
    const y0 = Math.max(0, Math.floor((bb[0] - grid.la0) / grid.dla)), y1 = Math.min(grid.ny - 1, Math.ceil((bb[2] - grid.la0) / grid.dla));
    const x0 = Math.max(0, Math.floor((bb[1] - grid.lo0) / grid.dlo)), x1 = Math.min(grid.nx - 1, Math.ceil((bb[3] - grid.lo0) / grid.dlo));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const lat = grid.la0 + y * grid.dla, lon = grid.lo0 + x * grid.dlo;
      if (!inPoly(lat, lon, a.poly)) continue;
      const k = y * grid.nx + x, g = grid.ground[k] || 0, l = limitMsl(a.lo, g), h = limitMsl(a.hi, g);
      if (!Number.isNaN(lo[k]) && lo[k] <= l) continue;   // es gibt schon ein tieferes Band
      lo[k] = l; hi[k] = h; name[k] = a.name;
    }
  }
  return { lo, hi, name };
}

export function bboxOf(poly) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const [la, lo] of poly) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
  return [s, w, n, e];
}

if (typeof window !== 'undefined') window.AFCAir = { parseOpenAir, airspaceAt, airspaceRaster, limitMsl, inPoly, bboxOf };
