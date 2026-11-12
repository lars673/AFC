import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startMock } from './mock-upstream.js';
import { askMyAfc, findSite, toolProfile, myafcError, TOOLS } from '../lib/myafc.js';

const plan = {
  ok: true,
  areas: [{ id: 'niederhorn', name: 'Niederhorn' }],
  sites: [
    { id: 'niederhorn-1', name: 'Niederhorn W', area: 'niederhorn', days: [{ best: { score: 70 } }] },
    { id: 'niederhorn-2', name: 'Niederhorn O', area: 'niederhorn', days: [{ best: { score: 84 } }] },
    { id: 'first-1', name: 'First', area: 'grindelwald', days: [{ best: { score: 60 } }] }
  ]
};

test('Startplatz finden: genau, ohne Umlaute und Gross/Klein, sonst der am besten bewertete Treffer', () => {
  assert.equal(findSite(plan, 'first').id, 'first-1');
  assert.equal(findSite(plan, 'niederhorn-1').id, 'niederhorn-1');
  assert.equal(findSite(plan, 'Niederhorn').id, 'niederhorn-2', 'mehrere Richtungen: die beste');
  assert.equal(findSite(plan, 'NIEDERHÖRN w').id, 'niederhorn-1', 'Umlaute und Gross/Klein egal');
  assert.equal(findSite(plan, 'zzz'), null);
  assert.equal(findSite(plan, ''), null);
  for (const t of TOOLS) assert.equal(t.input_schema.additionalProperties, false, t.name);
});

test('Profil: Muster aus dem eigenen Flugbuch erst ab 3 Flügen mit Prognose, Heimgebiete mit Namen', () => {
  const f = (date, gust, score, rating, v) => ({ date, siteId: 'niederhorn-1', durMin: 40, rating, afcVerdict: v, afcFc: { score, gust, speed: 10, top: 2500 } });
  const few = toolProfile({ profile: { homes: ['niederhorn'] }, logbook: { flights: [f('2026-07-01', 22, 81, 5, 'richtig')] }, plan });
  assert.match(String(few.flugbuch.muster), /noch zu wenige/);
  assert.deepEqual(few.heimgebiete, ['Niederhorn']);
  const p = toolProfile({
    name: 'Test', prefs: { level: 'normal', fav: ['first-1'] },
    logbook: { flights: [f('2026-07-01', 22, 81, 5, 'richtig'), f('2026-07-05', 30, 66, 4, 'streng'), f('2026-07-09', 35, 58, 2, ''), f('2026-08-01', 18, 90, 5, 'richtig')] },
    nofly: [{ date: '2026-08-03', siteId: 'first-1', reason: 'wind', afcScore: 77 }], plan
  });
  assert.equal(p.flugbuch.fluege, 4);
  assert.equal(p.flugbuch.muster.hoechste_boeen_geflogen, 35);
  assert.equal(p.flugbuch.muster.hoechste_boeen_bei_guter_bewertung, 30);
  assert.equal(p.flugbuch.muster.tiefster_score_geflogen, 58);
  assert.deepEqual(p.flugbuch.rueckmeldungen_zu_afc, { richtig: 2, streng: 1, mild: 0 });
  assert.deepEqual(p.favoriten, ['First']);
  assert.equal(p.flugbuch.nicht_gestartet[0].platz, 'First');
});

test('Gespräch: Werkzeug aufrufen, Ergebnis zurückgeben, Antwort lesen; Denkblöcke bleiben unverändert im Verlauf', async () => {
  const sent = [];
  const replies = [
    { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'sig1' }, { type: 'tool_use', id: 'tu1', name: 'startplatz', input: { name: 'First', tag: 1 } }], usage: { input_tokens: 900, output_tokens: 40 } },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Morgen ab 11 Uhr gut.' }], usage: { input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 800 } }
  ];
  const fetchImpl = async (url, o) => { sent.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => replies.shift() }; };
  const calls = [];
  const r = await askMyAfc({ apiKey: 'k', model: 'claude-opus-5-5', history: [], text: 'Soll ich morgen auf den First?', stamp: 'Do 12.11.2026', run: (n, i) => { calls.push([n, i]); return { ok: 1 }; }, fetchImpl });
  assert.equal(r.reply, 'Morgen ab 11 Uhr gut.');
  assert.deepEqual(calls, [['startplatz', { name: 'First', tag: 1 }]]);
  assert.deepEqual(r.tools, ['startplatz']);
  assert.deepEqual(r.usage, { in: 2100, out: 70, cacheRead: 800 });
  assert.equal(sent[0].model, 'claude-opus-5-5');
  assert.equal(sent[0].fallbacks, 'default');
  assert.equal(sent[0].thinking, undefined, 'Opus 5.5 denkt immer, kein thinking-Parameter');
  assert.equal(sent[1].messages[1].content[0].signature, 'sig1', 'Denkblock unverändert zurück');
  assert.equal(sent[1].messages[2].content[0].type, 'tool_result');
  assert.equal(r.messages.length, 4);
  // Fehler im Werkzeug geht als is_error an Claude, nicht als Absturz
  const rep2 = [{ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name: 'gibtsnicht', input: {} }] }, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }];
  const s2 = [];
  await askMyAfc({ apiKey: 'k', model: 'claude-haiku-5-5', text: 'x', stamp: 's', run: () => { throw new Error('unbekanntes Werkzeug'); }, fetchImpl: async (u, o) => { s2.push(JSON.parse(o.body)); return { ok: true, json: async () => rep2.shift() }; } });
  assert.equal(s2[1].messages[2].content[0].is_error, true);
  assert.equal(s2[0].fallbacks, undefined, 'Haiku ohne Fallback');
  // Ablehnung
  const ref = await askMyAfc({ apiKey: 'k', text: 'x', stamp: 's', run: () => ({}), fetchImpl: async () => ({ ok: true, json: async () => ({ stop_reason: 'refusal', content: [] }) }) });
  assert.equal(ref.refused, true);
  assert.equal(myafcError({ status: 401 }).code, 503);
  assert.match(myafcError({ status: 401 }).msg, /Schlüssel/);
  assert.match(myafcError({ status: 400, message: 'Your credit balance is too low to access the Anthropic API.' }).msg, /Guthaben/);
});

