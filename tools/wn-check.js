#!/usr/bin/env node
// Prüft WindNinja an den Messstationen: Hätte der Geländewind die Prognose an der Station näher an die Messung gebracht?
//
//   node tools/wn-check.js <afc.sqlite oder Sicherung> [--days 60]
//
// Nimmt die gespeicherten Stationsprognosen (fc_pred: Wind und Richtung je Stunde) und die Messungen (observations)
// derselben Stunde, rechnet den WindNinja-Faktor an der Lage der Station dazu und vergleicht den mittleren Fehler
// vorher und nachher, je Station und gesamt (nur 8 bis 18 Uhr). Liest nur, ändert nichts.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as WN from '../lib/wn.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2];
const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
if (!file) { console.error('Aufruf: node tools/wn-check.js <afc.sqlite> [--days 60]'); process.exit(1); }
const meta = WN.load(ROOT)?.meta;
if (!meta) { console.error('Kein WindNinja-Feld (wn/wind.bin) gefunden.'); process.exit(1); }

// Stationsliste mit Koordinaten von MeteoSchweiz
const txt = await (await fetch('https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ogd-smn_meta_stations.csv')).text();
const lines = txt.split(/\r?\n/).filter(Boolean), h = lines[0].split(';');
const ci = h.indexOf('station_abbr'), ni = h.indexOf('station_name'), lai = h.indexOf('station_coordinates_wgs84_lat'), loi = h.indexOf('station_coordinates_wgs84_lon'), hi = h.indexOf('station_height_masl');
const ST = {};
for (const l of lines.slice(1)) { const r = l.split(';'); ST[r[ci]] = { name: r[ni], lat: +r[lai], lon: +r[loi], alt: +r[hi] }; }

const db = new DatabaseSync(file, { readOnly: true });
const since = new Date(Date.now() - Number(arg('days') || 60) * 86400000).toISOString();
const rows = db.prepare(`SELECT f.code, f.target, f.wind AS fw, f.dir AS fd, o.wind AS ow, o.dir AS od
  FROM fc_pred f JOIN observations o ON o.code = f.code AND substr(o.time, 1, 13) = substr(f.target, 1, 13) AND substr(o.time, 15, 2) = '00'
  WHERE f.target >= ? AND f.wind IS NOT NULL AND o.wind IS NOT NULL`).all(since);

const foam = meta.foam || [];
const inFoam = s => foam.some(b => s.lat >= b[0] && s.lat <= b[2] && s.lon >= b[1] && s.lon <= b[3]);
const hourCH = t => Number(new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', hour12: false }).format(new Date(t)));
const dd = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const per = {};
for (const r of rows) {
  const s = ST[r.code]; if (!s) continue;
  const hr = hourCH(r.target); if (hr < 8 || hr > 18) continue;
  const w = WN.at(ROOT, s.lat, s.lon, r.fd); if (!w) continue;
  const p = per[r.code] ??= { name: s.name, alt: s.alt, foam: inFoam(s), n: 0, e0: 0, e1: 0, b0: 0, b1: 0, d0: 0, d1: 0, nd: 0, f: 0 };
  // wie lib/plan.js: Faktor gegenüber der Modellmasche, im Lee nichts ändern
  const lee = w.rel < 0.6 || Math.abs(w.dev) > 60, fx = lee ? 1 : Math.min(1.6, Math.max(0.6, w.rel));
  const after = r.fw * fx, dirA = lee ? r.fd : (r.fd + w.dev + 360) % 360;
  p.n++; p.e0 += Math.abs(r.fw - r.ow); p.e1 += Math.abs(after - r.ow); p.b0 += r.fw - r.ow; p.b1 += after - r.ow; p.f += fx;
  if (r.ow >= 5 && Number.isFinite(r.od) && Number.isFinite(r.fd)) { p.nd++; p.d0 += dd(r.fd, r.od); p.d1 += dd(dirA, r.od); }
}
const list = Object.entries(per).filter(([, p]) => p.n >= 10).sort((a, b) => b[1].n - a[1].n);
if (!list.length) { console.log('Keine passenden Stunden im Gebiet gefunden.'); process.exit(0); }
const f1 = v => v.toFixed(1);
console.log(`WindNinja-Feld: ${meta.src}`);
console.log(`Zeitraum ab ${since.slice(0, 10)}, 8 bis 18 Uhr. Fehler = mittlere Abweichung Prognose minus Messung (km/h), Richtung bei Wind ab 5 km/h.\n`);
console.log('Station'.padEnd(28) + 'Std'.padStart(5) + 'Faktor'.padStart(8) + '  Fehler vorher → nachher'.padEnd(28) + 'Schnitt vorher → nachher'.padEnd(27) + 'Richtung vorher → nachher');
const tot = { a: { n: 0, e0: 0, e1: 0, nd: 0, d0: 0, d1: 0 }, f: { n: 0, e0: 0, e1: 0, nd: 0, d0: 0, d1: 0 } };
for (const [code, p] of list) {
  const t = p.foam ? tot.f : tot.a; t.n += p.n; t.e0 += p.e0; t.e1 += p.e1; t.nd += p.nd; t.d0 += p.d0; t.d1 += p.d1;
  console.log(`${(p.name + ' (' + code + (p.foam ? ', OpenFOAM' : '') + ')').slice(0, 27).padEnd(28)}${String(p.n).padStart(5)}${f1(p.f / p.n).padStart(8)}  ${(f1(p.e0 / p.n) + ' → ' + f1(p.e1 / p.n)).padEnd(26)}${(f1(p.b0 / p.n) + ' → ' + f1(p.b1 / p.n)).padEnd(27)}${p.nd ? Math.round(p.d0 / p.nd) + '° → ' + Math.round(p.d1 / p.nd) + '°' : '–'}`);
}
for (const [k, t] of Object.entries(tot)) if (t.n) console.log(`\n${k === 'f' ? 'Mit OpenFOAM' : 'Nur WindNinja einfach'}: ${t.n} Stunden, Fehler ${f1(t.e0 / t.n)} → ${f1(t.e1 / t.n)} km/h (${Math.round((1 - t.e1 / t.e0) * 100)} % besser)${t.nd ? `, Richtung ${Math.round(t.d0 / t.nd)}° → ${Math.round(t.d1 / t.nd)}°` : ''}`);
