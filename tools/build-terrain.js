#!/usr/bin/env node
// Berechnet einmalig die Geländedaten der Startplätze (Hangneigung, Exposition, Relief, Horizont)
// und schreibt sie als `terrain` in lib/sites.json. Nur bei neuen/geänderten Startplätzen nötig.
//
//   node tools/build-terrain.js
//
// Höhenmodell: AWS Terrain Tiles (Terrarium-PNG, Zoom 12, ca. 26 m Raster in der Schweiz).
// Keine Abhängigkeiten: PNG wird mit zlib dekodiert. Kacheln werden in .cache/terrain zwischengespeichert.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITES = path.join(ROOT, 'lib', 'sites.json');
const CACHE = path.join(ROOT, '.cache', 'terrain');
const Z = 12, TILE = 256;
const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const R_EARTH = 6371000;
const HORIZON_STEP = 15;      // Grad zwischen den Horizont-Richtungen
const HORIZON_MAX = 20000;    // m, so weit wird nach Bergschatten gesucht

/* ---------------------------------------------------------------- PNG (8 bit RGB/RGBA, ohne Interlace) */
function decodePng(buf) {
  let pos = 8, width = 0, height = 0, channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('PNG-Format nicht unterstützt');
      channels = { 2: 3, 6: 4 }[data[9]];
      if (!channels) throw new Error('PNG-Farbtyp nicht unterstützt: ' + data[9]);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels, out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? out[dst + i - channels] : 0;
      const b = y > 0 ? out[dst - stride + i] : 0;
      const c = y > 0 && i >= channels ? out[dst - stride + i - channels] : 0;
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[dst + i] = v & 255;
    }
  }
  const elev = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    elev[i] = out[o] * 256 + out[o + 1] + out[o + 2] / 256 - 32768;
  }
  return elev;
}