// Ganzer Weg über den Server, Claude durch einen kleinen Ersatz ersetzt
async function fakeClaude() {
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', d => (b += d));
    req.on('end', () => {
      const j = JSON.parse(b);
      bodies.push({ j, key: req.headers['x-api-key'] });
      const last = j.messages.at(-1);
      const out = Array.isArray(last.content) && last.content[0]?.type === 'tool_result'
        ? { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Am Niederhorn sieht es gut aus.' }], usage: { input_tokens: 10, output_tokens: 5 } }
        : { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't' + bodies.length, name: 'startplatz', input: { name: 'Niederhorn', tag: 0 } }], usage: { input_tokens: 10, output_tokens: 5 } };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, bodies, close: () => new Promise(r => srv.close(r)) };
}

async function boot(port, extraEnv) {
  const mock = await startMock('good');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afc-test-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), AFC_DATA_DIR: dir, AFC_OPENMETEO_URL: mock.url, AFC_SMN_URL: mock.url, AFC_STATION_META_URL: mock.url + '/meta_stations.csv', AFC_FETCH_TIMEOUT_MS: '5000', AFC_UPDATE_CHECK: '0', AFC_AIRSPACE_URL: mock.url, AFC_OBSTACLE_URL: mock.url + '/x.kmz', AFC_RADAR_URL: mock.url + '/public/weather-maps.json', XPC_SERVICE_NAME: '', AFC_AUTOSTART: '', AFC_BACKUP_DIR: '', ANTHROPIC_API_KEY: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => (log += d)); child.stderr.on('data', d => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/api/plan'); if (r.status === 200) break; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  return { base, log: () => log, stop: async () => { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); await mock.close(); } };
}

test('Server: ohne Schlüssel aus, mit Schlüssel fragt er Claude, gibt echte Startplatzdaten weiter und zählt', async () => {
  const H = { 'Content-Type': 'application/json', 'X-AFC-Client': 'test-client-0001' };
  const off = await boot(18791, { ANTHROPIC_API_KEY: 'test-key' });   // Schlüssel da, aber pausiert
  try {
    const g = await (await fetch(off.base + '/api/myafc', { headers: H })).json();
    assert.equal(g.enabled, false);
    assert.equal(g.admin, true);
    assert.equal((await fetch(off.base + '/api/myafc', { method: 'POST', headers: H, body: JSON.stringify({ text: 'hallo' }) })).status, 503);
  } finally { await off.stop(); }
  const fc = await fakeClaude();
  const on = await boot(18792, { ANTHROPIC_API_KEY: 'test-key', AFC_MYAFC: '1', AFC_ANTHROPIC_URL: fc.url, AFC_MYAFC_DAILY: '2' });
  try {
    assert.equal((await fetch(on.base + '/api/myafc', { headers: { 'Content-Type': 'application/json' } })).status, 400, 'ohne Client-Kennung');
    const g = await (await fetch(on.base + '/api/myafc', { headers: H })).json();
    assert.equal(g.enabled, true); assert.equal(g.left, 2);
    const r = await fetch(on.base + '/api/myafc', { method: 'POST', headers: H, body: JSON.stringify({ text: 'Soll ich heute aufs Niederhorn?' }) });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j) + on.log());
    assert.equal(j.reply, 'Am Niederhorn sieht es gut aus.');
    assert.deepEqual(j.tools, ['startplatz']);
    assert.equal(j.left, 1);
    assert.equal(fc.bodies[0].key, 'test-key');
    assert.match(fc.bodies[0].j.messages[0].content, /Soll ich heute aufs Niederhorn\?/);
    const tr = JSON.parse(fc.bodies[1].j.messages.at(-1).content[0].content);
    assert.match(tr.name, /Niederhorn/);
    assert.ok(tr.tage[0].stunden.length >= 8, 'Stunden mit Score');
    assert.equal(typeof tr.tage[0].stunden[0].score, 'number');
    // Verlauf bleibt: zweite Frage schickt die erste mit
    const g2 = await (await fetch(on.base + '/api/myafc', { headers: H })).json();
    assert.equal(g2.turns.length, 1);
    await fetch(on.base + '/api/myafc', { method: 'POST', headers: H, body: JSON.stringify({ text: 'Und morgen?' }) });
    assert.ok(fc.bodies.at(-1).j.messages.length >= 5);
    // Tageslimit
    const lim = await fetch(on.base + '/api/myafc', { method: 'POST', headers: H, body: JSON.stringify({ text: 'Und übermorgen?' }) });
    assert.equal(lim.status, 429);
    // neues Gespräch löscht den Verlauf
    await fetch(on.base + '/api/myafc', { method: 'POST', headers: H, body: JSON.stringify({ neu: true }) });
    assert.equal((await (await fetch(on.base + '/api/myafc', { headers: H })).json()).turns.length, 0);
  } finally { await on.stop(); await fc.close(); }
});
