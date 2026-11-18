import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePoints, nearestPoint, makeParamParser, patchSeries, msTime } from '../lib/msfc.js';

const META = `point_id;point_type_id;station_abbr;postal_code;point_name;point_type_de;point_type_fr;point_type_it;point_type_en;point_height_masl;point_coordinates_lv95_east;point_coordinates_lv95_north;point_coordinates_wgs84_lat;point_coordinates_wgs84_lon
53;1;INT;;Interlaken;Station;Station;Stazione;Station;578.0;2633043.0;1169070.0;46.672033;7.87045
1025;3;;;Niederhorn;Point of Interest;Point of Interest;Point of Interest;Point of Interest;1963.0;2625855.0;1173440.0;46.711661;7.776764
33;1;JUN;;Jungfraujoch;Station;Station;Stazione;Station;3571.0;2641939.0;1155287.0;46.547556;7.985444`;

test('MeteoSchweiz: Punkte lesen und den passenden Punkt nach Distanz und Höhe wählen', () => {
  const pts = parsePoints(META);
  assert.equal(pts.length, 3);
  assert.equal(nearestPoint(pts, { lat: 46.7106, lon: 7.7745, alt: 1950 }).name, 'Niederhorn');
  // Landeplatz im Tal: Interlaken, nicht der nähere Berg
  assert.equal(nearestPoint(pts, { lat: 46.69, lon: 7.85, alt: 570 }).name, 'Interlaken');
  // zu weit weg oder Höhe passt nirgends: kein Punkt, der alte Wert bleibt
  assert.equal(nearestPoint(pts, { lat: 46.0, lon: 10.5, alt: 1000 }), null);
  assert.equal(nearestPoint(pts, { lat: 46.66, lon: 7.9, alt: 2600 }), null);
});

test('MeteoSchweiz: Datei in Stücken lesen, nur gesuchte Punkte, Zeit in UTC', () => {
  const p = makeParamParser(new Set(['1025']));
  p.push('point_id;point_type_id;Date;fu3010h0\n53;1;202611181500;5.0\n1025;3;2026111815');
  p.push('00;29.7\n1025;3;202611181600;\n1025;3;202611181700;31.2');
  const m = p.end();
  assert.equal(m.size, 1);
  assert.equal(m.get('1025').get(msTime('202611181500')), 29.7);
  assert.equal(m.get('1025').has(msTime('202611181600')), false, 'leerer Wert zählt nicht');
  assert.equal(m.get('1025').get(Date.UTC(2026, 10, 18, 17)), 31.2);
});

test('MeteoSchweiz: nur kommende Stunden ersetzen, Wolken in Prozent', () => {
  const h0 = Date.UTC(2026, 10, 18, 15), t = [0, 1, 2].map(i => h0 + i * 3600000);
  const series = { t, wind_speed_10m: [1, 1, 1], wind_gusts_10m: [2, 2, 2], cloud_cover: [0, 0, 0], cape: [5, 5, 5] };
  const M = o => new Map(Object.entries(o).map(([k, v]) => [t[k], v]));
  const vals = { fu3010h0: M({ 0: 20, 1: 25, 2: 30 }), fu3010h1: M({ 1: 50 }), nprolohs: M({ 1: 0.5 }), npromths: M({ 1: 0.5 }), nprohihs: M({ 1: 0 }) };
  const n = patchSeries(series, vals, t[1]);
  assert.equal(n, 2);
  assert.deepEqual(series.wind_speed_10m, [1, 25, 30], 'vergangene Stunde bleibt');
  assert.deepEqual(series.wind_gusts_10m, [2, 50, 2], 'fehlender Wert: alter bleibt');
  assert.equal(series.cloud_cover_low[1], 50);
  assert.equal(series.cloud_cover[1], 75);
  assert.deepEqual(series.cape, [5, 5, 5], 'Labilität bleibt aus Open-Meteo');
});
