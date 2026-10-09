// AFC 8.0 – Backend: holt Messwerte und Prognosen, rechnet die Bewertung und liefert sie als schlanke JSON-API.
import http from 'node:http';
import fs from 'node:fs/promises';
import fsc from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';

import { toIsoTime, isNum, circularMean, windDiff, mean } from './lib/util.js';
import { LEVELS, DEFAULT_LEVEL } from './lib/scoring.js';
import { fetchForecast, fetchPressureLevels, fetchSecondModel } from './lib/openmeteo.js';
import { loadStationList, fetchObservations, fetchFoehnIndex } from './lib/stations.js';
import { regionalFromObs } from './lib/regional.js';
import { PlanModel, areasOf, isRanked, REF_POINT } from './lib/plan.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER_VERSION = '8.0';
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';          // leer = nur gleiche Herkunft
const PUBLIC_APP = process.env.PUBLIC_APP_URL || '';
const TRUSTED_HOPS = Math.max(0, Number(process.env.AFC_TRUSTED_PROXY_HOPS ?? 1));
const OBS_EVERY_MS = Number(process.env.AFC_OBS_MIN || 10) * 60000;
const FC_EVERY_MS = Number(process.env.AFC_FORECAST_MIN || 30) * 60000;
const MAX_BODY = 16 * 1024;
const DATA = process.env.AFC_DATA_DIR ? path.resolve(process.env.AFC_DATA_DIR) : path.join(ROOT, 'data');

const SITES_FILE = JSON.parse(await fs.readFile(path.join(ROOT, 'lib', 'sites.json'), 'utf8'));
const SITES = SITES_FILE.sites;
const RANKED = SITES.filter(isRanked);
const SITE_IDS = new Set(RANKED.map(s => s.id));
const AREAS = areasOf(SITES.map(s => ({ ...s })));

