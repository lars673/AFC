// Höhenmodell aus AWS Terrain Tiles (Terrarium-PNG). Ohne Abhängigkeiten: PNG wird mit zlib dekodiert,
// Kacheln werden in .cache/terrain zwischengespeichert. Nur für die Werkzeuge in tools/.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CACHE = path.join(ROOT, '.cache', 'terrain');
const TILE = 256;
const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

/* ---------------------------------------------------------------- PNG (ohne Interlace) */
/** Dekodiert ein PNG zu RGBA (8 bit je Kanal). Unterstützt Graustufen, RGB, Palette (mit Transparenz) und RGBA. */
export function decodePngRgba(buf) {
  let pos = 8, width = 0, height = 0, depth = 8, ctype = 2, palette = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; ctype = data[9];
      if (data[12] !== 0) throw new Error('PNG mit Interlace nicht unterstützt');
      if (depth === 16 || (depth < 8 && ctype !== 3 && ctype !== 0)) throw new Error('PNG-Bittiefe nicht unterstützt: ' + depth);
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!channels) throw new Error('PNG-Farbtyp nicht unterstützt: ' + ctype);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = Math.ceil(width * channels * depth / 8), bpp = Math.max(1, channels * depth / 8), out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = y > 0 ? out[dst - stride + i] : 0;
      const c = y > 0 && i >= bpp ? out[dst - stride + i - bpp] : 0;
      let v;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[dst + i] = v & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  const sample = (row, k) => (depth === 8 ? out[row + k] : (out[row + ((k * depth) >> 3)] >> (8 - depth - ((k * depth) & 7))) & ((1 << depth) - 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const row = y * stride, o = (y * width + x) * 4;
    if (ctype === 3) {
      const idx = sample(row, x);
      rgba[o] = palette[idx * 3]; rgba[o + 1] = palette[idx * 3 + 1]; rgba[o + 2] = palette[idx * 3 + 2];
      rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
    } else if (ctype === 0 || ctype === 4) {
      const g = depth === 8 ? out[row + x * channels] : sample(row, x) * (255 / ((1 << depth) - 1));
      rgba[o] = rgba[o + 1] = rgba[o + 2] = g; rgba[o + 3] = ctype === 4 ? out[row + x * 2 + 1] : 255;
    } else {
      const i = row + x * channels;
      rgba[o] = out[i]; rgba[o + 1] = out[i + 1]; rgba[o + 2] = out[i + 2]; rgba[o + 3] = ctype === 6 ? out[i + 3] : 255;
    }
  }
  return { width, height, rgba };
}

/** Terrarium-Kachel zu Höhen in m. */
export function decodePng(buf) {
  const { width, height, rgba } = decodePngRgba(buf);
  const elev = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) elev[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
  return elev;
}

/* ---------------------------------------------------------------- Höhenmodell */
/** Höhenmodell auf Zoomstufe Z (12: ca. 26 m, 11: ca. 52 m Raster in der Schweiz). */
export function createDem(Z = 12, CACHE = DEFAULT_CACHE) {
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
  return { elevation, Z };
}
