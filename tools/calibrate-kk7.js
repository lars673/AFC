#!/usr/bin/env node
// Gleicht die Thermik-Wärmekarte mit echten Flügen ab: kk7 (thermal.kk7.ch) wertet rund 3,8 Mio. Flüge
// aus XContest, DHV-XC, Leonardo u. a. aus und zeigt, wo Piloten tatsächlich Thermik gefunden haben.
// Das Werkzeug vergleicht unser Geländemodell für einen sonnigen Sommertag mit dieser Karte und sucht
// die Gewichtung (Geländeform, Hangneigung, Sonne, Thermikhöhe), die am besten zu den Flügen passt.
//
//   node tools/calibrate-kk7.js            (Kacheln werden in .cache/kk7 zwischengespeichert)
//
// Läuft auf dem Mac (thermal.kk7.ch ist aus der Cloud nicht erreichbar). Ergebnis: data/kk7-abgleich.txt
// kk7-Daten: CC BY-NC-SA 4.0, nur für nicht-kommerzielle Nutzung.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePngRgba } from './dem.js';
import { solarPosition } from '../lib/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'kk7');
const OUT_DIR = process.env.AFC_DATA_DIR || path.join(ROOT, 'data');
const LAYER = process.argv.includes('--layer') ? process.argv[process.argv.indexOf('--layer') + 1] : 'thermals_all_all';
const Z = 11, TILE = 256;
const D2R = Math.PI / 180;

/* ---------------------------------------------------------------- Geländeraster */
const buf = await fs.readFile(path.join(ROOT, 'lib', 'terrain-grid.bin'));
const hl = buf.readUInt32LE(0), G = JSON.parse(buf.subarray(4, 4 + hl)), o = 4 + hl + ((4 + hl) % 2), N = G.ny * G.nx;
const elev = new Float32Array(N), slope = new Float32Array(N), aspect = new Float32Array(N), form = new Float32Array(N);
for (let k = 0; k < N; k++) {
  elev[k] = buf.readUInt16LE(o + 2 * k); slope[k] = buf[o + 2 * N + k]; aspect[k] = buf[o + 3 * N + k] * 360 / 256; form[k] = buf.readInt8(o + 4 * N + k) * 2;
}

/* ---------------------------------------------------------------- kk7-Kacheln (TMS) */
const n = 2 ** Z;
const toPixel = (lat, lon) => {
  const s = Math.sin(lat * D2R);
  return { px: (lon + 180) / 360 * n * TILE, py: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * TILE };
};
const tiles = new Map();
async function tile(x, y) {
  const key = `${x}/${y}`;
  if (!tiles.has(key)) {
    const file = path.join(CACHE, LAYER, `${Z}-${x}-${y}.png`);
    let b = null;
    try { b = await fs.readFile(file); } catch {
      const url = `https://thermal.kk7.ch/tiles/${LAYER}/${Z}/${x}/${n - 1 - y}.png?src=afc-kalibrierung`;
      const res = await fetch(url);
      if (res.status === 404) b = Buffer.alloc(0);
      else if (!res.ok) throw new Error(`kk7 ${key}: HTTP ${res.status}`);
      else b = Buffer.from(await res.arrayBuffer());
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, b);
      await new Promise(r => setTimeout(r, 150));   // schonend: eine Kachel nach der anderen
    }
    tiles.set(key, b.length ? decodePngRgba(b) : null);
  }
  return tiles.get(key);
}
const colours = new Map();
async function kk7At(lat, lon) {
  // Mittel über ca. 250 m (5 x 5 Pixel bei Zoom 11)
  const { px, py } = toPixel(lat, lon);
  let sa = 0, sc = 0, m = 0;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const ix = Math.floor(px) + dx, iy = Math.floor(py) + dy;
    const t = await tile(Math.floor(ix / TILE), Math.floor(iy / TILE));
    m++;
    if (!t) continue;
    const i = ((iy % TILE) * TILE + (ix % TILE)) * 4, r = t.rgba[i], g = t.rgba[i + 1], b = t.rgba[i + 2], a = t.rgba[i + 3];
    if (a > 0) { const key = `${r >> 4},${g >> 4},${b >> 4},${a >> 4}`; colours.set(key, (colours.get(key) || 0) + 1); }
    sa += a / 255;
    sc += (a / 255) * (0.5 + (r - g) / 510);           // Gelb -> Rot = stärker (falls die Farbe die Stärke trägt)
  }
  return [sa / m, sc / m];
}

