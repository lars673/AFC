#!/usr/bin/env node
// Schreibt lib/pano.json: die Bergsilhouette je Startplatz für das Startbild (siehe lib/pano.js).
// Nötig, wenn Startplätze dazukommen oder das Geländeraster ändert:   node tools/build-pano.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGrid, buildPanos } from '../lib/pano.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const g = readGrid(fs.readFileSync(path.join(ROOT, 'lib', 'terrain-grid.bin')));
const { sites } = JSON.parse(fs.readFileSync(path.join(ROOT, 'lib', 'sites.json'), 'utf8'));
const p = buildPanos(g, sites);
fs.writeFileSync(path.join(ROOT, 'lib', 'pano.json'), JSON.stringify(p));
console.log(`Panorama für ${Object.keys(p.sites).length} Startplätze geschrieben.`);
