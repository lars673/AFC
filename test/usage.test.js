import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanUsage, usageSummary } from '../lib/usage.js';

test('Nutzung: Pakete werden geprüft und zusammengefasst', () => {
  const c = cleanUsage({ ev: [{ k: 'tab', key: 'map', n: 1, s: 10.4 }, { k: 'tab', key: 'map', n: 1, s: 5 }, { k: 'tab', key: '../x', n: 1 }, { k: 'evil', key: 'a', n: 1 }, { k: 'feat', key: 'film', n: 0, s: 0 }, { k: 'sess', key: 'all', n: 9999, s: 1e9 }] });
  assert.deepEqual(c.find(x => x.key === 'map'), { kind: 'tab', key: 'map', n: 2, secs: 15 });
  assert.equal(c.length, 2);
  assert.deepEqual(c.find(x => x.kind === 'sess'), { kind: 'sess', key: 'all', n: 500, secs: 21600 });
  assert.deepEqual(cleanUsage(null), []);
});

test('Nutzung: Überblick pro Reiter, Funktion, Pilot, Absprung', () => {
  const users = [{ id: 'a', name: 'Lars', role: 'admin' }, { id: 'b', name: 'Thierry', role: 'pilot' }, { id: 'c', name: 'Mia', role: 'pilot' }, { id: 'd', name: 'Nie', role: 'pilot' }];
  const rows = [
    { uid: 'a', day: '2026-11-24', kind: 'sess', key: 'all', n: 5, secs: 3000 },
    { uid: 'b', day: '2026-11-23', kind: 'sess', key: 'all', n: 2, secs: 240 },
    { uid: 'b', day: '2026-11-24', kind: 'sess', key: 'all', n: 1, secs: 120 },
    { uid: 'b', day: '2026-11-24', kind: 'tab', key: 'decide', n: 3, secs: 300 },
    { uid: 'b', day: '2026-11-24', kind: 'tab', key: 'map', n: 1, secs: 60 },
    { uid: 'b', day: '2026-11-24', kind: 'feat', key: 'site', n: 4, secs: 0 },
    { uid: 'b', day: '2026-11-24', kind: 'exit', key: 'tab:decide', n: 2, secs: 0 },
    { uid: 'b', day: '2026-11-24', kind: 'flow', key: 'intro1', n: 1, secs: 0 },
    { uid: 'x', day: '2026-11-24', kind: 'sess', key: 'all', n: 1, secs: 60 }   // gelöschtes Konto
  ];
  const activeDays = new Map([['b', ['2026-11-23', '2026-11-24']], ['c', ['2026-11-01', '2026-11-03']]]);
  const s = usageSummary(rows, { users, activeDays, today: '2026-11-24', from: '2026-11-18' });
  assert.equal(s.pilots, 1); assert.equal(s.sessions, 3); assert.equal(s.mins, 6); assert.equal(s.avgMin, 2);
  assert.equal(s.tabs[0].key, 'decide'); assert.equal(s.tabs[0].pilots, 1);
  assert.equal(s.feats[0].key, 'site'); assert.equal(s.feats[0].n, 4);
  assert.equal(s.exits[0].n, 2); assert.equal(s.flow.intro1.pilots, 1);
  assert.equal(s.daily.length, 7); assert.equal(s.daily.at(-1).pilots, 1); assert.equal(s.daily[0].pilots, 0);
  assert.equal(s.perPilot[0].name, 'Thierry'); assert.equal(s.perPilot[0].days, 2); assert.equal(s.perPilot[0].tabs[0].key, 'decide');
  assert.deepEqual(s.dropped.map(x => x.name), ['Mia', 'Nie']);
  const all = usageSummary(rows, { users, activeDays, today: '2026-11-24', from: '2026-11-18', withAdmin: true });
  assert.equal(all.pilots, 2); assert.equal(all.sessions, 8);
});