/* ---------------------------------------------------------------- Höhenmodell */
const tiles = new Map();
async function loadTile(x, y) {
  const key = `${x}/${y}`;
  if (!tiles.has(key)) tiles.set(key, (async () => {
    const file = path.join(CACHE, `${Z}-${x}-${y}.png`);
    let buf;
    try { buf = await fs.readFile(file); } catch {
      const res = await fetch(TILE_URL(Z, x, y));
      if (!res.ok) throw new Error(`Kachel ${key}: HTTP ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
      await fs.mkdir(CACHE, { recursive: true });
      await fs.writeFile(file, buf);
    }
    return decodePng(buf);
  })());
  return tiles.get(key);
}
const n = 2 ** Z;
const toPixel = (lat, lon) => {
  const s = Math.sin(lat * Math.PI / 180);
  return { px: (lon + 180) / 360 * n * TILE, py: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * TILE };
};
async function pixel(ix, iy) {
  const t = await loadTile(Math.floor(ix / TILE), Math.floor(iy / TILE));
  return t[(iy % TILE) * TILE + (ix % TILE)];
}
/** Bilinear interpolierte Höhe in m ü. M. */
async function elevation(lat, lon) {
  const { px, py } = toPixel(lat, lon);
  const x0 = Math.floor(px - 0.5), y0 = Math.floor(py - 0.5), fx = px - 0.5 - x0, fy = py - 0.5 - y0;
  const [a, b, c, d] = await Promise.all([pixel(x0, y0), pixel(x0 + 1, y0), pixel(x0, y0 + 1), pixel(x0 + 1, y0 + 1)]);
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}
/** Punkt in Entfernung dist (m) und Richtung az (Grad) */
function offset(lat, lon, dist, az) {
  const r = az * Math.PI / 180;
  return [lat + (dist * Math.cos(r)) / 111320, lon + (dist * Math.sin(r)) / (111320 * Math.cos(lat * Math.PI / 180))];
}

/* ---------------------------------------------------------------- Kennwerte */
async function slopeAspect(lat, lon, d = 30) {
  // Horn-Verfahren auf einem 3x3-Gitter mit Abstand d
  const g = {};
  for (const [k, dn, de] of [['a', 1, -1], ['b', 1, 0], ['c', 1, 1], ['d', 0, -1], ['f', 0, 1], ['g', -1, -1], ['h', -1, 0], ['i', -1, 1]]) {
    g[k] = await elevation(lat + (dn * d) / 111320, lon + (de * d) / (111320 * Math.cos(lat * Math.PI / 180)));
  }
  const dzdx = ((g.c + 2 * g.f + g.i) - (g.a + 2 * g.d + g.g)) / (8 * d); // nach Osten
  const dzdy = ((g.a + 2 * g.b + g.c) - (g.g + 2 * g.h + g.i)) / (8 * d); // nach Norden
  const slopeDeg = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
  const aspect = (Math.atan2(-dzdx, -dzdy) * 180 / Math.PI + 360) % 360; // Richtung, in die der Hang abfällt
  return { slopeDeg: Math.round(slopeDeg * 10) / 10, terrainAspect: Math.round(aspect) };
}
async function relief(lat, lon, radius) {
  let lo = Infinity, hi = -Infinity;
  for (let dy = -radius; dy <= radius; dy += 25) for (let dx = -radius; dx <= radius; dx += 25) {
    if (dx * dx + dy * dy > radius * radius) continue;
    const h = await elevation(lat + dy / 111320, lon + dx / (111320 * Math.cos(lat * Math.PI / 180)));
    lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  return Math.round(hi - lo);
}
async function horizon(lat, lon, eye) {
  const out = {};
  for (let az = 0; az < 360; az += HORIZON_STEP) {
    let best = -90;
    for (let d = 60; d <= HORIZON_MAX; d *= 1.06) {
      const [la, lo] = offset(lat, lon, d, az);
      const h = (await elevation(la, lo)) - (d * d) / (2 * R_EARTH) * 0.87; // Erdkrümmung mit Refraktion
      best = Math.max(best, Math.atan2(h - eye, d) * 180 / Math.PI);
    }
    out[az] = Math.round(Math.max(0, best) * 10) / 10;
  }
  return out;
}

/* ---------------------------------------------------------------- Ablauf */
const file = JSON.parse(await fs.readFile(SITES, 'utf8'));
const starts = file.sites.filter(s => s.type === 'start' && Number.isFinite(s.lat) && Number.isFinite(s.lon));
for (const s of starts) {
  const dem = await elevation(s.lat, s.lon);
  const eye = (Number.isFinite(s.alt) ? s.alt : dem) + 2;
  const t = {
    ...(await slopeAspect(s.lat, s.lon)),
    relief250m: await relief(s.lat, s.lon, 250),
    relief500m: await relief(s.lat, s.lon, 500),
    horizonAngles: await horizon(s.lat, s.lon, eye),
    demAlt: Math.round(dem)
  };
  s.terrain = t;
  if (!Number.isFinite(s.alt)) { s.alt = t.demAlt; s.altSource = 'Höhenmodell'; }
  const diff = Number.isFinite(s.alt) ? Math.round(dem - s.alt) : null;
  console.log(`${s.id.padEnd(24)} Neigung ${String(t.slopeDeg).padStart(4)}°  Exp. ${String(t.terrainAspect).padStart(3)}°  Relief ${t.relief500m} m  DEM ${t.demAlt} m${diff !== null && Math.abs(diff) > 120 ? `  ⚠ ${diff > 0 ? '+' : ''}${diff} m zur Platzhöhe` : ''}`);
}
file.meta = { ...file.meta, terrain: { source: 'AWS Terrain Tiles (Terrarium, Zoom 12)', built: new Date().toISOString().slice(0, 10) } };
await fs.writeFile(SITES, JSON.stringify(file, null, 1) + '\n');
console.log(`\n${starts.length} Startplätze aktualisiert.`);
