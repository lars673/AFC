#!/usr/bin/env node
// Eichung der eigenen Thermikkarte mit echten Steigen: Wie oft kreisen Piloten (OGN, Tabelle ogn_spot) über welchem Boden,
// verglichen mit seinem Flächenanteil im Geländeraster? Ergibt je Bodenart einen beobachteten Faktor neben dem angenommenen
// (lib/landcover.js). Erst aussagekräftig mit einigen hundert Steigen über mehrere Flugtage.
//
//   node tools/calibrate-own.js [data/afc.sqlite]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = process.argv[2] || path.join(ROOT, 'data/afc.sqlite');
const lb = readFileSync(path.join(ROOT, 'lib/landcover-grid.bin')), ll = lb.readUInt32LE(0), m = JSON.parse(lb.subarray(4, 4 + ll)), land = lb.subarray(4 + ll);
const bin = f => (f <= 30 ? 'Wasser/Gletscher' : f <= 85 ? 'Wald' : f < 98 ? 'Gebüsch/Mischwald' : f <= 104 ? 'Wiese/Siedlung' : f < 115 ? 'Mischung Fels' : 'Fels/Geröll');
const area = {}, hits = {};
for (const f of land) if (f) area[bin(f)] = (area[bin(f)] || 0) + 1;
const db = new DatabaseSync(dbFile, { readOnly: true });
const rows = db.prepare('SELECT lat, lon, climb, n FROM ogn_spot').all();
for (const r of rows) {
  const x = Math.round((r.lon - m.lo0) / m.dlo), y = Math.round((r.lat - m.la0) / m.dla);
  if (x < 0 || y < 0 || x >= m.nx || y >= m.ny) continue;
  const f = land[y * m.nx + x];
  if (f) hits[bin(f)] = (hits[bin(f)] || 0) + 1;
}
const nA = Object.values(area).reduce((a, b) => a + b, 0), nH = Object.values(hits).reduce((a, b) => a + b, 0);
console.log(`${rows.length} Steigen (${nH} im Raster), Tage: ${db.prepare('SELECT COUNT(DISTINCT date) AS d FROM ogn_spot').get().d}`);
for (const k of Object.keys(area).sort()) {
  const share = area[k] / nA, obs = nH ? (hits[k] || 0) / nH : 0;
  console.log(`${k.padEnd(20)} Fläche ${(share * 100).toFixed(1).padStart(5)} %  Steigen ${(obs * 100).toFixed(1).padStart(5)} %  Verhältnis ${share ? (obs / share).toFixed(2) : '–'}`);
}
console.log('Hinweis: Startplätze ziehen Steigen an (Piloten sind dort); Verhältnis nur zwischen ähnlichen Höhen vergleichen.');