console.log(`Lade kk7 «${LAYER}» für ${G.nx} x ${G.ny} Rasterzellen …`);
const kA = new Float32Array(N), kC = new Float32Array(N);
for (let y = 0; y < G.ny; y++) {
  for (let x = 0; x < G.nx; x++) { const k = y * G.nx + x; [kA[k], kC[k]] = await kk7At(G.la0 + y * G.dla, G.lo0 + x * G.dlo); }
  if (y % 80 === 0) console.log(`  Zeile ${y}/${G.ny} (${tiles.size} Kacheln)`);
}

/* ---------------------------------------------------------------- Sonne: sonniger Sommertag 10–16 Uhr */
const HOURS = [10, 11, 12, 13, 14, 15, 16];
const sunR = new Float32Array(N), sunS = new Float32Array(N);
const lat0 = G.la0 + G.ny * G.dla / 2, lon0 = G.lo0 + G.nx * G.dlo / 2;
for (const h of HOURS) {
  const pos = solarPosition(Date.UTC(2026, 6, 15, h - 2), lat0, lon0);   // Sommerzeit: UTC+2
  const e = pos.elevationDeg * D2R, sw = 950 * Math.sin(e);
  for (let k = 0; k < N; k++) {
    const s = slope[k] * D2R;
    const cosi = Math.cos(s) * Math.sin(e) + Math.sin(s) * Math.cos(e) * Math.cos((pos.azimuthDeg - aspect[k]) * D2R);
    sunR[k] += sw * Math.min(3, Math.max(0, cosi) / Math.max(Math.sin(e), 0.15)) / HOURS.length;
    sunS[k] += sw / HOURS.length;
  }
}

/* ---------------------------------------------------------------- Modell mit Parametern (wie app.js thermalCell) */
const BASE = { diffuse: 0.25, formBase: 0.55, formScale: 100, slopeFloor: 0.45, slopeFull: 25, flat: 0.15, top: 3200 };
function model(p, k) {
  const heat = p.diffuse * sunS[k] + (1 - p.diffuse) * sunR[k];
  const fReach = Math.min(1, Math.max(0, (p.top - elev[k] - 100) / 900));
  const fForm = Math.min(1.3, Math.max(0.25, p.formBase + form[k] / p.formScale));
  const fSlope = slope[k] < 2 ? p.flat : p.slopeFloor + (1 - p.slopeFloor) * Math.min(1, slope[k] / p.slopeFull);
  return heat * fReach * fForm * fSlope;
}

// Nur dort vergleichen, wo überhaupt geflogen wird: kk7-Signal im Umkreis von ca. 2 km
const R = 8, covered = [];
for (let y = 0; y < G.ny; y += 2) for (let x = 0; x < G.nx; x += 2) {
  let any = false;
  for (let yy = Math.max(0, y - R); yy <= Math.min(G.ny - 1, y + R) && !any; yy += 2) for (let xx = Math.max(0, x - R); xx <= Math.min(G.nx - 1, x + R); xx += 2) if (kA[yy * G.nx + xx] > 0.02) { any = true; break; }
  if (any) covered.push(y * G.nx + x);
}
if (covered.length < 500) { console.error(`Zu wenig kk7-Daten im Gebiet (${covered.length} Zellen). Stimmt die Ebene «${LAYER}»?`); process.exit(1); }

const ranks = vals => { const idx = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]); const r = new Float64Array(vals.length); idx.forEach((i, j) => (r[i] = j)); return r; };
function spearman(a, b) {
  const ra = ranks(a), rb = ranks(b), m = a.length, mean = (m - 1) / 2;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < m; i++) { const da = ra[i] - mean, db = rb[i] - mean; sab += da * db; saa += da * da; sbb += db * db; }
  return sab / Math.sqrt(saa * sbb);
}
const truthSets = { alpha: covered.map(k => kA[k]), colour: covered.map(k => kC[k]) };
const truthName = spearman(truthSets.alpha, truthSets.colour) > 0.98 ? 'alpha' : 'colour';
const truth = truthSets[truthName];
const topCut = [...truth].sort((a, b) => b - a)[Math.floor(truth.length * 0.1)];
function evaluate(p) {
  const pred = covered.map(k => model(p, k));
  const rho = spearman(pred, truth);
  // Treffer: von den 10 % stärksten kk7-Zellen, wie viele liegen in unseren besten 20 %?
  const cut = [...pred].sort((a, b) => b - a)[Math.floor(pred.length * 0.2)];
  let hit = 0, tot = 0;
  for (let i = 0; i < pred.length; i++) if (truth[i] >= topCut && truth[i] > 0) { tot++; if (pred[i] >= cut) hit++; }
  return { rho, hit: tot ? hit / tot : 0 };
}

