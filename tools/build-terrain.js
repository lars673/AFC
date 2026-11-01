#!/usr/bin/env node
// Berechnet einmalig die Geländedaten der Startplätze (Hangneigung, Exposition, Relief, Horizont)
// und schreibt sie als `terrain` in lib/sites.json. Nur bei neuen/geänderten Startplätzen nötig.
//
//   node tools/build-terrain.js
//
// Höhenmodell: AWS Terrain Tiles (Terrarium-PNG, Zoom 12, ca. 26 m Raster in der Schweiz), siehe tools/dem.js.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDem } from './dem.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITES = path.join(ROOT, 'lib', 'sites.json');
const R_EARTH = 6371000;
const HORIZON_STEP = 15;      // Grad zwischen den Horizont-Richtungen
const HORIZON_MAX = 20000;    // m, so weit wird nach Bergschatten gesucht

const { elevation } = createDem(12);

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
