#!/usr/bin/env node
// Bodenbedeckung für die eigene Thermikkarte: BFS Arealstatistik (100-m-Stichprobenpunkte, Bodenbedeckung LC_27,
// «Quelle: BFS, Arealstatistik») auf das Geländeraster (lib/terrain-grid.bin) gemittelt.
// Ergebnis lib/landcover-grid.bin: 4 Byte Länge + JSON-Kopf + je Rasterzelle 1 Byte Thermikfaktor × 100 (0 = keine Daten).
//
//   curl -O https://data.geo.admin.ch/ch.bfs.arealstatistik/arealstatistik/arealstatistik_2056.csv.zip && unzip arealstatistik_2056.csv.zip
//   node tools/landcover.js arealstatistik_2056.csv
import { readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGrid } from '../lib/pano.js';
import { LC_FACTOR, lv95ToWgs } from '../lib/landcover.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src) { console.error('Aufruf: node tools/landcover.js arealstatistik_2056.csv'); process.exit(1); }
const g = readGrid(readFileSync(path.join(ROOT, 'lib/terrain-grid.bin')));
const N = g.nx * g.ny, sum = new Float64Array(N), cnt = new Uint16Array(N), seen = {};
let head = null, rows = 0;
for await (const line of createInterface({ input: createReadStream(src), crlfDelay: Infinity })) {
  const v = line.split(';');
  if (!head) { head = Object.fromEntries(v.map((k, i) => [k, i])); continue; }
  const e = +v[head.E_COORD], n = +v[head.N_COORD], lc = +v[head.LC_27];
  const [lat, lon] = lv95ToWgs(e, n);
  const x = Math.round((lon - g.lo0) / g.dlo), y = Math.round((lat - g.la0) / g.dla);
  if (x < 0 || y < 0 || x >= g.nx || y >= g.ny) continue;
  const f = LC_FACTOR[lc];
  if (f == null) continue;
  const k = y * g.nx + x; sum[k] += f; cnt[k]++; seen[lc] = (seen[lc] || 0) + 1; rows++;
}
const out = new Uint8Array(N);
let filled = 0;
for (let k = 0; k < N; k++) if (cnt[k]) { out[k] = Math.max(1, Math.min(255, Math.round(sum[k] / cnt[k] * 100))); filled++; }
const meta = Buffer.from(JSON.stringify({ nx: g.nx, ny: g.ny, la0: g.la0, lo0: g.lo0, dla: g.dla, dlo: g.dlo, scale: 100, source: 'BFS Arealstatistik (LC_27), Quelle: BFS', built: new Date().toISOString().slice(0, 10) }));
const len = Buffer.alloc(4); len.writeUInt32LE(meta.length);
writeFileSync(path.join(ROOT, 'lib/landcover-grid.bin'), Buffer.concat([len, meta, Buffer.from(out)]));
console.log(`${rows} Punkte, ${filled} von ${N} Zellen mit Daten`, seen);