const base = evaluate(BASE);
console.log(`Ausgangsmodell: Rangkorrelation ${base.rho.toFixed(3)}, Treffer ${(base.hit * 100).toFixed(0)} %`);
const RANGES = { diffuse: [0.1, 0.6], formBase: [0.3, 0.8], formScale: [40, 250], slopeFloor: [0.1, 0.9], slopeFull: [10, 40], flat: [0.05, 0.6], top: [2400, 4000] };
let best = { p: BASE, ...base };
const rnd = (a, b) => a + Math.random() * (b - a);
for (let it = 0; it < 500; it++) {
  // Zufallssuche, später immer näher am bisher besten Satz
  const near = it > 150, p = {};
  for (const [k, [a, b]] of Object.entries(RANGES)) p[k] = near ? Math.min(b, Math.max(a, best.p[k] + (Math.random() - 0.5) * (b - a) * 0.25)) : rnd(a, b);
  const r = evaluate(p);
  if (r.rho > best.rho) best = { p, ...r };
  if (it % 100 === 99) console.log(`  ${it + 1} Versuche, beste Rangkorrelation ${best.rho.toFixed(3)}`);
}
// Einzelwirkung: jeden Parameter auf den Ausgangswert zurücksetzen
const effect = Object.keys(RANGES).map(k => ({ k, drop: best.rho - evaluate({ ...best.p, [k]: BASE[k] }).rho })).sort((a, b) => b.drop - a.drop);

const colourTop = [...colours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c, nn]) => `${c}:${nn}`).join(' ');
const fmt = p => Object.entries(p).map(([k, v]) => `${k}=${Math.round(v * 100) / 100}`).join(', ');
const report = [
  `AFC-Abgleich der Thermik-Wärmekarte mit kk7 (${LAYER}), ${new Date().toISOString().slice(0, 10)}`,
  '',
  `Verglichene Rasterzellen (250 m, dort wo geflogen wird): ${covered.length}`,
  `kk7-Stärke gemessen über: ${truthName === 'alpha' ? 'Deckkraft' : 'Farbe und Deckkraft'}`,
  '',
  `Ausgangsmodell:  Rangkorrelation ${base.rho.toFixed(3)} · Treffer ${(base.hit * 100).toFixed(0)} %`,
  `Bestes Modell:   Rangkorrelation ${best.rho.toFixed(3)} · Treffer ${(best.hit * 100).toFixed(0)} %`,
  '(Rangkorrelation 1 = gleiche Reihenfolge wie die Flüge, 0 = kein Zusammenhang.',
  ' Treffer = Anteil der 10 % stärksten kk7-Thermikstellen, die auch bei uns unter den besten 20 % sind.)',
  '',
  `Ausgang: ${fmt(BASE)}`,
  `Bestes:  ${fmt(best.p)}`,
  '',
  'Wirkung je Parameter (Verlust, wenn auf Ausgang zurückgesetzt):',
  ...effect.map(e => `  ${e.k.padEnd(11)} ${e.drop.toFixed(3)}`),
  '',
  `Kacheln: ${tiles.size}, mit Daten: ${[...tiles.values()].filter(Boolean).length}`,
  `Häufigste Farben (r,g,b,a je /16): ${colourTop}`,
  '',
  'Datenquelle: thermal.kk7.ch, CC BY-NC-SA 4.0'
].join('\n');
await fs.mkdir(OUT_DIR, { recursive: true });
await fs.writeFile(path.join(OUT_DIR, 'kk7-abgleich.txt'), report + '\n');
await fs.writeFile(path.join(OUT_DIR, 'kk7-abgleich.json'), JSON.stringify({ layer: LAYER, covered: covered.length, truthName, base: { p: BASE, ...base }, best, effect }, null, 1));
console.log('\n' + report + `\n\nGespeichert: ${path.join(OUT_DIR, 'kk7-abgleich.txt')}`);
