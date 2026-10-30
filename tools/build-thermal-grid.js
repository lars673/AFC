#!/usr/bin/env node
// Berechnet einmalig das Geländeraster für die Thermik-Wärmekarte und schreibt lib/terrain-grid.bin.
// Nur nötig, wenn das Gebiet oder die Maschenweite ändert.
//
//   node tools/build-thermal-grid.js
//
// Je Zelle (ca. 250 m): Höhe, Hangneigung, Exposition (wohin der Hang schaut) und Geländeform
// (Krete/Kuppe positiv, Mulde/Tal negativ). Höhenmodell: AWS Terrain Tiles Zoom 11 (ca. 52 m).
//
// Dateiformat: u32 LE Länge der Kopfzeile, Kopfzeile als JSON { la0, lo0, dla, dlo, ny, nx, ... },
// auf 2 Byte aufgefüllt, dann zeilenweise von Süden nach Norden, je Zeile von Westen nach Osten:
// Höhe u16 LE (m), Neigung u8 (Grad), Exposition u8 (x 360/256 Grad), Geländeform i8 (x 2 m).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDem } from './dem.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'lib', 'terrain-grid.bin');
// gleiches Gebiet wie das Windraster (lib/windgrid.js)
const G = { la0: 46.22, lo0: 6.98, dla: 0.00225, dlo: 0.0033 };
G.ny = Math.round(0.72 / G.dla) + 1;
G.nx = Math.round(1.54 / G.dlo) + 1;
const FORM_R = 2;   // Zellen: Geländeform = Höhe minus Mittel im Umkreis von ca. 500 m

const { elevation } = createDem(11);
const N = G.ny * G.nx, elev = new Float32Array(N);
console.log(`Raster ${G.nx} x ${G.ny} = ${N} Zellen, lade Höhenmodell …`);
for (let y = 0; y < G.ny; y++) {
  const row = [];
  for (let x = 0; x < G.nx; x++) row.push(elevation(G.la0 + y * G.dla, G.lo0 + x * G.dlo));
  const v = await Promise.all(row);
  for (let x = 0; x < G.nx; x++) elev[y * G.nx + x] = v[x];
  if (y % 40 === 0) console.log(`  Zeile ${y}/${G.ny}`);
}

const at = (x, y) => elev[Math.max(0, Math.min(G.ny - 1, y)) * G.nx + Math.max(0, Math.min(G.nx - 1, x))];
const slope = new Uint8Array(N), aspect = new Uint8Array(N), form = new Int8Array(N);
const dy = G.dla * 111320;
for (let y = 0; y < G.ny; y++) {
  const dx = G.dlo * 111320 * Math.cos((G.la0 + y * G.dla) * Math.PI / 180);
  for (let x = 0; x < G.nx; x++) {
    // Horn-Verfahren (y wächst nach Norden)
    const a = at(x - 1, y + 1), b = at(x, y + 1), c = at(x + 1, y + 1), d = at(x - 1, y), f = at(x + 1, y), g = at(x - 1, y - 1), h = at(x, y - 1), i = at(x + 1, y - 1);
    const dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * dx);
    const dzdy = ((a + 2 * b + c) - (g + 2 * h + i)) / (8 * dy);
    const k = y * G.nx + x;
    slope[k] = Math.round(Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI);
    aspect[k] = Math.round(((Math.atan2(-dzdx, -dzdy) * 180 / Math.PI + 360) % 360) * 256 / 360) & 255;
    let sum = 0, n = 0;
    for (let yy = -FORM_R; yy <= FORM_R; yy++) for (let xx = -FORM_R; xx <= FORM_R; xx++) { sum += at(x + xx, y + yy); n++; }
    form[k] = Math.max(-127, Math.min(127, Math.round((elev[k] - sum / n) / 2)));
  }
}

const head = Buffer.from(JSON.stringify({ ...G, source: 'AWS Terrain Tiles (Terrarium, Zoom 11)', built: new Date().toISOString().slice(0, 10) }));
const pad = (4 + head.length) % 2;
const buf = Buffer.alloc(4 + head.length + pad + N * 5);
buf.writeUInt32LE(head.length, 0); head.copy(buf, 4);
let o = 4 + head.length + pad;
for (let k = 0; k < N; k++, o += 2) buf.writeUInt16LE(Math.max(0, Math.round(elev[k])), o);
Buffer.from(slope.buffer).copy(buf, o); o += N;
Buffer.from(aspect.buffer).copy(buf, o); o += N;
Buffer.from(form.buffer).copy(buf, o);
await fs.writeFile(OUT, buf);
console.log(`Geschrieben: ${path.relative(ROOT, OUT)} (${Math.round(buf.length / 1024)} kB)`);
