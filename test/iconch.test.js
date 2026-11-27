// Thermiksäule aus ICON-CH1 (lib/iconch.js) und Ballon Payerne (lib/sonde.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gribHead, gribValues, byteRange, readWindow, column, cellThermal, placeThermal, inversionAbove, pickCells, stepsFor, compareTops, limiter } from '../lib/iconch.js';
import { parseSonde, compareProfile, inversion } from '../lib/sonde.js';

/** Eine GRIB2-Nachricht wie bei MeteoSchweiz: einfache Packung, 16 Bit, optional mit Bitmap. */
function makeGrib(values, { level = 1, ref = 200, e = -4, d = 0, bitmap = null } = {}) {
  const n = values.length;
  const s1 = Buffer.alloc(21); s1.writeUInt32BE(21, 0); s1[4] = 1;
  const s3 = Buffer.alloc(35); s3.writeUInt32BE(35, 0); s3[4] = 3; s3.writeUInt32BE(n, 6);
  const s4 = Buffer.alloc(34); s4.writeUInt32BE(34, 0); s4[4] = 4; s4.writeUInt16BE(0, 7); s4[9] = 0; s4[10] = 0; s4[17] = 1; s4.writeInt32BE(3, 18); s4[22] = 150; s4.writeInt8(0, 23); s4.writeUInt32BE(level, 24);
  const packedVals = bitmap ? values.filter((_, i) => bitmap[i]) : values;
  const s5 = Buffer.alloc(21); s5.writeUInt32BE(21, 0); s5[4] = 5; s5.writeUInt32BE(packedVals.length, 5); s5.writeUInt16BE(0, 9); s5.writeFloatBE(ref, 11);
  s5.writeUInt16BE(e < 0 ? 0x8000 | -e : e, 15); s5.writeUInt16BE(d < 0 ? 0x8000 | -d : d, 17); s5[19] = 16;
  let s6;
  if (bitmap) { const bl = Math.ceil(n / 8); s6 = Buffer.alloc(6 + bl); s6.writeUInt32BE(6 + bl, 0); s6[4] = 6; s6[5] = 0; bitmap.forEach((b, i) => { if (b) s6[6 + (i >> 3)] |= 0x80 >> (i & 7); }); }
  else { s6 = Buffer.alloc(6); s6.writeUInt32BE(6, 0); s6[4] = 6; s6[5] = 255; }
  const data = Buffer.alloc(packedVals.length * 2);
  packedVals.forEach((v, i) => data.writeUInt16BE(Math.round((v * 10 ** d - ref) / 2 ** e), 2 * i));
  const s7 = Buffer.concat([Buffer.from([0, 0, 0, 0, 7]), data]); s7.writeUInt32BE(s7.length, 0);
  const body = Buffer.concat([s1, s3, s4, s5, s6, s7]);
  const s0 = Buffer.alloc(16); s0.write('GRIB', 0, 'latin1'); s0[6] = 0; s0[7] = 2; s0.writeBigUInt64BE(BigInt(16 + body.length + 4), 8);
  return Buffer.concat([s0, body, Buffer.from('7777', 'latin1')]);
}

test('GRIB2: Kopf und Werte aus einem Zellfenster', () => {
  const vals = Array.from({ length: 50 }, (_, i) => 250 + i * 0.5);
  const g = makeGrib(vals, { level: 42 });
  const h = gribHead(g.subarray(0, 300));
  assert.equal(h.n, 50); assert.equal(h.level, 42); assert.equal(h.bits, 16); assert.equal(h.len, g.length);
  const [a, b] = byteRange(h, 10, 19);
  const v = gribValues(h, g.subarray(a, b + 1), 10, 19);
  assert.equal(v.length, 10);
  for (let i = 0; i < 10; i++) assert.ok(Math.abs(v[i] - vals[10 + i]) < 1e-3);
});

