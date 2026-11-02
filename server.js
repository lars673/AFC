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

import { toIsoTime, isNum, circularMean, windDiff, mean, zurichParts } from './lib/util.js';
import { spawn } from 'node:child_process';
import { LEVELS, DEFAULT_LEVEL } from './lib/scoring.js';
import { fetchForecast, fetchPressureLevels, fetchSecondModel } from './lib/openmeteo.js';
import { loadStationList, fetchObservations, fetchFoehnIndex } from './lib/stations.js';
import { regionalFromObs } from './lib/regional.js';
import { PlanModel, areasOf, isRanked, REF_POINT, FOEHN_POINTS, MOUNTAIN_ALT, LEARN_DAYS, LEARN_MIN_N } from './lib/plan.js';
import { fetchWindGrid, windSlice, thermalSlice, WIND_LEVELS } from './lib/windgrid.js';
import { openMeteoUsage, initOpenMeteoUsage } from './lib/http.js';
import { createUpdater } from './lib/updater.js';
import { cleanFlight, cleanGear, cleanSettings, cleanBackup, flightsCsv, siteFeedback } from './lib/logbook.js';
import { loadVapid, sendPush, cleanSubscription } from './lib/webpush.js';
import { buildNotices, cleanPrefs } from './lib/notify.js';
import { parseOpenAir, clipToBox, bboxOf } from './lib/airspace.js';
import { httpGet } from './lib/http.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SERVER_VERSION = '8.0';
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';          // leer = nur gleiche Herkunft
const PUBLIC_APP = process.env.PUBLIC_APP_URL || '';
const TRUSTED_HOPS = Math.max(0, Number(process.env.AFC_TRUSTED_PROXY_HOPS ?? 1));
const OBS_EVERY_MS = Number(process.env.AFC_OBS_MIN || 10) * 60000;
const FC_EVERY_MS = Number(process.env.AFC_FORECAST_MIN || 60) * 60000;
const WIND_EVERY_MS = Number(process.env.AFC_WINDGRID_MIN || 180) * 60000;
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
// Open-Meteo-Verbrauch über einen Neustart hinweg mitzählen
const usageFile = path.join(dataDir, 'openmeteo-usage.json');
let usageSaveT = null;
initOpenMeteoUsage((() => { try { return JSON.parse(fsc.readFileSync(usageFile, 'utf8')); } catch { return null; } })(),
  u => { clearTimeout(usageSaveT); usageSaveT = setTimeout(() => fs.writeFile(usageFile, JSON.stringify(u)).catch(() => {}), 2000); usageSaveT.unref?.(); });
