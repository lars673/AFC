import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotices, cleanPrefs, goodDayNotice, foehnNotice } from '../lib/notify.js';

const site = (id, name, score, extra = {}) => ({ id, name, days: [{ best: null }, { best: score === null ? null : { score, from: 11, to: 15, decision: { label: score >= 85 ? 'Starten' : 'Prüfen' } } }], ...extra });
const hours = f => Array.from({ length: 12 }, (_, i) => ({ h: 7 + i, foehn: f(7 + i) }));
const plan = (sites, f0 = () => 'ok', f1 = () => 'ok') => ({ dates: ['2026-11-02', '2026-11-03'], sites, region: { days: [{ hours: hours(f0) }, { hours: hours(f1) }] } });

test('Guter Flugtag morgen: Favoriten zuerst, Schwelle, gesperrte Plätze nie', () => {
  const p = plan([site('a', 'Amisbühl', 86), site('n', 'Niesen', 90, { blocked: true }), site('f', 'First', 78), site('m', 'Männlichen', 60)]);
  const n = goodDayNotice(p, 1, cleanPrefs({}));
  assert.equal(n.title, 'Morgen 86 am Amisbühl');
  assert.match(n.body, /11–15 Uhr \(Starten\)\. Auch gut: First 78\./);
  assert.equal(n.key, 'good:2026-11-03');
  assert.equal(goodDayNotice(p, 1, cleanPrefs({ favs: ['m'] })), null);   // Favorit nur 60
  assert.equal(goodDayNotice(p, 1, cleanPrefs({ favs: ['f'] })).title, 'Morgen 78 am First');
  assert.equal(goodDayNotice(p, 1, cleanPrefs({ threshold: 85, favs: ['f'] })), null);
});

test('Föhn: Warnung bei K.-o., Hinweis erst ab zwei Stunden Vorsicht', () => {
  assert.equal(foehnNotice(plan([], undefined, h => (h >= 13 ? 'danger' : 'ok')), 1).title, 'Föhnwarnung morgen');
  assert.match(foehnNotice(plan([], undefined, h => (h >= 13 ? 'danger' : 'ok')), 1).body, /ab etwa 13 Uhr/);
  assert.equal(foehnNotice(plan([], undefined, h => (h === 12 ? 'warn' : 'ok')), 1), null);
  assert.equal(foehnNotice(plan([], h => (h >= 10 && h <= 11 ? 'warn' : 'ok')), 0).title, 'Föhn möglich heute');
  assert.equal(foehnNotice(plan([], undefined, h => (h === 20 ? 'danger' : 'ok')), 1), null);   // nur Tagesstunden
});

test('Morgens Föhn und Ausrüstung, abends Ausblick; abgeschaltete Arten fehlen', () => {
  const now = Date.parse('2026-11-02T07:00:00Z');
  const gear = [{ id: 'r', type: 'reserve', brand: 'Supair', model: 'Light', packedLast: '2026-05-10', packMonths: 6 }, { id: 'old', type: 'reserve', retired: true, packedLast: '2020-01-01', packMonths: 6 }];
  const p = plan([site('a', 'Amisbühl', 86)], h => (h === 9 ? 'danger' : 'ok'));
  const m = buildNotices({ phase: 'morning', plan: p, prefs: cleanPrefs({}), gear, now });
  assert.deepEqual(m.map(x => x.title), ['Föhnwarnung heute', 'Retter packen bald fällig']);
  assert.equal(buildNotices({ phase: 'morning', plan: p, prefs: cleanPrefs({ gear: false, foehn: false }), gear, now }).length, 0);
  assert.deepEqual(buildNotices({ phase: 'evening', plan: p, prefs: cleanPrefs({}), gear, now }).map(x => x.title), ['Morgen 86 am Amisbühl']);
  assert.deepEqual(cleanPrefs({ threshold: 99, level: 'x' }), { good: true, foehn: true, gear: true, health: true, threshold: 75, favs: [], level: 'normal' });
});
