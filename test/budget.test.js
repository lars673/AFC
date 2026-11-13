import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { makePlan, everyMs, needUntilReset, stretchFactor, isDue } from '../lib/budget.js';
import { httpGet, openMeteoUsage, openMeteoBlocked, resetOpenMeteoUsage, limitUntil } from '../lib/http.js';

const P = makePlan({});
const at = (h, m = 0) => Date.UTC(2026, 10, 13, h - 1, m);   // Zürcher Zeit im November = UTC+1

test('Tagesplan: tagsüber stündlich, nachts alle 3 Stunden', () => {
  assert.equal(everyMs(P.jobs.fc, at(10)), 60 * 60000);
  assert.equal(everyMs(P.jobs.fc, at(23)), 180 * 60000);
  assert.equal(everyMs(P.jobs.wind, at(12)), 180 * 60000);
  assert.equal(everyMs(P.jobs.wind, at(3)), 360 * 60000);
});

test('Tagesplan: der normale Tag passt mit Reserve ins Kontingent', () => {
  // ganzer Tag ab Mitternacht UTC mit den geschätzten Kosten
  const day0 = Date.UTC(2026, 10, 13, 0, 0);
  const jobs = Object.entries(P.jobs).map(([id, def]) => ({ id, def, lastAt: 0, cost: def.cost }));
  const need = needUntilReset(jobs, day0);
  assert.ok(need < P.budget * 0.8, `braucht ${need}`);
  assert.equal(stretchFactor(jobs, 0, P.budget, day0), 1);
});

test('Tagesplan: nach einem teuren Vormittag werden die Abstände gestreckt statt um 14 Uhr aufzuhören', () => {
  const now = at(13);
  const jobs = [{ def: P.jobs.fc, lastAt: now - 60 * 60000, cost: 180 }, { def: P.jobs.wind, lastAt: now - 60 * 60000, cost: 300 }];
  const f = stretchFactor(jobs, 7500, P.budget, now);
  assert.ok(f > 1 && Number.isFinite(f), String(f));
  // mit dem Faktor ist die Prognose später fällig, aber nicht gesperrt
  const base = { def: P.jobs.fc, cost: 180, used: 7500, budget: P.budget, blocked: 0 };
  assert.equal(isDue({ ...base, lastAt: now - 61 * 60000, factor: f, now }), false);
  assert.equal(isDue({ ...base, lastAt: now - 61 * 60000 * f, factor: f, now }), true);
});

test('Tagesplan: Neustart kostet nichts, Fehlschlag wartet 15 Minuten, Sperre stoppt', () => {
  const now = at(10, 30), base = { def: P.jobs.fc, cost: 180, factor: 1, used: 2000, budget: P.budget, now, blocked: 0 };
  assert.equal(isDue({ ...base, lastAt: now - 20 * 60000 }), false);           // Prognose von vor 20 Minuten gilt weiter
  assert.equal(isDue({ ...base, lastAt: now - 59 * 60000 }), true);
  assert.equal(isDue({ ...base, lastAt: 0 }), true);
  assert.equal(isDue({ ...base, lastAt: now - 3 * 3600000, lastTry: now - 5 * 60000 }), false);
  assert.equal(isDue({ ...base, lastAt: now - 3 * 3600000, blocked: now + 60000 }), false);
});

test('Tagesplan aufgebraucht: Prognose trotzdem alle 3 Stunden, solange Open-Meteo noch Platz hat', () => {
  const now = at(15), base = { def: P.jobs.fc, cost: 180, factor: Infinity, used: 9000, budget: P.budget, now, blocked: 0 };
  assert.equal(isDue({ ...base, lastAt: now - 2 * 3600000 }), false);
  assert.equal(isDue({ ...base, lastAt: now - 3 * 3600000 }), true);
  assert.equal(isDue({ ...base, used: 9900, lastAt: now - 4 * 3600000 }), false);
  assert.equal(isDue({ ...base, def: P.jobs.wind, cost: 300, lastAt: now - 9 * 3600000 }), false);   // Windkarte wartet
});

test('Open-Meteo sperrt (429): keine Wiederholung, bis zum Ende der Sperre keine weiteren Abfragen', async () => {
  resetOpenMeteoUsage();
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: true, reason: 'Daily API request limit exceeded. Please try again tomorrow.' })); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/v1/forecast?latitude=1&longitude=1&hourly=a&forecast_days=5`;
  try {
    await assert.rejects(httpGet(url), e => e.limit === true);
    assert.equal(hits, 1);
    assert.ok(openMeteoBlocked() > Date.now());
    await assert.rejects(httpGet(url), e => e.limit === true && /wieder ab/.test(e.message));
    assert.equal(hits, 1, 'während der Sperre kein Netzabruf');
    assert.equal(openMeteoUsage().calls, 0, 'abgelehnte Abfragen zählen nicht');
  } finally { srv.close(); resetOpenMeteoUsage(); }
  const now = Date.UTC(2026, 10, 13, 13, 20);
  assert.equal(limitUntil('Daily API request limit exceeded', now), Date.UTC(2026, 10, 14));
  assert.equal(limitUntil('Hourly API request limit exceeded', now), Date.UTC(2026, 10, 13, 14));
});