function serve(buf) {
  return new Promise(res => {
    const srv = http.createServer((req, rs) => {
      const m = (req.headers.range || '').match(/bytes=(\d+)-(\d+)/);
      if (!m) { rs.writeHead(200); return rs.end(buf); }
      const a = +m[1], b = Math.min(+m[2], buf.length - 1);
      rs.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${buf.length}` }); rs.end(buf.subarray(a, b + 1));
    }).listen(0, '127.0.0.1', () => res(srv));
  });
}

test('Lesen über HTTP-Range: mehrere Schichten, auch mit Bitmap', async () => {
  const L1 = Array.from({ length: 300 }, (_, i) => 280 + i * 0.01), L2 = Array.from({ length: 300 }, (_, i) => 270 + i * 0.01);
  const bm = Array.from({ length: 300 }, (_, i) => i % 3 !== 0);
  const file = Buffer.concat([makeGrib(L1, { level: 1 }), makeGrib(L2, { level: 2, bitmap: bm })]);
  const srv = await serve(file);
  try {
    const r = await readWindow(`http://127.0.0.1:${srv.address().port}/f.grib2`, 100, 109, { run: limiter(4) });
    assert.equal(r.length, 2);
    assert.ok(Math.abs(r[0].values[0] - L1[100]) < 0.04);
    for (let i = 100; i <= 109; i++) {
      const v = r[1].values[i - 100];
      if (bm[i]) assert.ok(Math.abs(v - L2[i]) < 0.04, `Zelle ${i}`); else assert.ok(Number.isNaN(v));
    }
  } finally { srv.close(); }
});

/** Modellsäule: 30 Schichten zu je 200 m über einem Boden auf 600 m, mit Inversion bei ~1600 m. */
function synthColumn({ inv = 1600, lapse = 0.0085, ps = 94500, t2 = 288 } = {}) {
  const n = 30, hhl = [];
  for (let k = 0; k <= n; k++) hhl.push(600 + (n - k) * 200);   // oben -> unten
  const T = [], QV = [];
  for (let k = 0; k < n; k++) {
    const z = (hhl[k] + hhl[k + 1]) / 2;
    let t = t2 - lapse * (z - 600);
    if (z > inv) t += Math.min(4, (z - inv) * 0.012);           // Sperrschicht
    T.push(t); QV.push(0.006 * Math.exp(-(z - 600) / 2500));
  }
  return { hhl, T, QV, ps, t2 };
}

test('Thermiksäule: Obergrenze an der Inversion, w* aus dem Wärmestrom, ohne Wärmestrom keine Thermik', () => {
  const c = synthColumn();
  const col = column(c.hhl, c.T, c.QV, c.ps);
  assert.ok(col[0].z < col[col.length - 1].z, 'von unten nach oben');
  assert.ok(col[0].p < 945 && col[0].p > 930, `Druck unten ${col[0].p}`);
  const r = cellThermal(col, { zs: 600, t2: 289, td2: 275, ps: c.ps, shf: 180 });
  assert.ok(r.top > 1400 && r.top < 1900, `Obergrenze ${r.top}`);
  assert.ok(r.wstar > 1 && r.wstar < 3, `w* ${r.wstar}`);
  assert.ok(Math.abs(r.inv - 1600) < 250, `Inversion ${r.inv}`);
  assert.ok(r.lcl > 2000, 'trocken: Basis über der Obergrenze');
  assert.equal(r.base, null, 'blau');
  const stable = cellThermal(col, { zs: 600, t2: 289, td2: 275, ps: c.ps, shf: -20 });
  assert.equal(stable.top, 600); assert.equal(stable.wstar, 0);
  // feucht: Kondensation unter der Obergrenze -> Wolkenbasis
  const wet = cellThermal(col, { zs: 600, t2: 289, td2: 287, ps: c.ps, shf: 180 });
  assert.ok(wet.base && wet.base < wet.top + 150, `Basis ${wet.base}`);
  assert.ok(Math.abs(wet.base - (600 + 125 * 2)) < 150, 'Kondensationsniveau ~125 m je Grad');
});

test('Inversion und Median über die Zellen', () => {
  const col = [0, 1, 2, 3, 4, 5].map(k => ({ z: 1000 + k * 200, t: k < 3 ? 5 - k : 3 + (k - 3) * 1.5 }));
  assert.deepEqual(inversionAbove(col, 1000), { z: 1600, dt: 3 });
  const p = placeThermal([{ top: 1500, lcl: 1800, base: null, wstar: 1.2, shf: 100 }, { top: 1700, lcl: 1600, base: 1600, wstar: 1.6, shf: 150 }, { top: 1600, lcl: 1650, base: 1650, wstar: 1.4, shf: 120 }, null]);
  assert.equal(p.top, 1600); assert.equal(p.wstar, 1.4); assert.equal(p.base, 1625, "Median der Zellen mit Wolken"); assert.equal(p.cells, 3);
});

test('Zellen je Ort und Stunden des Laufs', () => {
  const lat = Float32Array.from([46.70, 46.701, 46.80, 46.705]), lon = Float32Array.from([7.82, 7.821, 7.9, 7.83]);
  const g = pickCells(lat, lon, [{ key: 'a', lat: 46.7, lon: 7.82 }], 1.5);
  assert.deepEqual(g.byKey.a.cells.sort(), [0, 1, 3]); assert.equal(g.byKey.a.nearest, 0);
  const ref = Date.UTC(2026, 10, 28, 3);                       // 04 Uhr Zürich
  const st = stepsFor(ref, ref, 33);
  assert.equal(st[0], 3, '07 Uhr Zürich');
  assert.ok(st.every(h => { const zh = (h + 4) % 24; return zh >= 7 && zh <= 20; }));
});

const VZUS = `IUSD01 271304
IIiii zzzztttt zxracos0 yloclas0 yloclos0 zxltcos0 zxsrcos0 zxsacos0 zxlntis0 zreppps0 zreppzs0 zrettts0 zretdds0 zretdes0 zklddds0 zklfffs0 nsh000s0
0-20000-0-06610 202611271200 141.00 46.813 6.944 1 / / / 960.24 491.00 3.60 / 1.64 72.00 2.00 /
0-20000-0-06610 202611271200 141.00 46.812 6.944 10 / / / 925.00 792.00 -0.13 / -0.14 272.00 2.80 /
0-20000-0-06610 202611271200 141.00 46.812 6.945 4 / / / 902.07 992.90 -0.40 / -3.15 236.00 6.20 /
0-20000-0-06610 202611271200 141.00 46.812 6.945 4 / / / 869.39 1286.80 2.10 / -9.00 207.00 7.40 /
0-20000-0-06610 202611271200 141.00 46.812 6.945 4 / / / 850.00 1500.00 1.00 / -12.00 210.00 8.00 /
0-20000-0-06610 202611271200 141.00 46.812 6.945 4 / / / 700.00 3050.00 -9.00 / -20.00 250.00 12.00 /
`;

test('Ballon Payerne: lesen, Inversion finden, mit Modellprofil vergleichen', () => {
  const s = parseSonde(VZUS);
  assert.equal(new Date(s.time).toISOString(), '2026-11-27T12:00:00.000Z');
  assert.equal(s.levels.length, 6); assert.equal(s.levels[0].z, 491);
  assert.deepEqual(inversion(s.levels, 500, 4000), { z: 993, dt: 2.5 });
  const prof = { z: s.levels.map(l => l.z), tc: s.levels.map(l => l.t + 1), td: s.levels.map(l => l.td) };
  const c = compareProfile(prof, s);
  assert.equal(c.bias, 1); assert.equal(c.mae, 1); assert.equal(c.invDz, 0);
});

test('Alt gegen neu an IGC-Flügen', () => {
  const flights = [{ siteId: 'x', date: '2026-06-01', start: '12:00', durMin: 60, track: { thermals: [{ alt: 2500, rate: 2 }] } },
    { siteId: 'x', date: '2026-06-02', start: '13:00', durMin: 30, track: { thermals: [{ alt: 2000, rate: 1.5 }] } }];
  const old = new Map([['x|2026-06-01|12', { top: 2000 }], ['x|2026-06-02|13', { top: 2400 }]]);
  const neu = new Map([['x|2026-06-01|12', { top: 2400 }], ['x|2026-06-02|13', { top: 2100 }]]);
  const r = compareTops(flights, old, neu);
  assert.equal(r.n, 2); assert.equal(r.old.mae, 450); assert.equal(r.neu.mae, 100);
  assert.deepEqual(compareTops([], old, neu), { n: 0 });
});

test('Wind auf Höhe aus den Modellflächen und Richtung', async () => {
  const { windAt, windOf } = await import('../lib/iconch.js');
  // 3 Flächen, oben zuerst: Halbhöhen 2500, 1500, 750 (HHL 3000, 2000, 1000, 500)
  const hhl = [3000, 2000, 1000, 500], U = [10, 5, 2], V = [0, 0, 0];
  assert.deepEqual(windAt(hhl, U, V, 600), [2, 0], 'unter der untersten Fläche deren Wert');
  assert.ok(Math.abs(windAt(hhl, U, V, 2000)[0] - 7.5) < 1e-9, 'linear zwischen 1500 und 2500');
  assert.equal(windAt(hhl, U, V, 2600), null);
  assert.deepEqual(windOf(0, -10), { wind: 36, dir: 0 }, 'Nordwind weht nach Süden');
  assert.deepEqual(windOf(-10, 0), { wind: 36, dir: 90 }, 'Ostwind');
});

test('Wettervarianten: Bodenwerte je Variante, Wind auf Starthöhe verschoben, Regen und Wolkenbasis', async () => {
  const { memberRow } = await import('../lib/iconch.js');
  const c = synthColumn(), col = column(c.hhl, c.T, c.QV, c.ps);
  const base = { cells: [0], cols: [col], zs: [600], ps: [c.ps], wl: [0, -5], cu10: 0, cv10: -2, rain: 0, cloud: 20 };
  const warm = memberRow({ ...base, t2: [289], td2: [275], shf: [180], u10: 0, v10: -2, g10: 4 });
  const cold = memberRow({ ...base, t2: [289], td2: [275], shf: [10], u10: 0, v10: -2, g10: 4 });
  assert.ok(warm[0] > 1400 && cold[0] === 600, `Sonne macht Thermik: ${warm[0]} gegen ${cold[0]}`);
  assert.deepEqual(warm.slice(1, 3), [18, 0], 'Hauptlauf-Wind auf Starthöhe (5 m/s aus Nord)');
  // Variante mit 3 m/s mehr Nordwind am Boden: auf Starthöhe ebenso mehr
  const windy = memberRow({ ...base, t2: [289], td2: [275], shf: [180], u10: 0, v10: -5, g10: 9, rain: 1.24 });
  assert.equal(windy[1], 28.8);
  assert.ok(windy[3] >= windy[1], 'Böen nie unter dem Mittelwind');
  assert.equal(windy[4], 1.2, 'Regen der Stunde in mm');
  const wet = memberRow({ ...base, t2: [289], td2: [287], shf: [180], u10: 0, v10: -2, g10: 4 });
  assert.ok(wet[6] && wet[0] <= wet[6], 'Thermik endet an der Wolkenbasis');
});

test('3D-Wolken: unterste Schicht aus der Bedeckung auf den Modellflächen', async () => {
  const { cloudLayer } = await import('../lib/iconch.js');
  // Halbschichten oben->unten: 4000, 3000, 2000, 1500, 1000, 600; Vollschichten dazwischen (5)
  const hh = [4000, 3000, 2000, 1500, 1000, 600];
  assert.deepEqual(cloudLayer(hh, [0, 80, 0, 60, 90]), { base: 600, top: 1500, cov: 90 }, 'Nebel/Hochnebel ab Boden, Lücke darüber beendet die Schicht');
  assert.deepEqual(cloudLayer(hh, [0, 0, 70, 10, 0]), { base: 1500, top: 2000, cov: 70 });
  assert.equal(cloudLayer(hh, [0, 20, 0, 10, 5]), null, 'unter 30 % keine Schicht');
});
