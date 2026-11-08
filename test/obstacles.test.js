import test from 'node:test';
import assert from 'node:assert/strict';
import { parseObstacleKml, parseObstacleKmz, zipHas } from '../lib/obstacles.js';
import { makeZip } from './mock-upstream.js';

// Aufbau wie die echte BAZL-Datei (Stand November 2026): jedes Tag mit «kml:», leere Felder als <kml:SimpleData name="airport"/>,
// jede Spannweite einer Leitung als eigenes Placemark (…_0001, …_0002) und die Masten zusätzlich als Punkte.
const pm = (id, type, h, geom) => `<kml:Placemark id="x-${id}"><kml:name>${id}</kml:name><kml:styleUrl>#ms</kml:styleUrl>
<kml:ExtendedData><kml:SchemaData schemaUrl="#obstaclePropertyId"><kml:SimpleData name="uuid">u-${id}</kml:SimpleData><kml:SimpleData name="airport"/>
<kml:SimpleData name="obstacleType">${type}</kml:SimpleData><kml:SimpleData name="maxHeightAGL">${h}</kml:SimpleData><kml:SimpleData name="topElevationAMSL">1400</kml:SimpleData>
<kml:SimpleData name="marking">ORANGE_MARKS</kml:SimpleData><kml:SimpleData name="lighting">NONE</kml:SimpleData><kml:SimpleData name="radius"/></kml:SchemaData></kml:ExtendedData>${geom}</kml:Placemark>`;
const line = (a, b) => `<kml:MultiGeometry><kml:LineString><kml:altitudeMode>absolute</kml:altitudeMode><kml:coordinates>${a},1300 ${b},1400</kml:coordinates></kml:LineString><kml:Point><kml:coordinates>${a},1300</kml:coordinates></kml:Point></kml:MultiGeometry>`;
const point = a => `<kml:Point><kml:coordinates>${a},900</kml:coordinates></kml:Point>`;
const BAZL = `<?xml version="1.0" encoding="UTF-8"?><kml:kml xmlns:kml="http://www.opengis.net/kml/2.2"><kml:Document><kml:name>Swiss Obstacle Data Set</kml:name>
${pm('255BE1_0001', 'TRANSMISSION_LINE', 40, line('7.80,46.70', '7.81,46.70'))}
${pm('255BE1_0002', 'TRANSMISSION_LINE', 55, line('7.81,46.70', '7.82,46.70'))}
${pm('255BE1_0003', 'TRANSMISSION_LINE', 30, point('7.81,46.70'))}
${pm('272VD9_0001', 'CABLE_CAR', 240, line('7.85,46.68', '7.86,46.69'))}
${pm('100XX5_0001', 'CRANE', 60, point('7.83,46.69'))}
${pm('999FR1_0001', 'CRANE', 60, point('2.35,48.85'))}
</kml:Document></kml:kml>`;

test('Hindernisse: echtes BAZL-Format mit kml:-Präfix wird gelesen', () => {
  const it = parseObstacleKml(BAZL, [45.8, 5.9, 47.85, 10.55]);
  assert.equal(it.length, 3, 'Leitung (2 Spannweiten zusammen), Seilbahn, Kran; Mast der Leitung und Paris fehlen');
  const w = it.find(x => x.k === 'wire');
  assert.equal(w.id, '255BE1'); assert.equal(w.t, 'Stromleitung'); assert.equal(w.h, 55, 'höchste Spannweite');
  assert.equal(w.g.length, 1); assert.equal(w.g[0].length, 3, 'aneinanderstossende Spannweiten als eine Linie');
  assert.ok(w.len > 1400 && w.len < 1600);
  const r = it.find(x => x.k === 'rope');
  assert.equal(r.t, 'Seilbahn'); assert.equal(r.h, 240); assert.equal(r.top, 1400); assert.equal(r.m, 'orange Markierungen'); assert.equal(r.l, 'keine');
  assert.equal(it.find(x => x.k === 'pt').t, 'Kran');
});

test('Hindernisse: KMZ wird Stück für Stück entpackt', async () => {
  const many = BAZL.replace('</kml:Document>', Array.from({ length: 3000 }, (_, i) => pm(`500AA${i}_0001`, 'POLE', 30, point(`7.9,46.${String(6000 + i).padStart(4, '0')}`))).join('\n') + '</kml:Document>');
  const zip = makeZip('obstacles.kml', many);
  assert.ok(zipHas(zip)); assert.ok(!zipHas(zip, /\.csv$/));
  const it = await parseObstacleKmz(zip, [45.8, 5.9, 47.85, 10.55]);
  assert.equal(it.length, 3003);
  assert.equal(it.filter(x => x.t === 'Mast').length, 3000);
});