/* ------------------------------------------------------------------ Speicher */
let dataDir = DATA;
const storageProblem = { degraded: false, reason: null, requested: DATA };
async function prepareStorage(dir) {
  await fs.mkdir(path.join(dir, 'backups'), { recursive: true });
  await fs.access(dir, fsc.constants.W_OK);
}
try { await prepareStorage(DATA); }
catch (e) {
  // Ein Volume gehört beim ersten Start root. Statt abzustürzen läuft AFC mit flüchtigem Speicher weiter.
  const fallback = path.join(os.tmpdir(), 'afc-data');
  console.error(`AFC: Datenverzeichnis ${DATA} nicht beschreibbar (${e.code || e.message}); Ersatzpfad ${fallback}`);
  await prepareStorage(fallback);
  dataDir = fallback;
  Object.assign(storageProblem, { degraded: true, reason: String(e.code || e.message), actual: fallback });
}
const backupsDir = path.join(dataDir, 'backups');
const db = new DatabaseSync(path.join(dataDir, 'afc.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY, code TEXT NOT NULL, time TEXT NOT NULL, wind REAL, gust REAL, dir REAL, temp REAL, rh REAL, pressure REAL, dew REAL, sun REAL, precip REAL, fetched_at TEXT, UNIQUE(code,time));
CREATE TABLE IF NOT EXISTS flight_reports (id INTEGER PRIMARY KEY, client_hash TEXT, reported_at TEXT, site_id TEXT, site_name TEXT, group_name TEXT, launch_time TEXT, launched INTEGER, quality INTEGER, afc_score REAL, afc_decision TEXT, afc_best_time TEXT, learning_features TEXT, note TEXT, site_revision TEXT);
CREATE TABLE IF NOT EXISTS clients (client_hash TEXT PRIMARY KEY, created_at TEXT, last_seen TEXT);
CREATE TABLE IF NOT EXISTS fc_pred (id INTEGER PRIMARY KEY, code TEXT NOT NULL, target TEXT NOT NULL, issued TEXT NOT NULL, lead REAL, wind REAL, gust REAL, dir REAL, temp REAL, UNIQUE(code,target));
CREATE INDEX IF NOT EXISTS idx_obs_code_time ON observations(code,time);
CREATE INDEX IF NOT EXISTS idx_obs_time ON observations(time);
CREATE INDEX IF NOT EXISTS idx_flight_client ON flight_reports(client_hash,reported_at);
CREATE INDEX IF NOT EXISTS idx_pred_target ON fc_pred(target);`);
const dbAll = (sql, p = []) => db.prepare(sql).all(...p);
const dbGet = (sql, p = []) => db.prepare(sql).get(...p);
const dbRun = (sql, p = []) => db.prepare(sql).run(...p);

/* ------------------------------------------------------------------ Zustand */
const ingest = {
  observations: { ok: false, at: null, error: null, source: null, rows: 0 },
  forecast: { ok: false, at: null, error: null, model: null, points: 0 },
  pressure: { ok: false, at: null, error: null },
  ecmwf: { ok: false, at: null, error: null },
  foehn: { ok: false, at: null, error: null },
  stations: { ok: false, at: null, error: null, note: null }
};
const state = {
  raw: null, obs: {}, foehnIndex: {}, regional: null, trend: null,
  stationMeta: {}, stationList: {}, version: 0, model: null, modelAt: 0, payloads: new Map(), quality: null, qualityAt: 0
};

const nowIso = () => new Date().toISOString();
const errMsg = e => String(e?.message || e).slice(0, 400);

/* ------------------------------------------------------------------ Messwerte */
function storeObservations(current) {
  const ins = db.prepare('INSERT OR IGNORE INTO observations(code,time,wind,gust,dir,temp,rh,pressure,dew,sun,precip,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  const at = nowIso(); let n = 0;
  for (const x of Object.values(current)) {
    const t = toIsoTime(x.time);
    if (t) { ins.run(x.code, t, x.wind, x.gust, x.dir, x.temp, x.rh, x.pressure, x.dew, x.sun, x.precip, at); n++; }
  }
  return n;
}
function latestObs() {
  const o = {};
  for (const r of dbAll('SELECT o.* FROM observations o JOIN (SELECT code, MAX(time) t FROM observations GROUP BY code) m ON o.code=m.code AND o.time=m.t')) o[r.code] = r;
  return o;
}
function foehnTrend() {
  const rows = dbAll('SELECT code,time,wind,gust,dir FROM observations WHERE time>=? ORDER BY time', [new Date(Date.now() - 80 * 60000).toISOString()]);
  const by = new Map();
  for (const r of rows) { if (!by.has(r.time)) by.set(r.time, {}); by.get(r.time)[r.code] = r; }
  const times = [...by.keys()].sort();
  if (times.length < 4) return null;
  const s = t => regionalFromObs(by.get(t), {}).foehnScore;
  const last = s(times.at(-1)), first = mean(times.slice(0, 2).map(s));
  return { foehn: last - first };
}

async function collectObservations() {
  const codes = Object.keys(state.stationList);
  try {
    const { data, source } = await fetchObservations(codes);
    const rows = storeObservations(data);
    ingest.observations = { ok: true, at: nowIso(), error: null, source, rows };
  } catch (e) {
    ingest.observations = { ...ingest.observations, ok: false, at: nowIso(), error: errMsg(e) };
  }
  try {
    state.foehnIndex = await fetchFoehnIndex();
    ingest.foehn = { ok: true, at: nowIso(), error: null };
  } catch (e) { ingest.foehn = { ok: false, at: nowIso(), error: errMsg(e) }; }
  state.obs = latestObs();
  state.regional = Object.keys(state.obs).length ? regionalFromObs(state.obs, state.foehnIndex) : null;
  state.trend = foehnTrend();
  invalidate();
}

/* ------------------------------------------------------------------ Prognose */
const sitePoints = () => RANKED.map(s => ({ id: s.id, lat: s.lat, lon: s.lon }));
const areaPoints = () => [...AREAS.map(a => ({ id: a.id, lat: a.lat, lon: a.lon })), REF_POINT];
const stationPoints = () => Object.values(state.stationList).map(s => ({ id: s.code, lat: s.lat, lon: s.lon }));

async function collectForecast() {
  const [sitesR, areaR, plR, ecR, stR] = await Promise.all([
    fetchForecast(sitePoints()), fetchForecast(areaPoints()), fetchPressureLevels(areaPoints()),
    fetchSecondModel(areaPoints().filter(p => p.id !== 'REF').concat([REF_POINT])), fetchForecast(stationPoints(), { days: 2 })
  ]);
  const at = nowIso();
  if (!areaR.byId.REF) {
    ingest.forecast = { ...ingest.forecast, ok: false, at, error: areaR.errors.slice(-3).join(' | ') || 'keine Referenzdaten' };
    return;
  }
  const raw = { fetchedAt: Date.now(), model: areaR.used?.model, sites: sitesR.byId, areas: {}, ref: { sea: areaR.byId.REF, pl: plR.byId.REF || null }, stations: stR.byId };
  for (const a of AREAS) raw.areas[a.id] = { sea: areaR.byId[a.id] || null, pl: plR.byId[a.id] || null, ecmwf: ecR.byId[a.id] || null };
  state.raw = raw;
  const partial = Object.keys(sitesR.byId).length < RANKED.length;
  ingest.forecast = { ok: true, at, error: partial ? `nur ${Object.keys(sitesR.byId).length}/${RANKED.length} Startplätze direkt, Rest über Gebietsmittel` : null, model: sitesR.used?.model || raw.model, points: Object.keys(sitesR.byId).length };
  ingest.pressure = { ok: Object.keys(plR.byId).length > 0, at, error: plR.errors[0] || null };
  ingest.ecmwf = { ok: Object.keys(ecR.byId).length > 0, at, error: ecR.errors[0] || null };
  storePredictions(raw);
  invalidate();
  fs.writeFile(path.join(dataDir, 'raw.json.tmp'), JSON.stringify(raw)).then(() => fs.rename(path.join(dataDir, 'raw.json.tmp'), path.join(dataDir, 'raw.json'))).catch(() => {});
}

/** Prognose für jetzt+3 h je Station festhalten; später mit der Messung verglichen. */
function storePredictions(raw) {
  const target = new Date(Math.round((Date.now() + 3 * 3600000) / 3600000) * 3600000);
  const tIso = target.toISOString();
  const ins = db.prepare('INSERT OR IGNORE INTO fc_pred(code,target,issued,lead,wind,gust,dir,temp) VALUES(?,?,?,?,?,?,?,?)');
  for (const [code, fc] of Object.entries(raw.stations || {})) {
    const i = fc.t.indexOf(target.getTime());
    if (i < 0) continue;
    ins.run(code, tIso, nowIso(), (target - Date.now()) / 3600000, fc.wind_speed_10m?.[i] ?? null, fc.wind_gusts_10m?.[i] ?? null, fc.wind_direction_10m?.[i] ?? null, fc.temperature_2m?.[i] ?? null);
  }
}

/** Prognosegüte je Station (Prognose 3 h voraus gegen Messung, letzte 7 Tage). */
function qualitySummary() {
  if (state.quality && Date.now() - state.qualityAt < 10 * 60000) return state.quality;
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = dbAll('SELECT p.code, p.wind pw, p.gust pg, p.dir pd, p.temp pt, o.wind ow, o.gust og, o.dir od, o.temp ot FROM fc_pred p JOIN observations o ON o.code=p.code AND o.time=p.target WHERE p.target>=?', [since]);
  const by = {};
  for (const r of rows) (by[r.code] ??= []).push(r);
  const out = [];
  for (const [code, rs] of Object.entries(by)) {
    const d = (a, b) => rs.filter(r => isNum(r[a]) && isNum(r[b])).map(r => r[a] - r[b]);
    const mae = a => (a.length ? a.reduce((p, c) => p + Math.abs(c), 0) / a.length : null);
    const wind = d('ow', 'pw');
    const dirs = rs.filter(r => isNum(r.od) && isNum(r.pd) && (r.ow ?? 0) >= 8).map(r => windDiff(r.od, r.pd));
    out.push({
      code, name: state.stationList[code]?.name || code, n: rs.length,
      windMae: mae(wind), windBias: wind.length ? mean(wind) : null, gustMae: mae(d('og', 'pg')), tempMae: mae(d('ot', 'pt')),
      dirMae: dirs.length ? mean(dirs) : null
    });
  }
  out.sort((a, b) => b.n - a.n);
  state.quality = { horizonH: 3, days: 7, stations: out };
  state.qualityAt = Date.now();
  return state.quality;
}

/* ------------------------------------------------------------------ Modell & Antwort-Cache */
function invalidate() { state.version++; state.payloads.clear(); }

function currentModel() {
  const now = Date.now();
  if (!state.raw) return null;
  if (!state.model || state.model.ver !== state.version || now - state.modelAt > 5 * 60000) {
    state.model = new PlanModel({
      now, raw: state.raw, obs: state.obs, stationMeta: state.stationList, regional: state.regional, trend: state.trend,
      sites: SITES, fetchedAt: state.raw.fetchedAt
    });
    state.model.ver = state.version;
    state.modelAt = now;
    state.payloads.clear();
  }
  return state.model;
}

function stationsPayload() {
  const out = [];
  for (const [code, m] of Object.entries(state.stationList)) {
    const o = state.obs[code];
    if (!o) continue;
    const age = Math.round((Date.now() - Date.parse(o.time)) / 60000);
    if (age > 180) continue;
    out.push({ code, name: m.name, lat: m.lat, lon: m.lon, alt: m.alt, wind: o.wind, gust: o.gust, dir: o.dir, temp: o.temp, age });
  }
  return out;
}

function packJson(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  return { body, gz: zlib.gzipSync(body), etag: '"' + crypto.createHash('sha1').update(body).digest('base64url').slice(0, 20) + '"' };
}

function planResponse(levelId) {
  const key = 'plan:' + levelId;
  let p = state.payloads.get(key);
  if (p) return p;
  const model = currentModel();
  if (!model?.ok) return null;
  const payload = model.planPayload(levelId);
  payload.version = SERVER_VERSION;
  payload.sources = ingest;
  payload.stations = stationsPayload();
  payload.quality = qualitySummary();
  payload.siteCount = RANKED.length;
  p = packJson(payload);
  state.payloads.set(key, p);
  return p;
}
function siteResponse(id, levelId) {
  const key = `site:${id}:${levelId}`;
  let p = state.payloads.get(key);
  if (p) return p;
  const model = currentModel();
  const d = model?.siteDetail(id, levelId);
  if (!d) return null;
  p = packJson(d);
  state.payloads.set(key, p);
  return p;
}

/* ------------------------------------------------------------------ HTTP-Hilfen */
const clientIp = req => {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  if (TRUSTED_HOPS > 0 && xf.length) return xf[Math.max(0, xf.length - TRUSTED_HOPS)];
  return req.socket.remoteAddress || 'anon';
};
const buckets = new Map();
function limited(req, kind, limit) {
  const key = kind + ':' + clientIp(req), now = Date.now();
  let v = buckets.get(key);
  if (!v || now - v.start > 60000) v = { start: now, n: 0 };
  v.n++; buckets.set(key, v);
  return v.n > limit;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of buckets) if (n - v.start > 120000) buckets.delete(k); }, 5 * 60000).unref();

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://wmts.geo.admin.ch https://*.tile.openstreetmap.org",
  "connect-src 'self'", "worker-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'self'", "frame-ancestors 'self'", "form-action 'self'"
].join('; ');
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN', 'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()' };
const corsHeaders = req => {
  if (!CORS_ORIGIN) return {};
  const o = req.headers.origin;
  if (CORS_ORIGIN === '*') return { 'Access-Control-Allow-Origin': '*' };
  return o === CORS_ORIGIN ? { 'Access-Control-Allow-Origin': o, Vary: 'Origin' } : {};
};

function sendJson(req, res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC, ...corsHeaders(req) });
  res.end(b);
}
function sendPacked(req, res, p, code = 200) {
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: p.etag, Vary: 'Accept-Encoding', ...SEC, ...corsHeaders(req) };
  if (req.headers['if-none-match'] === p.etag) { res.writeHead(304, h); return res.end(); }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (gz) h['Content-Encoding'] = 'gzip';
  const b = gz ? p.gz : p.body;
  h['Content-Length'] = b.length;
  res.writeHead(code, h);
  res.end(b);
}
async function readBody(req) {
  let s = '';
  for await (const c of req) { s += c; if (Buffer.byteLength(s) > MAX_BODY) throw Object.assign(new Error('payload too large'), { code: 413 }); }
  if (!s) return {};
  try { const j = JSON.parse(s); if (!j || typeof j !== 'object' || Array.isArray(j)) throw 0; return j; }
  catch { throw Object.assign(new Error('invalid json'), { code: 400 }); }
}
const hashClient = v => crypto.createHash('sha256').update(String(v || 'anonymous')).digest('hex').slice(0, 32);
const clientId = req => {
  const v = String(req.headers['x-afc-client'] || '');
  return /^[\w-]{8,64}$/.test(v) ? v : null;
};
const cleanText = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

/* ------------------------------------------------------------------ Statische Dateien */
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8', true]], ['/sw_7.2.js', ['sw.js', 'text/javascript; charset=utf-8', true]],
  ['/manifest.json', ['manifest.json', 'application/manifest+json; charset=utf-8']],
  ['/privacy', ['privacy.html', 'text/html; charset=utf-8']], ['/privacy.html', ['privacy.html', 'text/html; charset=utf-8']],
  ['/icon-192.png', ['icon-192.png', 'image/png']], ['/icon-512.png', ['icon-512.png', 'image/png']]
]);
const fileCache = new Map();
async function serveStatic(req, res, route) {
  const [file, type, isSw] = route;
  try {
    const st = await fs.stat(path.join(ROOT, file));
    let c = fileCache.get(file);
    if (!c || c.mtime !== st.mtimeMs) {
      const buf = await fs.readFile(path.join(ROOT, file));
      const text = /^(text|application\/(manifest|json))/.test(type);
      c = { mtime: st.mtimeMs, buf, gz: text ? zlib.gzipSync(buf) : null, etag: '"' + crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 20) + '"' };
      fileCache.set(file, c);
    }
    const h = { 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: c.etag, Vary: 'Accept-Encoding', ...SEC };
    if (type.startsWith('text/html')) h['Content-Security-Policy'] = CSP;
    if (isSw) h['Service-Worker-Allowed'] = '/';
    if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, h); return res.end(); }
    const gz = c.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (gz) h['Content-Encoding'] = 'gzip';
    const b = gz ? c.gz : c.buf;
    h['Content-Length'] = b.length;
    res.writeHead(200, h);
    res.end(req.method === 'HEAD' ? undefined : b);
  } catch (e) {
    console.error('static', file, e.message);
    sendJson(req, res, 404, { error: 'not found' });
  }
}

/* ------------------------------------------------------------------ Routen */
const validLevel = u => { const l = u.searchParams.get('level') || DEFAULT_LEVEL; return LEVELS[l] ? l : null; };

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...corsHeaders(req), 'Access-Control-Allow-Headers': 'content-type,x-afc-client', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Max-Age': '86400' });
      return res.end();
    }
    if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end('ok'); }

    if (p.startsWith('/api/')) {
      if (limited(req, 'api', 180)) return sendJson(req, res, 429, { error: 'zu viele Anfragen' });
      if (req.method === 'GET' && p === '/api/plan') {
        const level = validLevel(u);
        if (!level) return sendJson(req, res, 400, { error: 'level muss careful, normal oder expert sein' });
        const pk = planResponse(level);
        if (!pk) return sendJson(req, res, 202, { warming: true, message: 'Daten werden gerade geladen', sources: ingest });
        return sendPacked(req, res, pk);
      }
      const m = p.match(/^\/api\/site\/([a-z0-9-]{1,60})$/);
      if (req.method === 'GET' && m) {
        const level = validLevel(u);
        if (!level) return sendJson(req, res, 400, { error: 'level ungültig' });
        if (!SITE_IDS.has(m[1])) return sendJson(req, res, 404, { error: 'Startplatz unbekannt' });
        const pk = siteResponse(m[1], level);
        if (!pk) return sendJson(req, res, 202, { warming: true });
        return sendPacked(req, res, pk);
      }
      if (req.method === 'GET' && p === '/api/health') {
        const row = dbGet('SELECT MAX(time) t FROM observations');
        const obsAge = row?.t ? Math.round((Date.now() - Date.parse(row.t)) / 60000) : null;
        const fcAge = state.raw ? Math.round((Date.now() - state.raw.fetchedAt) / 60000) : null;
        return sendJson(req, res, 200, {
          ok: true, version: SERVER_VERSION, time: nowIso(), node: process.version, uptimeSeconds: Math.round(process.uptime()),
          observationAgeMinutes: obsAge, forecastAgeMinutes: fcAge, dataFresh: obsAge !== null && obsAge <= 90 && fcAge !== null && fcAge <= 180,
          ingest, storageDegraded: storageProblem.degraded,
          storageNote: storageProblem.degraded ? `Volume ${storageProblem.requested} nicht beschreibbar (${storageProblem.reason}); Daten gehen beim Neustart verloren` : null,
          backupCount: (await fs.readdir(backupsDir).catch(() => [])).filter(x => x.endsWith('.sqlite')).length
        });
      }
      if (req.method === 'GET' && p === '/api/meta') {
        return sendJson(req, res, 200, { ok: true, version: SERVER_VERSION, publicApp: PUBLIC_APP || null, sites: RANKED.length, areas: AREAS.length, sitesChecked: SITES_FILE.meta?.checked });
      }
      if (req.method === 'POST' && p === '/api/flight-report') {
        if (limited(req, 'post', 10)) return sendJson(req, res, 429, { error: 'zu viele Anfragen' });
        const cid = clientId(req);
        if (!cid) return sendJson(req, res, 400, { error: 'X-AFC-Client fehlt oder ist ungültig' });
        const b = await readBody(req);
        const launch = toIsoTime(b.launchTime);
        if (!SITE_IDS.has(String(b.siteId))) return sendJson(req, res, 400, { error: 'Startplatz unbekannt' });
        if (!launch) return sendJson(req, res, 400, { error: 'launchTime ungültig' });
        const lt = Date.parse(launch);
        if (lt > Date.now() + 3600000 || lt < Date.now() - 14 * 86400000) return sendJson(req, res, 422, { error: 'Startzeit muss in den letzten 14 Tagen liegen' });
        const quality = Math.round(Number(b.quality));
        if (!(quality >= 1 && quality <= 5)) return sendJson(req, res, 422, { error: 'quality muss 1 bis 5 sein' });
        const score = Number(b.afcScore);
        const h = hashClient(cid), at = nowIso();
        const today = dbGet('SELECT COUNT(*) n FROM flight_reports WHERE client_hash=? AND reported_at>=?', [h, new Date(Date.now() - 86400000).toISOString()]);
        if (today.n >= 20) return sendJson(req, res, 429, { error: 'Tageslimit erreicht' });
        if (dbGet('SELECT id FROM flight_reports WHERE client_hash=? AND site_id=? AND launch_time=?', [h, b.siteId, launch])) return sendJson(req, res, 409, { error: 'Bericht existiert bereits' });
        const site = RANKED.find(s => s.id === b.siteId);
        dbRun('INSERT INTO clients(client_hash,created_at,last_seen) VALUES(?,?,?) ON CONFLICT(client_hash) DO UPDATE SET last_seen=excluded.last_seen', [h, at, at]);
        dbRun('INSERT INTO flight_reports(client_hash,reported_at,site_id,site_name,group_name,launch_time,launched,quality,afc_score,afc_decision,afc_best_time,learning_features,note,site_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [h, at, site.id, site.name, site.area, launch, b.launched ? 1 : 0, quality, score >= 0 && score <= 100 ? Math.round(score) : null, cleanText(b.afcDecision, 40), null, null, cleanText(b.note, 280), SITES_FILE.meta?.checked || null]);
        return sendJson(req, res, 200, { ok: true });
      }
      if (req.method === 'GET' && p === '/api/privacy/export') {
        const cid = clientId(req);
        if (!cid) return sendJson(req, res, 400, { error: 'X-AFC-Client fehlt' });
        return sendJson(req, res, 200, { flightReports: dbAll('SELECT reported_at,site_id,site_name,launch_time,launched,quality,afc_score,afc_decision,note FROM flight_reports WHERE client_hash=?', [hashClient(cid)]) });
      }
      if (req.method === 'DELETE' && p === '/api/privacy/delete') {
        if (limited(req, 'post', 10)) return sendJson(req, res, 429, { error: 'zu viele Anfragen' });
        const cid = clientId(req);
        if (!cid) return sendJson(req, res, 400, { error: 'X-AFC-Client fehlt' });
        const h = hashClient(cid);
        dbRun('DELETE FROM flight_reports WHERE client_hash=?', [h]);
        dbRun('DELETE FROM clients WHERE client_hash=?', [h]);
        return sendJson(req, res, 200, { ok: true });
      }
      return sendJson(req, res, 404, { error: 'not found' });
    }

    const route = STATIC.get(p);
    if (route && (req.method === 'GET' || req.method === 'HEAD')) return serveStatic(req, res, route);
    return sendJson(req, res, 404, { error: 'not found' });
  } catch (e) {
    if (!e.code || typeof e.code !== 'number') console.error(e);
    if (!res.headersSent) return sendJson(req, res, typeof e.code === 'number' ? e.code : 500, { error: typeof e.code === 'number' ? e.message : 'interner Fehler' });
    res.end();
  }
});
server.requestTimeout = 30000;
server.headersTimeout = 35000;

/* ------------------------------------------------------------------ Start */
async function loadSnapshot() {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dataDir, 'raw.json'), 'utf8'));
    if (Date.now() - raw.fetchedAt < 3 * 3600000 && raw.ref?.sea) { state.raw = raw; ingest.forecast = { ...ingest.forecast, ok: true, at: new Date(raw.fetchedAt).toISOString(), model: raw.model, error: 'aus Zwischenspeicher, wird aktualisiert' }; }
  } catch { /* kein Zwischenspeicher */ }
}

let busy = { obs: false, fc: false };
async function tick(kind, fn) {
  if (busy[kind]) return;
  busy[kind] = true;
  try { await fn(); } catch (e) { console.error(kind, errMsg(e)); } finally { busy[kind] = false; }
}

async function maintenance() {
  try {
    const cut = new Date(Date.now() - 30 * 86400000).toISOString();
    dbRun('DELETE FROM observations WHERE time<?', [cut]);
    dbRun('DELETE FROM fc_pred WHERE target<?', [cut]);
    const name = `afc-${nowIso().replace(/[:.]/g, '-')}.sqlite`;
    await backup(db, path.join(backupsDir, name));
    const files = (await fs.readdir(backupsDir)).filter(f => f.endsWith('.sqlite')).sort();
    for (const f of files.slice(0, -14)) await fs.rm(path.join(backupsDir, f), { force: true });
  } catch (e) { console.warn('Wartung', errMsg(e)); }
}

const timers = [];
async function start() {
  await loadSnapshot();
  state.obs = latestObs();
  if (Object.keys(state.obs).length) state.regional = regionalFromObs(state.obs, {});
  await new Promise(r => server.listen(PORT, HOST, r));
  console.log(`AFC ${SERVER_VERSION} läuft auf ${HOST}:${PORT}, Daten in ${dataDir}`);
  // Stationsliste und erste Abrufe nach dem Start, damit der Healthcheck sofort besteht
  (async () => {
    const { list, note } = await loadStationList();
    state.stationList = list;
    ingest.stations = { ok: true, at: nowIso(), error: null, note };
    await tick('obs', collectObservations);
    await tick('fc', collectForecast);
  })().catch(e => console.error('Start', errMsg(e)));
  timers.push(setInterval(() => tick('obs', collectObservations), OBS_EVERY_MS));
  timers.push(setInterval(() => tick('fc', collectForecast), FC_EVERY_MS));
  timers.push(setInterval(maintenance, 24 * 3600000));
  setTimeout(maintenance, 60000).unref();
}

function shutdown(sig) {
  console.log(`${sig}: fahre herunter`);
  timers.forEach(clearInterval);
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', e => console.error('unhandledRejection', errMsg(e)));

if (!process.env.AFC_NO_START) await start();
export { server, state, ingest, collectObservations, collectForecast };
