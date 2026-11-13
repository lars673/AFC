import test from 'node:test';
import assert from 'node:assert/strict';
import { accuracyData, accuracyHtml } from '../lib/genau.js';

const run = (from, to, passt, gef, streng, x = {}) => ({ at: to + 'T02:00:00Z', from, to, n: 100, passt, gefaehrlich: gef, zuStreng: streng, faelle: gef ? ['2026-10-14 Haslital: Score 82 <b>'] : [], ...x });

test('So genau war AFC: letzter Lauf, Summe ohne doppelte Tage, gefährliche Fälle offen, ohne Läufe ein ehrlicher Hinweis', () => {
  assert.equal(accuracyData({}).last, null);
  assert.match(accuracyHtml(accuracyData({})), /Noch keine Zahlen/);
  const d = accuracyData({
    history: [run('2026-10-09', '2026-10-22', 90, 1, 9), run('2026-10-16', '2026-10-29', 93, 0, 7), run('2026-10-30', '2026-11-12', 50, 0, 2), run('2026-10-30', '2026-11-12', 96, 0, 4, { bise: { tage: 4, verpasst: 0, umsonst: 1 } }), { n: 0 }],
    verdicts: { richtig: 6, streng: 3, mild: 1 }
  });
  assert.equal(d.runs.length, 3, 'gleicher Zeitraum zählt einmal, der neueste');
  assert.equal(d.last.pct, 96);
  assert.deepEqual([d.total.from, d.total.n, d.total.pct, d.total.zuStreng], ['2026-10-16', 200, 95, 11], 'überlappender ältester Lauf nicht doppelt');
  const h = accuracyHtml(d, { version: '12.9' });
  assert.match(h, /96&nbsp;%/); assert.match(h, /1 gefährlich/); assert.match(h, /60 % «lag richtig»/); assert.match(h, /Bise:<\/b> an 4 Tagen/);
  assert.ok(!/<script/.test(h), 'kein JavaScript');
  const bad = accuracyHtml(accuracyData({ history: [run('2026-10-09', '2026-10-22', 60, 1, 9)] }));
  assert.match(bad, /Score 82 &lt;b&gt;/, 'Fälle offen und sicher ausgegeben');
});
