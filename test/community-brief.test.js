// Briefing als Beitrag in der Gruppe: eigener Typ, gilt wie ein Treffen für einen kommenden Tag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPost, POST_KINDS } from '../lib/community.js';

test('Briefing-Beitrag: Typ bleibt erhalten, Datum darf in der Zukunft liegen (höchstens 14 Tage)', () => {
  assert.ok(POST_KINDS.brief);
  const p = cleanPost({ kind: 'brief', siteId: 'niesen', siteName: 'Niesen', date: '2026-11-12', text: 'Niesen, morgen: Score 84' }, '2026-11-11');
  assert.deepEqual({ kind: p.kind, date: p.date, siteId: p.siteId }, { kind: 'brief', date: '2026-11-12', siteId: 'niesen' });
  assert.equal(cleanPost({ kind: 'brief', date: '2026-12-24', text: 'x' }, '2026-11-11').date, '2026-11-11');
  assert.equal(cleanPost({ kind: 'brief', date: '2026-11-01', text: 'x' }, '2026-11-11').date, '2026-11-11');
});
test('Andere Beiträge bleiben wie bisher: Bericht mit Datum in der Zukunft gilt für heute', () => {
  assert.equal(cleanPost({ kind: 'report', date: '2026-11-12', text: 'x' }, '2026-11-11').date, '2026-11-11');
  assert.equal(cleanPost({ kind: 'gibtsnicht', text: 'x' }, '2026-11-11').kind, 'report');
});