// Update über die App: nur im Autostart (launchd startet nach dem Beenden neu) und nur vom eigenen Mac aus
const AUTOSTART = process.env.XPC_SERVICE_NAME === 'ch.afc.server' || process.env.AFC_AUTOSTART === '1';
const updater = createUpdater(ROOT, { enabled: process.env.AFC_UPDATE_CHECK !== '0' });
const isLocal = req => /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress || '');
const db = new DatabaseSync(path.join(dataDir, 'afc.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY, code TEXT NOT NULL, time TEXT NOT NULL, wind REAL, gust REAL, dir REAL, temp REAL, rh REAL, pressure REAL, dew REAL, sun REAL, precip REAL, fetched_at TEXT, UNIQUE(code,time));
CREATE TABLE IF NOT EXISTS flight_reports (id INTEGER PRIMARY KEY, client_hash TEXT, reported_at TEXT, site_id TEXT, site_name TEXT, group_name TEXT, launch_time TEXT, launched INTEGER, quality INTEGER, afc_score REAL, afc_decision TEXT, afc_best_time TEXT, learning_features TEXT, note TEXT, site_revision TEXT);
CREATE TABLE IF NOT EXISTS clients (client_hash TEXT PRIMARY KEY, created_at TEXT, last_seen TEXT);
CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, keys TEXT NOT NULL, prefs TEXT NOT NULL, created TEXT, last_ok TEXT, last_error TEXT);
CREATE TABLE IF NOT EXISTS push_sent (endpoint TEXT NOT NULL, key TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(endpoint,key));
CREATE TABLE IF NOT EXISTS logbook (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated TEXT, PRIMARY KEY(kind,id));
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
  stations: { ok: false, at: null, error: null, note: null },
  windgrid: { ok: false, at: null, error: null },
  airspace: { ok: false, at: null, error: null, count: 0 }
};
const state = {
  raw: null, windgrid: null, obs: {}, foehnIndex: {}, regional: null, trend: null,
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
  // Föhnregel: Druck Lugano und Zürich-Kloten (2 Orte, kaum Verbrauch)
  const gradR = await fetchForecast(FOEHN_POINTS).catch(() => ({ byId: {} }));
  const at = nowIso();
  if (!areaR.byId.REF) {
    ingest.forecast = { ...ingest.forecast, ok: false, at, error: areaR.errors.slice(-3).join(' | ') || 'keine Referenzdaten' };
    return;
  }
  const raw = { fetchedAt: Date.now(), model: areaR.used?.model, sites: sitesR.byId, areas: {}, ref: { sea: areaR.byId.REF, pl: plR.byId.REF || null }, stations: stR.byId, grad: gradR.byId };
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

/* ------------------------------------------------------------------ Windkarte */
/* ---- Lufträume (SHV/FSVL, OpenAir, Meter) einmal täglich; bei Fehlern die letzte gespeicherte Datei */
const AIR_BASE = () => (process.env.AFC_AIRSPACE_URL || 'https://airspace.shv-fsvl.ch').replace(/\/$/, '');
const AIR_FILES = [['air', '/downloads/switzerland-airspace-metric.txt'], ['wild', '/downloads/switzerland-wildlife-meters.txt']];
const AIR_BOX = [46.0, 6.6, 47.2, 8.9];   // Berner Oberland mit Rand
const decodeText = buf => { const t = new TextDecoder('utf-8').decode(buf); return t.includes('\uFFFD') ? new TextDecoder('latin1').decode(buf) : t; };
async function collectAirspace() {
  const items = [], errors = [];
  for (const [kind, file] of AIR_FILES) {
    const local = path.join(dataDir, 'airspace-' + kind + '.txt');
    let text = null;
    try {
      text = decodeText(new Uint8Array(await (await httpGet(AIR_BASE() + file, { timeoutMs: 30000 })).arrayBuffer()));
      if (!/^\s*AC\s/m.test(text)) throw new Error('keine OpenAir-Datei');
      await fs.writeFile(local, text);
    } catch (e) {
      errors.push(errMsg(e));
      text = await fs.readFile(local, 'utf8').catch(() => null);
    }
    if (!text) continue;
    for (const a of clipToBox(parseOpenAir(text), AIR_BOX)) items.push({ ...a, kind: kind === 'wild' ? 'wild' : a.kind });
  }
  if (items.length) {
    const round = v => Math.round(v * 1e5) / 1e5;
    state.airspace = packJson({ ok: true, at: nowIso(), source: 'SHV/FSVL airspace.shv-fsvl.ch', items: items.map(a => ({ n: a.name, c: a.cls, t: a.type || undefined, k: a.kind, f: a.freq, lo: a.lo, hi: a.hi, b: bboxOf(a.poly).map(round), p: a.poly.map(([la, lo]) => [round(la), round(lo)]) })) });
    const by = items.reduce((m, a) => ((m[a.kind] = (m[a.kind] || 0) + 1), m), {});
    console.log(`Lufträume: ${items.length} (${Object.entries(by).map(([k, v]) => k + ' ' + v).join(', ')})${errors.length ? ', aus Zwischenspeicher: ' + errors.join('; ') : ''}`);
  }
  ingest.airspace = { ok: items.length > 0, at: nowIso(), error: errors.length ? errors.join('; ') : null, count: items.length };
}

async function collectWindGrid() {
  try {
    const wg = await fetchWindGrid();
    state.windgrid = wg;
    for (const k of [...state.payloads.keys()]) if (k.startsWith('wind:') || k.startsWith('thermal:')) state.payloads.delete(k);
    ingest.windgrid = { ok: true, at: nowIso(), error: null };
    fs.writeFile(path.join(dataDir, 'windgrid.json.tmp'), JSON.stringify(wg)).then(() => fs.rename(path.join(dataDir, 'windgrid.json.tmp'), path.join(dataDir, 'windgrid.json'))).catch(() => {});
  } catch (e) {
    ingest.windgrid = { ...ingest.windgrid, ok: !!state.windgrid, at: nowIso(), error: errMsg(e) };
  }
}
function windResponse(ms, level) {
  const hourMs = Math.round(ms / 3600000) * 3600000;
  const key = `wind:${level}:${hourMs}`;
  let p = state.payloads.get(key);
  if (p) return p;
  const sl = windSlice(state.windgrid, hourMs, level);
  if (!sl) return null;
  p = packJson(sl);
  state.payloads.set(key, p);
  return p;
}
function thermalResponse(ms) {
  const hourMs = Math.round(ms / 3600000) * 3600000;
  const key = `thermal:${hourMs}`;
  let p = state.payloads.get(key);
  if (p) return p;
  const sl = thermalSlice(state.windgrid, hourMs);
  if (!sl) return null;
  p = packJson(sl);
  state.payloads.set(key, p);
  return p;
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

/**
 * Selbst nachkalibrieren: Böen- und Windfehler der Bergstationen (Prognose 3 h voraus gegen Messung,
 * letzte 14 Tage, 9–17 Uhr). Plus = gemessen mehr als prognostiziert. Das Modell hebt damit die Böen an.
 */
function learnedBias() {
  if (state.learned && Date.now() - state.learnedAt < 3600000) return state.learned;
  const since = new Date(Date.now() - LEARN_DAYS * 86400000).toISOString();
  const rows = dbAll('SELECT p.code, p.target, p.wind pw, p.gust pg, o.wind ow, o.gust og FROM fc_pred p JOIN observations o ON o.code=p.code AND o.time=p.target WHERE p.target>=?', [since]);
  const by = {};
  for (const r of rows) {
    const m = state.stationList[r.code];
    if (!m || !(m.alt >= MOUNTAIN_ALT) || !isNum(r.og) || !isNum(r.pg)) continue;
    const h = zurichParts(Date.parse(r.target)).hour;
    if (h < 9 || h > 17) continue;
    const b = (by[r.code] ??= { gust: [], wind: [] });
    b.gust.push(r.og - r.pg);
    if (isNum(r.ow) && isNum(r.pw)) b.wind.push(r.ow - r.pw);
  }
  state.learned = Object.fromEntries(Object.entries(by).map(([c, b]) => [c, { n: b.gust.length, gust: Math.round(mean(b.gust) * 10) / 10, wind: b.wind.length ? Math.round(mean(b.wind) * 10) / 10 : null }]));
  state.learnedAt = Date.now();
  return state.learned;
}

/* ------------------------------------------------------------------ Modell & Antwort-Cache */
function invalidate() { state.version++; state.payloads.clear(); }

function currentModel() {
  const now = Date.now();
  if (!state.raw) return null;
  if (!state.model || state.model.ver !== state.version || now - state.modelAt > 5 * 60000) {
    state.model = new PlanModel({
      now, raw: state.raw, obs: state.obs, stationMeta: state.stationList, regional: state.regional, trend: state.trend, learned: learnedBias(),
      feedback: siteFeedback(dbAll("SELECT data FROM logbook WHERE kind='flight'").map(r => JSON.parse(r.data))),
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
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://wmts.geo.admin.ch https://*.tile.openstreetmap.org https://thermal.kk7.ch",
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
async function readBody(req, max = MAX_BODY) {
  let s = '';
  for await (const c of req) { s += c; if (Buffer.byteLength(s) > max) throw Object.assign(new Error('payload too large'), { code: 413 }); }
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
  ['/pilot.js', ['lib/pilot.js', 'text/javascript; charset=utf-8']],
  ['/route.js', ['lib/route.js', 'text/javascript; charset=utf-8']],
  ['/airspace.js', ['lib/airspace.js', 'text/javascript; charset=utf-8']],
  ['/logbook.js', ['lib/logbook.js', 'text/javascript; charset=utf-8']],
  ['/igc.js', ['lib/igc.js', 'text/javascript; charset=utf-8']],
  ['/terrain-grid.bin', ['lib/terrain-grid.bin', 'application/octet-stream']],
  ['/icon-192.png', ['icon-192.png', 'image/png']], ['/icon-512.png', ['icon-512.png', 'image/png']],
  // Leaflet liegt im Projekt: Karte lädt vom eigenen Rechner, auch ohne cdnjs (Handy über Tailscale)
  ['/vendor/leaflet/leaflet.js', ['vendor/leaflet/leaflet.js', 'text/javascript; charset=utf-8']],
  ['/vendor/leaflet/leaflet.css', ['vendor/leaflet/leaflet.css', 'text/css; charset=utf-8']],
  ...['layers', 'layers-2x', 'marker-icon', 'marker-icon-2x', 'marker-shadow'].map(n => [`/vendor/leaflet/images/${n}.png`, [`vendor/leaflet/images/${n}.png`, 'image/png']])
]);
const fileCache = new Map();
async function serveStatic(req, res, route) {
  const [file, type, isSw] = route;
  try {
    const st = await fs.stat(path.resolve(ROOT, file));
    let c = fileCache.get(file);
    if (!c || c.mtime !== st.mtimeMs) {
      const buf = await fs.readFile(path.resolve(ROOT, file));
      const text = /^(text|application\/(manifest|json|octet-stream))/.test(type);   // Geländeraster komprimiert sich gut
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
      res.writeHead(204, { ...corsHeaders(req), 'Access-Control-Allow-Headers': 'content-type,x-afc-client', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Max-Age': '86400' });
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
      if (req.method === 'GET' && p === '/api/wind') {
        const level = u.searchParams.get('level') || '10m';
        const t = Date.parse(u.searchParams.get('t') || '') || Date.now();
        if (!WIND_LEVELS[level]) return sendJson(req, res, 400, { error: 'level muss 10m, 800 oder 700 sein' });
        if (!state.windgrid) return sendJson(req, res, 202, { warming: true });
        const pk = windResponse(t, level);
        if (!pk) return sendJson(req, res, 404, { error: 'keine Winddaten für diese Zeit' });
        return sendPacked(req, res, pk);
      }
      if (req.method === 'GET' && p === '/api/thermal') {
        const t = Date.parse(u.searchParams.get('t') || '') || Date.now();
        if (!state.windgrid?.thermal) return sendJson(req, res, 202, { warming: true });
        const pk = thermalResponse(t);
        if (!pk) return sendJson(req, res, 404, { error: 'keine Thermikdaten für diese Zeit' });
        return sendPacked(req, res, pk);
      }
      if (req.method === 'GET' && p === '/api/airspace') {
        if (!state.airspace) return sendJson(req, res, 202, { warming: true, error: ingest.airspace.error });
        return sendPacked(req, res, state.airspace);
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
      if (req.method === 'GET' && p === '/api/status') {
        // Verbrauch und Update-Stand für die Anzeige unter Profil
        return sendJson(req, res, 200, { ok: true, version: SERVER_VERSION, openMeteo: openMeteoUsage(), update: { ...updater.status(), canApply: AUTOSTART && isLocal(req) }, backtest: backtestStatus(), learned: learnedList(), awake: awakeStatus(), problems: healthProblems().map(p => ({ id: p.id, title: p.title, body: p.body })) });
      }
      if (req.method === 'POST' && p === '/api/backtest') {
        if (!isLocal(req) || req.headers['x-afc-client'] === undefined) return sendJson(req, res, 403, { error: 'nur auf diesem Rechner' });
        return sendJson(req, res, 200, { ok: true, started: maybeBacktest(true), ...backtestStatus() });
      }
      if (req.method === 'POST' && p === '/api/update') {
        if (!isLocal(req) || !AUTOSTART) return sendJson(req, res, 403, { error: 'Update nur auf dem eigenen Mac mit eingerichtetem Autostart' });
        if (req.headers['x-afc-client'] === undefined) return sendJson(req, res, 400, { error: 'Kopfzeile fehlt' });
        const r = await updater.apply();
        if (!r.ok) return sendJson(req, res, 500, { error: r.error });
        sendJson(req, res, 200, { ok: true, restarting: true });
        // launchd startet den Dienst nach dem Beenden mit der neuen Version wieder
        setTimeout(() => shutdown('Update'), 300);
        return;
      }
      if (req.method === 'POST' && p === '/api/update/check') {
        if (!isLocal(req)) return sendJson(req, res, 403, { error: 'nur lokal' });
        return sendJson(req, res, 200, { ok: true, update: { ...(await updater.check()), canApply: AUTOSTART } });
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
      // Benachrichtigungen (Web Push) an die installierte App
      if (p.startsWith('/api/push/')) {
        if (!clientId(req)) return sendJson(req, res, 400, { error: 'X-AFC-Client fehlt' });
        if (req.method === 'GET' && p === '/api/push/key') return sendJson(req, res, 200, { ok: true, enabled: PUSH_ON, publicKey: PUSH_ON ? vapid().publicKey : null });
        if (req.method !== 'POST') return sendJson(req, res, 405, { error: 'Methode nicht erlaubt' });
        if (limited(req, 'post', 30)) return sendJson(req, res, 429, { error: 'zu viele Anfragen' });
        const b = await readBody(req);
        if (p === '/api/push/subscribe') {
          if (!PUSH_ON) return sendJson(req, res, 503, { error: 'Benachrichtigungen sind ausgeschaltet' });
          const sub = cleanSubscription(b.subscription);
          if (!sub) return sendJson(req, res, 400, { error: 'Ungültiges Abo' });
          const prefs = cleanPrefs(b.prefs);
          dbRun('INSERT INTO push_subs(endpoint,keys,prefs,created) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET keys=excluded.keys, prefs=excluded.prefs', [sub.endpoint, JSON.stringify(sub.keys), JSON.stringify(prefs), nowIso()]);
          return sendJson(req, res, 200, { ok: true, prefs });
        }
        const row = dbGet('SELECT * FROM push_subs WHERE endpoint=?', [String(b.endpoint || '')]);
        if (p === '/api/push/unsubscribe') {
          dbRun('DELETE FROM push_subs WHERE endpoint=?', [String(b.endpoint || '')]);
          dbRun('DELETE FROM push_sent WHERE endpoint=?', [String(b.endpoint || '')]);
          return sendJson(req, res, 200, { ok: true });
        }
        if (p === '/api/push/test') {
          if (!row) return sendJson(req, res, 404, { error: 'Dieses Gerät ist nicht angemeldet' });
          const r = await pushTo(row, { title: 'AFC-Test', body: 'Benachrichtigungen funktionieren. So meldet sich AFC bei einem guten Flugtag, bei Föhn und wenn der Retter gepackt werden muss.', url: '/', tag: 'test' });
          return sendJson(req, res, r.ok ? 200 : 502, r.ok ? { ok: true } : { error: r.gone ? 'Das Abo ist abgelaufen, bitte neu einschalten' : `Push-Dienst antwortet nicht (${r.status || r.error})` });
        }
        if (p === '/api/push/run' && pushFetch) return sendJson(req, res, 200, { ok: true, sent: b.phase === 'health' ? await healthTick(Date.now(), b.hour) : await pushTick(b.phase) });   // nur in den Tests
        if (p === '/api/push/status') {
          return sendJson(req, res, 200, { ok: true, enabled: PUSH_ON, subscribed: !!row, prefs: row ? JSON.parse(row.prefs) : null, lastOk: row?.last_ok || null, lastError: row?.last_error || null });
        }
        return sendJson(req, res, 404, { error: 'unbekannt' });
      }
      // Flugbuch (persönlich, bleibt auf diesem Rechner): Flüge, Ausrüstung, Einstellungen
      if (p === '/api/logbook' || p.startsWith('/api/logbook/')) {
        if (!clientId(req)) return sendJson(req, res, 400, { error: 'X-AFC-Client fehlt' });
        if (req.method === 'GET' && p === '/api/logbook') return sendJson(req, res, 200, { ok: true, ...logbookData(), backup: lbBackupStatus() });
        if (req.method === 'GET' && (p === '/api/logbook/export.json' || p === '/api/logbook/export.csv')) {
          const file = logbookFile(), csv = p.endsWith('.csv');
          const day = file.exportedAt.slice(0, 10);
          res.writeHead(200, { 'Content-Type': csv ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="AFC-Flugbuch-${day}.${csv ? 'csv' : 'json'}"`, 'Cache-Control': 'no-store', ...SEC, ...corsHeaders(req) });
          return res.end(csv ? flightsCsv(file.flights, file.gear) : JSON.stringify(file, null, 1));
        }
        if (req.method === 'POST' && p === '/api/logbook/backup') {
          if (limited(req, 'post', 20)) return sendJson(req, res, 429, { error: 'zu viele Anfragen' });
          await backupLogbook();
          return sendJson(req, res, 200, { ok: true, backup: lbBackupStatus() });
        }
        if (req.method === 'POST' && p === '/api/logbook/import') {
          // Sicherung einspielen: Flüge und Ausrüstung nach id zusammenführen, nichts wird gelöscht
          if (limited(req, 'post', 20)) return sendJson(req, res, 429, { error: 'zu viele Anfragen' });
          const b = cleanBackup(await readBody(req, 30 * 1024 * 1024));
          if (!b) return sendJson(req, res, 400, { error: 'Das ist keine AFC-Flugbuch-Sicherung' });
          await backup(db, path.join(backupsDir, `afc-vor-import-${nowIso().replace(/[:.]/g, '-')}.sqlite`));
          const has = new Set(dbAll("SELECT kind||'/'||id k FROM logbook").map(r => r.k));
          const n = { added: 0, updated: 0, gear: 0 };
          const put = (kind, id, item) => dbRun('INSERT INTO logbook(kind,id,data,updated) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data, updated=excluded.updated', [kind, id, JSON.stringify(item), nowIso()]);
          db.exec('BEGIN');
          try {
            for (const f of b.flights) { n[has.has('flight/' + f.id) ? 'updated' : 'added']++; put('flight', f.id, f); }
            for (const g of b.gear) { n.gear++; put('gear', g.id, g); }
            if (b.settings && !has.has('settings/main')) put('settings', 'main', b.settings);
            db.exec('COMMIT');
          } catch (e) { db.exec('ROLLBACK'); throw e; }
          backupLogbookSoon();
          return sendJson(req, res, 200, { ok: true, ...n });
        }
        const lm = p.match(/^\/api\/logbook\/(flight|gear|settings)\/([\w-]{1,40})$/);
        if (!lm) return sendJson(req, res, 404, { error: 'unbekannt' });
        if (limited(req, 'post', 120)) return sendJson(req, res, 429, { error: 'zu viele Anfragen' });
        const [, kind, lid] = lm;
        if (req.method === 'DELETE') { dbRun('DELETE FROM logbook WHERE kind=? AND id=?', [kind, lid]); backupLogbookSoon(); return sendJson(req, res, 200, { ok: true }); }
        if (req.method === 'PUT') {
          const body = await readBody(req, 64 * 1024);   // Flug mit vereinfachter IGC-Spur
          const item = kind === 'flight' ? cleanFlight({ ...body, id: lid }) : kind === 'gear' ? cleanGear({ ...body, id: lid }) : cleanSettings(body);
          if (!item) return sendJson(req, res, 400, { error: kind === 'flight' ? 'Datum fehlt' : 'Art der Ausrüstung fehlt' });
          dbRun('INSERT INTO logbook(kind,id,data,updated) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data, updated=excluded.updated', [kind, kind === 'settings' ? 'main' : lid, JSON.stringify(item), nowIso()]);
          backupLogbookSoon();
          return sendJson(req, res, 200, { ok: true, item });
        }
        return sendJson(req, res, 405, { error: 'Methode nicht erlaubt' });
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

    if (p === '/kk7-grid.bin' && (req.method === 'GET' || req.method === 'HEAD')) {
      // Thermik aus Flügen (kk7, CC BY-NC-SA): wird lokal von tools/calibrate-kk7.js erzeugt, nicht im Repository
      if (!fsc.existsSync(path.join(dataDir, 'kk7-grid.bin'))) return sendJson(req, res, 404, { error: 'kein kk7-Abgleich vorhanden' });
      return serveStatic(req, res, [path.join(dataDir, 'kk7-grid.bin'), 'application/octet-stream']);
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
  try {
    const wg = JSON.parse(await fs.readFile(path.join(dataDir, 'windgrid.json'), 'utf8'));
    if (Date.now() - wg.fetchedAt < 8 * 3600000 && wg.levels) { state.windgrid = wg; ingest.windgrid = { ok: true, at: new Date(wg.fetchedAt).toISOString(), error: 'aus Zwischenspeicher, wird aktualisiert' }; }
  } catch { /* kein Zwischenspeicher */ }
}

let busy = { obs: false, fc: false, wind: false };
async function tick(kind, fn) {
  if (busy[kind]) return;
  busy[kind] = true;
  try { await fn(); } catch (e) { console.error(kind, errMsg(e)); } finally { busy[kind] = false; }
}

/* ------------------------------------------------------------------ Benachrichtigungen */
// Abends (19–21 Uhr) der Ausblick auf morgen, morgens (7–9 Uhr) Föhn heute und fällige Ausrüstung.
// Jede Meldung geht je Gerät nur einmal raus (push_sent).
const PUSH_ON = process.env.AFC_PUSH !== '0';
let vapidKeys = null;
const vapid = () => (vapidKeys ||= loadVapid(path.join(dataDir, 'vapid.json')));
// Nur für die Tests: Push-Dienst durch einen lokalen Empfänger ersetzen
const pushFetch = process.env.AFC_PUSH_TEST_URL ? (u, o) => fetch(process.env.AFC_PUSH_TEST_URL + new URL(u).pathname, o) : undefined;
async function pushTo(row, msg) {
  const r = await sendPush({ endpoint: row.endpoint, keys: JSON.parse(row.keys) }, msg, vapid(), pushFetch ? { fetchImpl: pushFetch } : {});
  if (r.gone) { dbRun('DELETE FROM push_subs WHERE endpoint=?', [row.endpoint]); dbRun('DELETE FROM push_sent WHERE endpoint=?', [row.endpoint]); }
  else dbRun('UPDATE push_subs SET last_ok=COALESCE(?,last_ok), last_error=? WHERE endpoint=?', [r.ok ? nowIso() : null, r.ok ? null : `${nowIso()} ${r.status || r.error}`, row.endpoint]);
  return r;
}
function pushPhase(ms = Date.now()) {
  const h = zurichParts(ms).hour;
  return h >= 19 && h <= 21 ? 'evening' : h >= 7 && h <= 9 ? 'morning' : null;
}
async function pushTick(phase = pushPhase()) {
  if (!PUSH_ON || !phase) return 0;
  const subs = dbAll('SELECT * FROM push_subs');
  if (!subs.length) return 0;
  const model = currentModel();
  if (!model?.ok) return 0;
  const lb = logbookData();
  const plans = {};
  let sent = 0;
  for (const row of subs) {
    const prefs = cleanPrefs(JSON.parse(row.prefs));
    const plan = plans[prefs.level] ||= model.planPayload(prefs.level);
    for (const n of buildNotices({ phase, plan, prefs, gear: lb.gear, flights: lb.flights })) {
      if (dbGet('SELECT 1 x FROM push_sent WHERE endpoint=? AND key=?', [row.endpoint, n.key])) continue;
      const r = await pushTo(row, n);
      if (r.gone) break;
      if (r.ok) { dbRun('INSERT OR IGNORE INTO push_sent(endpoint,key,at) VALUES(?,?,?)', [row.endpoint, n.key, nowIso()]); sent++; }
    }
  }
  dbRun('DELETE FROM push_sent WHERE at<?', [new Date(Date.now() - 90 * 86400000).toISOString()]);
  return sent;
}

/* ------------------------------------------------------------------ Selbstüberwachung */
// Zwischen 6 und 22 Uhr alle 10 Minuten: Sind die Wetterdaten frisch, klappt die Sicherung, reicht das Gratis-Kontingent?
// Bei einem Problem kommt eine Meldung aufs iPhone (einmal pro Tag und Art), und eine zweite, sobald es wieder läuft.
const healthAlerted = new Map();   // id -> Zeitpunkt der Meldung
function healthProblems(now = Date.now()) {
  const out = [];
  if (process.uptime() < Number(process.env.AFC_HEALTH_GRACE_MIN ?? 30) * 60) return out;   // nach dem Start erst Daten holen lassen
  const fcAge = state.raw ? (now - state.raw.fetchedAt) / 3600000 : Infinity;
  if (fcAge > 4) out.push({ id: 'forecast', title: 'AFC: Prognose veraltet', body: `Die Wetterprognose ist ${Number.isFinite(fcAge) ? Math.round(fcAge) + ' Stunden alt' : 'nicht geladen'}${ingest.forecast?.error ? ` (${String(ingest.forecast.error).slice(0, 80)})` : ''}. Die Bewertungen sind nicht aktuell, bitte nicht darauf verlassen.` });
  const t = dbGet('SELECT MAX(time) t FROM observations')?.t;
  const obsAge = t ? (now - Date.parse(t)) / 3600000 : Infinity;
  if (obsAge > 3) out.push({ id: 'obs', title: 'AFC: Messwerte fehlen', body: `Die letzten Messwerte der Stationen sind ${Number.isFinite(obsAge) ? Math.round(obsAge) + ' Stunden alt' : 'nicht vorhanden'}. Föhn und Wind am Berg werden nicht live geprüft.` });
  if (lbBackup.error) out.push({ id: 'backup', title: 'AFC: Flugbuch-Sicherung fehlgeschlagen', body: `Die Sicherung auf dem Mac hat nicht geklappt (${lbBackup.error}). Bitte im Flugbuch «Sicherungsdatei» antippen und die Datei selbst aufbewahren.` });
  if (storageProblem.degraded) out.push({ id: 'storage', title: 'AFC: Speicher nicht beschreibbar', body: 'AFC speichert gerade nur vorübergehend. Bitte auf dem Mac «AFC neu starten» doppelklicken.' });
  const u = openMeteoUsage();
  if (u.limitDay && u.calls >= u.limitDay * 0.9) out.push({ id: 'quota', title: 'AFC: Gratis-Kontingent fast aufgebraucht', body: `Open-Meteo: ${u.calls} von ${u.limitDay} Aufrufen heute. Wird es überschritten, fehlen bis Mitternacht neue Prognosen.` });
  return out;
}
async function healthTick(now = Date.now(), hour = null) {
  const h = hour ?? zurichParts(now).hour;
  if (!PUSH_ON || h < 6 || h >= 22) return 0;
  const subs = dbAll('SELECT * FROM push_subs').filter(r => cleanPrefs(JSON.parse(r.prefs)).health);
  const probs = healthProblems(now), ids = new Set(probs.map(p => p.id)), day = zurichParts(now).date;
  const msgs = [];
  for (const p of probs) if (!healthAlerted.has(p.id) || healthAlerted.get(p.id) !== day) { msgs.push({ ...p, key: `health:${p.id}:${day}`, tag: 'health-' + p.id, url: '/?tab=profile' }); healthAlerted.set(p.id, day); }
  for (const id of [...healthAlerted.keys()]) if (!ids.has(id)) { healthAlerted.delete(id); msgs.push({ key: `health:${id}:ok:${now}`, tag: 'health-' + id, title: 'AFC läuft wieder normal', body: { forecast: 'Die Prognose ist wieder aktuell.', obs: 'Die Messwerte kommen wieder.', backup: 'Die Flugbuch-Sicherung klappt wieder.', storage: 'Der Speicher ist wieder in Ordnung.', quota: 'Das Kontingent ist wieder frei.' }[id] || 'Das Problem ist behoben.', url: '/' }); }
  let sent = 0;
  for (const row of subs) for (const m of msgs) { const r = await pushTo(row, m); if (r.ok) sent++; if (r.gone) break; }
  return sent;
}

/* ------------------------------------------------------------------ Mac wach halten */
// Tagsüber (6–22 Uhr) verhindert AFC, dass der Mac von selbst einschläft (caffeinate, nur wenn AFC als Autostart läuft).
// Bildschirm darf aus gehen. Zugeklappt schläft ein MacBook trotzdem. Morgens wecken: tools/«AFC wach halten einrichten».
const STAY_AWAKE = process.platform === 'darwin' && AUTOSTART && process.env.AFC_STAY_AWAKE !== '0';
const awake = { active: false, until: null, error: null, child: null };
function awakeTick(now = Date.now()) {
  if (!STAY_AWAKE || awake.child) return;
  const h = zurichParts(now).hour;
  if (h < 6 || h >= 22) return;
  const end = new Date(now); end.setHours(22, 0, 0, 0);   // Mac läuft in Schweizer Zeit
  const secs = Math.max(60, Math.round((end - now) / 1000));
  try {
    const c = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid), '-t', String(secs)], { stdio: 'ignore' });
    awake.child = c; awake.active = true; awake.until = end.toISOString(); awake.error = null;
    c.on('exit', () => { awake.child = null; awake.active = false; });
    c.on('error', e => { awake.child = null; awake.active = false; awake.error = String(e.code || e.message); });
  } catch (e) { awake.error = String(e.code || e.message); }
}
const awakeStatus = () => ({ enabled: STAY_AWAKE, active: awake.active, until: awake.until, error: awake.error });

/* ------------------------------------------------------------------ Flugbuch-Sicherung */
// Täglich (und kurz nach jeder Änderung) eine Kopie des Flugbuchs als JSON (zum Einspielen) und CSV (Tabelle):
// immer in data/backups/flugbuch, zusätzlich in iCloud Drive (Ordner «AFC-Sicherung»), wenn es auf dem Mac eingerichtet ist.
const ICLOUD = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
function cloudBackupDir() {
  if (process.env.AFC_BACKUP_DIR !== undefined) return process.env.AFC_BACKUP_DIR ? path.resolve(process.env.AFC_BACKUP_DIR) : null;
  return fsc.existsSync(ICLOUD) ? path.join(ICLOUD, 'AFC-Sicherung') : null;
}
const LB_KEEP = 30;
const lbBackup = { at: null, flights: 0, local: null, cloud: null, cloudDir: cloudBackupDir(), cloudError: null, error: null };
// Stand der letzten Sicherung nach einem Neustart aus den Dateien lesen
function lastBackupFile(dir) {
  try {
    const f = fsc.readdirSync(dir).filter(x => /^flugbuch-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().at(-1);
    return f ? path.join(dir, f) : null;
  } catch { return null; }
}
try {
  const f = lastBackupFile(path.join(backupsDir, 'flugbuch'));
  if (f) Object.assign(lbBackup, { at: fsc.statSync(f).mtime.toISOString(), flights: JSON.parse(fsc.readFileSync(f, 'utf8')).flights.length });
  const c = lbBackup.cloudDir && lastBackupFile(lbBackup.cloudDir);
  if (c) lbBackup.cloud = fsc.statSync(c).mtime.toISOString();
} catch { /* ohne Vorgeschichte weiter */ }
function logbookData() {
  const pick = k => dbAll('SELECT data FROM logbook WHERE kind=?', [k]).map(r => JSON.parse(r.data));
  return { flights: pick('flight').sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start)), gear: pick('gear'), settings: cleanSettings(pick('settings')[0] || {}) };
}
const logbookFile = () => ({ app: 'AFC', type: 'flugbuch', version: 1, exportedAt: nowIso(), ...logbookData() });
async function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}
async function writeBackupSet(dir, day, file, csv) {
  await fs.mkdir(dir, { recursive: true });
  await writeAtomic(path.join(dir, `flugbuch-${day}.json`), JSON.stringify(file, null, 1));
  await writeAtomic(path.join(dir, 'flugbuch-tabelle.csv'), csv);
  const old = (await fs.readdir(dir)).filter(f => /^flugbuch-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of old.slice(0, -LB_KEEP)) await fs.rm(path.join(dir, f), { force: true });
}
async function backupLogbook() {
  const file = logbookFile();
  if (!file.flights.length && !file.gear.length) return lbBackup;   // leeres Flugbuch: nichts zu sichern
  const day = zurichParts(Date.now()).date;
  const csv = flightsCsv(file.flights, file.gear);
  const local = path.join(backupsDir, 'flugbuch');
  try { await writeBackupSet(local, day, file, csv); lbBackup.error = null; }
  catch (e) { lbBackup.error = String(e.code || e.message); throw e; }
  Object.assign(lbBackup, { at: nowIso(), flights: file.flights.length, local, cloudDir: cloudBackupDir() });
  if (lbBackup.cloudDir) {
    try { await writeBackupSet(lbBackup.cloudDir, day, file, csv); lbBackup.cloud = nowIso(); lbBackup.cloudError = null; }
    catch (e) { lbBackup.cloudError = e.code === 'EPERM' || e.code === 'EACCES' ? 'kein Zugriff (macOS-Berechtigung)' : String(e.code || e.message); console.warn('Flugbuch-Sicherung iCloud', errMsg(e)); }
  }
  return lbBackup;
}
let lbBackupT = null;
function backupLogbookSoon() {
  invalidate();   // Rückmeldungen nach Flügen fliessen in die Bewertung
  clearTimeout(lbBackupT);
  lbBackupT = setTimeout(() => backupLogbook().catch(e => console.warn('Flugbuch-Sicherung', errMsg(e))), Number(process.env.AFC_LB_BACKUP_DELAY_MS ?? 120000));
  lbBackupT.unref?.();
}
const lbBackupStatus = () => ({ at: lbBackup.at, flights: lbBackup.flights, cloud: lbBackup.cloud, cloudDir: lbBackup.cloudDir ? lbBackup.cloudDir.replace(ICLOUD, 'iCloud Drive').replace(os.homedir(), '~') : null, cloudError: lbBackup.cloudError });

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
  await backupLogbook().catch(e => console.warn('Flugbuch-Sicherung', errMsg(e)));
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
    await tick('wind', collectWindGrid);
    await tick('air', collectAirspace);
  })().catch(e => console.error('Start', errMsg(e)));
  timers.push(setInterval(() => tick('obs', collectObservations), OBS_EVERY_MS));
  timers.push(setInterval(() => tick('fc', collectForecast), FC_EVERY_MS));
  timers.push(setInterval(() => tick('wind', collectWindGrid), WIND_EVERY_MS));
  timers.push(setInterval(maintenance, 24 * 3600000));
  timers.push(setInterval(() => tick('air', collectAirspace), 24 * 3600000));
  setTimeout(maintenance, 60000).unref();
  if (BACKTEST_AUTO) timers.push(setInterval(() => maybeBacktest(), 3600000));
  if (PUSH_ON) timers.push(setInterval(() => tick('push', async () => { await pushTick(); await healthTick(); }), 10 * 60000));
  if (STAY_AWAKE) { awakeTick(); timers.push(setInterval(() => awakeTick(), 10 * 60000)); }
  updater.start();
}

/* --------------------------------------------------- Rückblick-Test automatisch */
// Einmal pro Woche nachts die letzten 14 Tage durchrechnen; das Ergebnis erscheint unter Profil.
const BACKTEST_AUTO = process.env.AFC_BACKTEST_AUTO ? process.env.AFC_BACKTEST_AUTO === '1' : AUTOSTART;
const backtestJob = { running: false, error: null };
function backtestHistory() {
  try { const h = JSON.parse(fsc.readFileSync(path.join(DATA, 'backtest-history.json'), 'utf8')); return Array.isArray(h) ? h : []; } catch { return []; }
}
function maybeBacktest(force = false) {
  if (backtestJob.running) return false;
  const last = backtestHistory().filter(x => x.auto).at(-1);
  const hour = zurichParts(Date.now()).hour;
  if (!force && ((last && Date.now() - Date.parse(last.at) < 6.5 * 86400000) || hour < 2 || hour > 5)) return false;
  backtestJob.running = true; backtestJob.error = null;
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'backtest.js'), '--days', '14', '--auto'], { cwd: ROOT, env: { ...process.env, AFC_DATA_DIR: DATA }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', d => { err = (err + d).slice(-400); });
  child.on('exit', code => {
    backtestJob.running = false;
    backtestJob.error = code ? (err.trim().split('\n').pop() || `Abbruch (${code})`) : null;
    console.log(code ? `Rückblick-Test fehlgeschlagen: ${backtestJob.error}` : 'Rückblick-Test fertig');
  });
  return true;
}
function learnedList() {
  return Object.entries(learnedBias()).map(([code, l]) => ({ code, name: state.stationList[code]?.name || code, ...l, used: l.n >= LEARN_MIN_N }))
    .sort((a, b) => b.n - a.n);
}
function backtestStatus() {
  const h = backtestHistory();
  return { auto: BACKTEST_AUTO, running: backtestJob.running, error: backtestJob.error, last: h.at(-1) || null, prev: h.at(-2) || null };
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
