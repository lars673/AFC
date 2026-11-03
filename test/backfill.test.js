import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHourlyCSV, regionalRows, gradRows, eventDays, fetchRegionalHistory } from '../lib/backfill.js';

const H = 3600000;
const csv = rows => 'station_abbr;reference_timestamp;fu3010h0;fu3010h1;dkl010h0;pp0qffh0\n' +
  rows.map(r => `X;${new Date(r.ms).toISOString().replace(/^(\d+)-(\d+)-(\d+)T(\d+):(\d+).*/, '$3.$2.$1 $4:$5')};${r.wind ?? ''};${r.gust ?? ''};${r.dir ?? ''};${r.qff ?? ''}`).join('\n');

test('Nachlernen: Stundendatei lesen, Bisetag erkennen, Druckprognose rechnen', async () => {
  const t0 = Date.UTC(2026, 10, 1, 8), bise = new Set([t0 + 2 * H, t0 + 3 * H]);
  const hours = Array.from({ length: 6 }, (_, k) => t0 + k * H);
  const m = parseHourlyCSV(csv([{ ms: t0, wind: 12.5, gust: 30, dir: 45, qff: 1020.1 }]));
  assert.deepEqual(m.get(t0), { wind: 12.5, gust: 30, dir: 45, qff: 1020.1 });
  const st = {
    BER: hours.map(ms => ({ ms, wind: bise.has(ms) ? 18 : 5, gust: bise.has(ms) ? 45 : 10, dir: bise.has(ms) ? 45 : 250 })),
    THU: hours.map(ms => ({ ms, wind: bise.has(ms) ? 15 : 4, gust: 20, dir: bise.has(ms) ? 40 : 250 })),
    KLO: hours.map(ms => ({ ms, wind: 5, gust: 10, dir: 50, qff: bise.has(ms) ? 1022 : 1016 })),
    GVE: hours.map(ms => ({ ms, wind: 5, gust: 10, dir: 50, qff: 1016 }))
  };
  const obs = Object.fromEntries(Object.entries(st).map(([c, rs]) => [c, parseHourlyCSV(csv(rs))]));
  const rows = regionalRows(obs, t0, t0 + 5 * H);
  assert.equal(rows.length, 6);
  const r2 = rows.find(r => r.time === new Date(t0 + 2 * H).toISOString());
  assert.equal(r2.obdp, 6);
  assert.ok(r2.bise >= 70, `Bise-Signal ${r2.bise}`);
  assert.ok(rows[0].bise < 40);
  assert.deepEqual(eventDays(rows, 'bise').map(d => d.day), ['2026-11-01']);
  const g = gradRows({ LUG: { time: ['2026-11-01T10:00'], pressure_msl: [1015] }, KLO: { time: ['2026-11-01T10:00'], pressure_msl: [1019.5] }, GVE: { time: ['2026-11-01T10:00'], pressure_msl: [1016] } });
  assert.deepEqual(g, [{ time: '2026-11-01T10:00:00.000Z', fdp: -4.5, bdp: 3.5 }]);

  // Ablauf mit nachgebildetem Abruf: fehlende Stationen sind kein Fehler
  const urls = [];
  const get = async url => {
    urls.push(url);
    if (url.includes('/v1/forecast')) return { json: async () => ['LUG', 'KLO', 'GVE'].map(c => ({ hourly: { time: ['2026-11-01T10:00'], pressure_msl: [{ LUG: 1015, KLO: 1019.5, GVE: 1016 }[c]] } })) };
    const code = url.match(/ogd-smn_(\w+)_h_recent/)[1].toUpperCase();
    if (!st[code]) throw new Error('HTTP 404');
    return { text: async () => csv(st[code]) };
  };
  const r = await fetchRegionalHistory({ smn: 'http://x', hist: 'http://h', days: 3, now: t0 + 30 * H, get });
  assert.equal(r.fc.length, 1);
  assert.equal(r.obs.filter(x => x.bise >= 70).length, 2);
  assert.ok(r.missing.includes('GRH') && !r.missing.includes('BER'));
  assert.ok(urls[0].includes('start_date=2026-10-30') && urls[0].includes('hourly=pressure_msl'));
});
