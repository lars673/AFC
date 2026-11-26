// WindNinja-Feld (lib/wn.js): Ausschnitt schneiden, Kopf und Daten stimmen, ausserhalb nichts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as WN from '../lib/wn.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-'));
const meta = { la0: 46.5, lo0: 7.5, dla: 0.001, dlo: 0.0015, nx: 50, ny: 40, dirs: 16, speed: 20, fScale: 64, src: 'test' };
const N = meta.nx * meta.ny, buf = Buffer.alloc(N * 16 * 2);
for (let d = 0; d < 16; d++) for (let k = 0; k < N; k++) { buf[d * 2 * N + k] = 64 + d; buf[d * 2 * N + N + k] = (k % meta.nx) & 0x7f; }
fs.mkdirSync(path.join(root, 'wn'));
fs.writeFileSync(path.join(root, 'wn', 'meta.json'), JSON.stringify(meta));
fs.writeFileSync(path.join(root, 'wn', 'wind.bin'), buf);

const parse = out => { const hl = out.readUInt32LE(0); return { h: JSON.parse(out.subarray(4, 4 + hl)), d: out.subarray(4 + hl) }; };

test('Ausschnitt: Kopf, Faktor je Richtung und Ablenkung je Spalte', () => {
  WN._reset();
  const out = WN.slice(root, [46.505, 7.51, 46.52, 7.53]);
  const { h, d } = parse(out);
  assert.equal(h.dirs, 16);
  assert.equal(d.length, h.nx * h.ny * 32);
  const n = h.nx * h.ny;
  assert.equal(d[3 * 2 * n], 64 + 3);                       // Faktor der Richtung 3
  const x0 = Math.round((h.lo0 - meta.lo0) / meta.dlo);
  assert.equal(d[3 * 2 * n + n + 1], x0 + 1);               // Ablenkung = Spalte im Testfeld
});

test('grosser Ausschnitt wird gröber, ausserhalb gibt es nichts', () => {
  WN._reset();
  const { h } = parse(WN.slice(root, [46.5, 7.5, 46.54, 7.575], 20));
  assert.ok(h.nx <= 20 && h.ny <= 20);
  assert.equal(WN.slice(root, [47, 9, 47.1, 9.1]), null);
});

test('ohne Datei: null', () => {
  WN._reset();
  assert.equal(WN.slice(path.join(root, 'fehlt'), [46.5, 7.5, 46.52, 7.53]), null);
  WN._reset();
});
