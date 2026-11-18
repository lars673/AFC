import test from 'node:test';
import assert from 'node:assert/strict';
import { testProgress, testBreakdown, dayType, TEST_GOAL } from '../lib/testphase.js';
import { reviewNotices } from '../lib/notify.js';

const fl = (uid, date, v, fc = null, siteId = 'a') => ({ uid, date, afcVerdict: v, afcFc: fc, siteId });

test('Testphase zählt nur bewertete Flüge, Piloten und Tage', () => {
  const flights = [fl('u1', '2026-11-20', 'richtig'), fl('u1', '2026-11-20', ''), fl('u2', '2026-11-21', 'streng')];
  const p = testProgress({ flights, nofly: [{ uid: 'u3', date: '2026-11-21' }], uid: 'u1' });
  assert.equal(p.rated, 2);
  assert.equal(p.pilots, 2);
  assert.equal(p.days, 2);
  assert.equal(p.nofly, 1);
  assert.equal(p.mine, 1);
  assert.equal(p.left, TEST_GOAL.flights - 2);
  assert.equal(p.done, false);
});

test('Testphase ist erst fertig, wenn Flüge, Piloten und Tage reichen', () => {
  const many = Array.from({ length: 100 }, (_, i) => fl('u1', '2026-12-0' + (i % 9 + 1), 'richtig'));
  const p = testProgress({ flights: many });
  assert.equal(p.done, false, 'ein Pilot allein reicht nicht');
  assert.equal(p.pct, 10, 'der schwächste Teil bestimmt den Stand');
  const ok = Array.from({ length: 100 }, (_, i) => fl('u' + (i % 10), `2026-12-${String(i % 20 + 1).padStart(2, '0')}`, 'mild'));
  const q = testProgress({ flights: ok });
  assert.equal(q.done, true);
  assert.equal(q.pct, 100);
});

test('Aufteilung nach Pilot, Gebiet und Tagestyp', () => {
  const flights = [fl('u1', 'd', 'richtig', { wstar: 2 }), fl('u1', 'd', 'streng', { gust: 35 }), fl('u2', 'd', 'mild', null, 'b')];
  const b = testBreakdown({ flights, areaOf: id => (id === 'a' ? 'Beatenberg' : 'First'), names: { u1: 'Lars', u2: 'Timo' } });
  assert.deepEqual(b.byPilot.map(x => [x.name, x.n]), [['Lars', 2], ['Timo', 1]]);
  assert.equal(b.byArea[0].name, 'Beatenberg');
  assert.equal(b.byArea[0].streng, 1);
  assert.equal(dayType({ wstar: 2 }), 'Thermik');
  assert.equal(dayType({ speed: 8, wstar: 0.5 }), 'ruhig');
  assert.equal(dayType(null), 'ohne Prognose');
  assert.ok(b.byType.some(x => x.name === 'windig'));
});

test('Abend-Erinnerung nennt die fehlenden Flüge der Testphase', () => {
  const n = reviewNotices([{ id: 'f1', date: '2026-11-20', siteName: 'Amisbühl' }], '2026-11-20', 63);
  assert.match(n[0].body, /Noch 63 bewertete Flüge/);
  const m = reviewNotices([{ id: 'f1', date: '2026-11-20' }], '2026-11-20', null);
  assert.doesNotMatch(m[0].body, /Testphase/);
});
