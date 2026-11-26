/**
 * Wind im Gelände aus WindNinja (US Forest Service, mass-consistent solver), für 16 Windrichtungen im Voraus gerechnet
 * (tools/windninja.py, 100 m Raster über swissALTI3D). Die Lösung ist linear im Anströmwind: je Zelle und Richtung genügen
 * ein Faktor (Tempo im Gelände durch Anströmtempo) und eine Ablenkung in Grad. Der Browser holt den Ausschnitt seiner Szene.
 * Datei wn/wind.bin: je Richtung nx*ny Bytes Faktor (Wert/64) und nx*ny Bytes Ablenkung (Int8, Grad); wn/meta.json beschreibt das Raster.
 */
import fs from 'node:fs';
import path from 'node:path';

let cache;
export function load(root) {
  if (cache !== undefined) return cache;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'wn', 'meta.json'), 'utf8'));
    const buf = fs.readFileSync(path.join(root, 'wn', 'wind.bin'));
    if (buf.length !== meta.nx * meta.ny * meta.dirs * 2) throw new Error('Grösse passt nicht');
    cache = { meta, buf };
  } catch { cache = null; }
  return cache;
}

/**
 * Ausschnitt b = [süd, west, nord, ost], höchstens max Zellen je Seite (gröber, wenn nötig).
 * Rückgabe: Buffer aus 4 Byte Kopflänge, Kopf als JSON, dann je Richtung Faktor- und Ablenkungs-Bytes.
 */
export function slice(root, b, max = 200) {
  const W = load(root);
  if (!W) return null;
  const m = W.meta;
  let x0 = Math.floor((b[1] - m.lo0) / m.dlo), x1 = Math.ceil((b[3] - m.lo0) / m.dlo), y0 = Math.floor((b[0] - m.la0) / m.dla), y1 = Math.ceil((b[2] - m.la0) / m.dla);
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(m.nx - 1, x1); y1 = Math.min(m.ny - 1, y1);
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const st = Math.max(1, Math.ceil(Math.max(x1 - x0 + 1, y1 - y0 + 1) / max));
  const nx = Math.min(Math.ceil((x1 - x0) / st) + 1, Math.floor((m.nx - 1 - x0) / st) + 1), ny = Math.min(Math.ceil((y1 - y0) / st) + 1, Math.floor((m.ny - 1 - y0) / st) + 1), N = m.nx * m.ny;
  const head = Buffer.from(JSON.stringify({ la0: m.la0 + y0 * m.dla, lo0: m.lo0 + x0 * m.dlo, dla: m.dla * st, dlo: m.dlo * st, nx, ny, dirs: m.dirs, fScale: m.fScale, src: m.src }));
  const out = Buffer.alloc(4 + head.length + nx * ny * m.dirs * 2);
  out.writeUInt32LE(head.length, 0); head.copy(out, 4);
  let q = 4 + head.length;
  for (let d = 0; d < m.dirs; d++) for (const part of [0, 1]) {
    const base = d * 2 * N + part * N;
    for (let y = 0; y < ny; y++) { const row = base + (y0 + y * st) * m.nx + x0; for (let x = 0; x < nx; x++) out[q++] = W.buf[row + x * st]; }
  }
  return out;
}

/**
 * Geländewind an einem Punkt nach WindNinja für Anströmung aus Richtung dir (Grad, woher): { f, dev } mit
 * f = Tempo im Gelände / Anströmtempo, dev = Ablenkung in Grad. null ausserhalb des gerechneten Gebiets.
 */
export function at(root, lat, lon, dir) {
  const W = load(root);
  if (!W || !Number.isFinite(dir)) return null;
  const m = W.meta, fx = (lon - m.lo0) / m.dlo, fy = (lat - m.la0) / m.dla;
  if (!(fx >= 0 && fy >= 0 && fx <= m.nx - 1 && fy <= m.ny - 1)) return null;
  const N = m.nx * m.ny, x0 = Math.min(m.nx - 2, Math.floor(fx)), y0 = Math.min(m.ny - 2, Math.floor(fy)), tx = fx - x0, ty = fy - y0, k = y0 * m.nx + x0;
  const dr = (((dir % 360) + 360) % 360) / (360 / m.dirs), d0 = Math.floor(dr) % m.dirs, d1 = (d0 + 1) % m.dirs, t = dr - Math.floor(dr);
  const u8 = W.buf, i8 = v => (v > 127 ? v - 256 : v);
  const bil = (o, sgn) => { const g = j => (sgn ? i8(u8[o + j]) : u8[o + j]); return (g(k) * (1 - tx) + g(k + 1) * tx) * (1 - ty) + (g(k + m.nx) * (1 - tx) + g(k + m.nx + 1) * tx) * ty; };
  const fA = bil(d0 * 2 * N, false), fB = bil(d1 * 2 * N, false), aA = bil(d0 * 2 * N + N, true), aB = bil(d1 * 2 * N + N, true);
  // Mittel über ±R Zellen (≈ 1 km, Masche des Wettermodells ICON-CH1): der Wettermodell-Wind enthält das grobe Gelände schon,
  // WindNinja liefert nur, was der Startplatz gegenüber seiner Modellmasche anders hat (rel).
  const R = 5, cx = Math.round(fx), cy = Math.round(fy);
  let sA = 0, sB = 0, n = 0;
  for (let y = Math.max(0, cy - R); y <= Math.min(m.ny - 1, cy + R); y++) for (let x = Math.max(0, cx - R); x <= Math.min(m.nx - 1, cx + R); x++) {
    const j = y * m.nx + x; sA += u8[d0 * 2 * N + j]; sB += u8[d1 * 2 * N + j]; n++;
  }
  const f = (fA + (fB - fA) * t) / m.fScale, ref = n ? (sA + (sB - sA) * t) / n / m.fScale : f;
  return { f, ref, rel: ref > 0.05 ? f / ref : 1, dev: aA + (aB - aA) * t };
}

export const _reset = () => { cache = undefined; };
