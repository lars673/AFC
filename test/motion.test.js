// Motion-Grafik (motion.js): Windteilchen folgen dem Wind, Ruhig-Modus zeigt weniger, Thermik steigt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const ctx = { window: {}, Math, Float32Array, Uint8Array };
vm.runInNewContext(fs.readFileSync(new URL('../motion.js', import.meta.url), 'utf8'), ctx);
const M = ctx.window.AFCMotion;
// flache Szene von 4 km Radius, Ursprung bei 46.7 / 7.8
const sc = { R: 4000, ex: 1, _meshH: () => 600, toGeo: (x, z) => [46.7 - z / 111320, 7.8 + x / 76000] };

test('Windteilchen ziehen mit dem Wind (Westwind -> nach Osten)', () => {
  const sim = M.wind(sc, () => ({ g: [20, 0], a: [20, 0] }), { n: 500, glow: true });
  const heads = [];
  const put = (i, h, t) => { heads[i] = [h[0], t[0]]; };
  sim.step(0.05, put);
  const n = sim.step(0.05, put);
  assert.ok(n > 300, 'die meisten Teilchen sind sichtbar');
  for (let i = 0; i < n; i++) assert.ok(heads[i][0] > heads[i][1], 'der Kopf liegt östlich vom Schwanz');
});

test('Ruhig-Modus zeigt deutlich weniger Teilchen', () => {
  const sim = M.wind(sc, () => ({ g: [15, 5], a: [15, 5] }), { n: 1000 });
  const full = sim.step(0.03, () => {});
  sim.calm = true;
  const calm = sim.step(0.03, () => {});
  assert.ok(calm < full * 0.5, `${calm} < ${full}/2`);
});

test('Windstille: keine stehenden Teilchen', () => {
  const sim = M.wind(sc, () => ({ g: [0, 0], a: [0, 0] }), { n: 300 });
  assert.equal(sim.step(0.03, () => {}), 0);
});

test('Thermik-Teilchen steigen über dem Fuss auf', () => {
  const sim = M.thermals(sc, [{ A: [0, 600, 0], lean: [200, 0], H: 1500, climb: 2.5, v: 0.8 }], { n: 400, glow: true });
  let lo = Infinity, hi = -Infinity;
  const n = sim.step(0.05, (i, h) => { lo = Math.min(lo, h[1]); hi = Math.max(hi, h[1]); });
  assert.ok(n > 100);
  assert.ok(lo >= 600 && hi <= 2100 && hi - lo > 900, `Höhe ${lo}-${hi}`);
});

test('Farben: ruhig cyan, stark violett bis magenta', () => {
  assert.match(M.color(8, true), /^rgb\(\d+,\d+,\d+\)$/);
  const [r1, , b1] = M.color(8, true).match(/\d+/g).map(Number), [r2, g2] = M.color(50, true).match(/\d+/g).map(Number);
  assert.ok(b1 > r1, 'schwacher Wind ist bläulich');
  assert.ok(r2 > g2, 'starker Wind ist rot-violett');
});
