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
import { loadStationList, fetchObservations, fetchFoehnIndex, PRESSURE_STATIONS } from './lib/stations.js';
import { regionalFromObs } from './lib/regional.js';
import { PlanModel, areasOf, isRanked, REF_POINT, FOEHN_POINTS, MOUNTAIN_ALT, LEARN_DAYS, LEARN_MIN_N } from './lib/plan.js';
import { fetchWindGrid, windSlice, thermalSlice, WIND_LEVELS } from './lib/windgrid.js';
import { openMeteoUsage, initOpenMeteoUsage } from './lib/http.js';
import { createUpdater } from './lib/updater.js';
import { cleanFlight, cleanGear, cleanSettings, cleanBackup, flightsCsv, siteFeedbackByLevel, cleanPilotSnap, voterLevel } from './lib/logbook.js';
import { loadVapid, sendPush, cleanSubscription } from './lib/webpush.js';
import { buildNotices, cleanPrefs } from './lib/notify.js';
import { radarFrames, tileOk, camUrlOk, makeCache } from './lib/media.js';
import { watchCheck, WATCH_FROM, WATCH_TO, WATCH_MAX } from './lib/watch.js';
import { learnedVerdict, thermalLearn } from './lib/learn.js';
import { parseOpenAir, clipToBox, bboxOf } from './lib/airspace.js';
import { httpGet } from './lib/http.js';
import { hashPassword, verifyPassword, passwordProblem, newToken, tokenHash, newCode, newId, parseCookies, cleanEmail, cleanName, cleanProfile, cleanUserPrefs, cleanPhoto, cleanFeedback, cleanClientError, wingLoading, FEEDBACK_KINDS, NOFLY_REASONS, LICENSES, STYLES } from './lib/auth.js';

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
CREATE TABLE IF NOT EXISTS watch (site_id TEXT PRIMARY KEY, date TEXT NOT NULL, level TEXT, state TEXT, created TEXT);
CREATE TABLE IF NOT EXISTS site_fc (site_id TEXT NOT NULL, date TEXT NOT NULL, hour INTEGER NOT NULL, lead REAL, top REAL, base REAL, PRIMARY KEY(site_id,date,hour));
CREATE TABLE IF NOT EXISTS logbook (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated TEXT, PRIMARY KEY(kind,id));
CREATE TABLE IF NOT EXISTS fc_pred (id INTEGER PRIMARY KEY, code TEXT NOT NULL, target TEXT NOT NULL, issued TEXT NOT NULL, lead REAL, wind REAL, gust REAL, dir REAL, temp REAL, UNIQUE(code,target));
CREATE INDEX IF NOT EXISTS idx_obs_code_time ON observations(code,time);
CREATE INDEX IF NOT EXISTS idx_obs_time ON observations(time);
CREATE INDEX IF NOT EXISTS idx_flight_client ON flight_reports(client_hash,reported_at);
CREATE INDEX IF NOT EXISTS idx_pred_target ON fc_pred(target);`);
const dbAll = (sql, p = []) => db.prepare(sql).all(...p);
const dbGet = (sql, p = []) => db.prepare(sql).get(...p);
const dbRun = (sql, p = []) => db.prepare(sql).run(...p);

/* ------------------------------------------------------------------ Konten (Testphase) */
// Solange es kein Konto gibt, läuft AFC wie bisher ohne Anmeldung (ein Pilot, eigener Mac). Das erste Konto wird
// Admin und übernimmt alle bisherigen Daten (Flugbuch, Wächter, Benachrichtigungen). Danach braucht jede Anfrage
// eine Anmeldung; neue Piloten kommen nur über einen Einladungslink dazu.
db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pw TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'pilot', created TEXT, last_seen TEXT, profile TEXT NOT NULL DEFAULT '{}', prefs TEXT NOT NULL DEFAULT '{}', photo_at TEXT);
CREATE TABLE IF NOT EXISTS photos (uid TEXT PRIMARY KEY, type TEXT NOT NULL, data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, uid TEXT NOT NULL, created TEXT, expires TEXT NOT NULL, device TEXT);
CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'invite', note TEXT, uid TEXT, created TEXT, expires TEXT, used_by TEXT, used_at TEXT);
CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY, uid TEXT, at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS client_errors (id INTEGER PRIMARY KEY, uid TEXT, at TEXT NOT NULL, sig TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS app_kv (k TEXT PRIMARY KEY, v TEXT);
CREATE INDEX IF NOT EXISTS idx_sessions_uid ON sessions(uid);
CREATE INDEX IF NOT EXISTS idx_feedback_at ON feedback(at);`);
{
  // Flugbuch, Wächter und Benachrichtigungen bekommen eine Spalte für den Piloten ('' = vor den Konten)
  const cols = t => dbAll(`PRAGMA table_info(${t})`).map(c => c.name);
  const lbOld = !cols('logbook').includes('uid'), wOld = !cols('watch').includes('uid'), pOld = !cols('push_subs').includes('uid');
  if (lbOld || wOld || pOld) {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); fsc.copyFileSync(path.join(dataDir, 'afc.sqlite'), path.join(dataDir, `afc-vor-konten-${Date.now()}.sqlite`)); } catch (e) { console.warn('Kopie vor der Umstellung', e.message); }
    db.exec('BEGIN');
    try {
      if (lbOld) db.exec(`CREATE TABLE logbook_n (uid TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated TEXT, PRIMARY KEY(uid,kind,id));
        INSERT INTO logbook_n(uid,kind,id,data,updated) SELECT '',kind,id,data,updated FROM logbook; DROP TABLE logbook; ALTER TABLE logbook_n RENAME TO logbook;`);
      if (wOld) db.exec(`CREATE TABLE watch_n (uid TEXT NOT NULL DEFAULT '', site_id TEXT NOT NULL, date TEXT NOT NULL, level TEXT, state TEXT, created TEXT, PRIMARY KEY(uid,site_id));
        INSERT INTO watch_n(uid,site_id,date,level,state,created) SELECT '',site_id,date,level,state,created FROM watch; DROP TABLE watch; ALTER TABLE watch_n RENAME TO watch;`);
      if (pOld) db.exec(`ALTER TABLE push_subs ADD COLUMN uid TEXT NOT NULL DEFAULT ''`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}
const AUTH = { count: null };
const userCount = () => (AUTH.count ??= dbGet('SELECT COUNT(*) n FROM users').n);
const authOn = () => userCount() > 0;
const adminUid = () => dbGet("SELECT id FROM users WHERE role='admin' ORDER BY created LIMIT 1")?.id ?? '';
const SESSION_DAYS = 90;
const COOKIE = 'afc_s';
/** Angemeldeter Pilot dieser Anfrage (oder null). */
function userOf(req) {
  if (req._user !== undefined) return req._user;
  let u = null;
  const t = parseCookies(req.headers.cookie)[COOKIE];
  if (t && authOn()) {
    const s = dbGet('SELECT u.*, s.expires s_expires FROM sessions s JOIN users u ON u.id=s.uid WHERE s.token=?', [tokenHash(t)]);
    if (s && s.s_expires > nowIso()) {
      u = s;
      if (!s.last_seen || Date.now() - Date.parse(s.last_seen) > 5 * 60000) dbRun('UPDATE users SET last_seen=? WHERE id=?', [nowIso(), s.id]);
    }
  }
  return (req._user = u);
}
const uidOf = req => userOf(req)?.id ?? '';
// Ohne Konten ist der eigene Mac der Admin; mit Konten nur wer als Admin angemeldet ist
const isAdmin = req => (authOn() ? userOf(req)?.role === 'admin' : isLocal(req));
function setSession(req, res, uid) {
  const t = newToken();
  dbRun('INSERT INTO sessions(token,uid,created,expires,device) VALUES(?,?,?,?,?)', [tokenHash(t), uid, nowIso(), new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(), cleanText(req.headers['user-agent'], 160)]);
  const secure = req.headers['x-forwarded-proto'] === 'https' || /\.ts\.net$/.test(String(req.headers.host || '').split(':')[0]) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}
const clearSession = res => res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
const publicUser = u => (u ? { id: u.id, name: u.name, email: u.email, role: u.role, created: u.created, photo: u.photo_at ? `/api/photo/${u.id}?v=${Date.parse(u.photo_at)}` : null } : null);

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
  const codes = [...new Set([...Object.keys(state.stationList), ...Object.keys(PRESSURE_STATIONS)])];
  try {
    const { data, source } = await fetchObservations(codes);
    // Luftdruck auf Meereshöhe für Föhn- und Bisedruck (nur im Speicher, nach 10 Minuten wieder frisch)
    state.qff = Object.fromEntries(Object.keys(PRESSURE_STATIONS).filter(c => isNum(data[c]?.qff)).map(c => [c, { qff: data[c].qff, time: data[c].time }]));
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
  state.regional = Object.keys(state.obs).length ? regionalFromObs(state.obs, state.foehnIndex, state.qff) : null;
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
      now, raw: state.raw, obs: state.obs, stationMeta: state.stationList, regional: state.regional, trend: state.trend, learned: learnGuard().off ? null : learnedBias(),
      thermLearn: thermalLearned(),
      feedbackByLevel: siteFeedbackByLevel(flightsWithPilot()),
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
    out.push({ code, name: m.name, lat: m.lat, lon: m.lon, alt: m.alt, wind: o.wind, gust: o.gust, dir: o.dir, temp: o.temp, age, time: o.time });
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

/* ------------------------------------------------------------------ Regenradar und Webcam-Bilder */
const RADAR_URL = () => process.env.AFC_RADAR_URL || 'https://api.rainviewer.com/public/weather-maps.json';
const radarCache = makeCache(400), camCache = makeCache(60);
let radarIndex = null, radarIndexAt = 0, radarReq = null;
async function radarInfo() {
  if (radarIndex && Date.now() - radarIndexAt < 5 * 60000) return radarIndex;
  radarReq ??= (async () => {
    const r = await fetch(RADAR_URL(), { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('Radar ' + r.status);
    radarIndex = radarFrames(await r.json(), { allowLocal: /^http:\/\/127\.0\.0\.1:/.test(RADAR_URL()) }); radarIndexAt = Date.now();
    return radarIndex;
  })().finally(() => { radarReq = null; });
  return radarReq;
}
async function fetchImage(url, maxBytes, { cam = false } = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000), redirect: 'follow', headers: { 'User-Agent': 'AFC (persoenliche Flugwetter-App)' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (cam && r.url && !camUrlOk(r.url)) throw new Error('Weiterleitung ins lokale Netz');
  const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^image\/(png|jpeg|jpg|webp|gif)$/.test(type)) { const e = new Error('kein Bild'); e.notImage = true; throw e; }
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('Bild zu gross');
  return { type, buf, modified: r.headers.get('last-modified') };
}
async function mediaRoute(req, res, p, u) {
  const img = (code, o, maxAge) => { res.writeHead(code, { 'Content-Type': o.type, 'Content-Length': o.buf.length, 'Cache-Control': `private, max-age=${maxAge}`, 'X-Content-Type-Options': 'nosniff', ...(o.at ? { 'X-AFC-Image-Time': o.at } : {}) }); res.end(o.buf); };
  try {
    if (p === '/api/radar') {
      const ri = await radarInfo();
      return sendJson(req, res, 200, { ok: !!ri.frames.length, frames: ri.frames.map(f => f.time), source: 'RainViewer' });
    }
    const m = p.match(/^\/api\/radar\/(\d{9,11})\/(\d)\/(\d{1,4})\/(\d{1,4})\.png$/);
    if (m) {
      const [ts, z, x, y] = m.slice(1).map(Number);
      if (!tileOk(z, x, y)) return sendJson(req, res, 400, { error: 'Kachel ungültig' });
      const key = `${ts}/${z}/${x}/${y}`, hit = radarCache.get(key);
      if (hit) return img(200, hit, 600);
      const ri = await radarInfo(), f = ri.frames.find(q => q.time === ts);
      if (!f) return sendJson(req, res, 404, { error: 'Radarbild nicht mehr verfügbar' });
      const o = await fetchImage(`${ri.host}${f.path}/256/${z}/${x}/${y}/2/1_0.png`, 400000);
      radarCache.set(key, o, 30 * 60000);
      return img(200, o, 600);
    }
    if (p === '/api/camimg') {
      const url = camUrlOk(u.searchParams.get('u'));
      if (!url) return sendJson(req, res, 400, { error: 'Adresse ungültig (nur https, kein lokales Netz)' });
      const hit = camCache.get(url);
      if (hit) return img(200, hit, 60);
      const o = await fetchImage(url, 4000000, { cam: true });
      o.at = o.modified ? new Date(o.modified).toISOString() : new Date().toISOString();
      camCache.set(url, o, 2 * 60000);
      return img(200, o, 60);
    }
    return sendJson(req, res, 404, { error: 'unbekannt' });
  } catch (e) {
    return sendJson(req, res, e.notImage ? 415 : 502, { error: e.notImage ? 'Die Adresse liefert kein Bild' : 'nicht erreichbar: ' + String(e.message || e).slice(0, 80) });
  }
}

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

/* ------------------------------------------------------------------ Konten: Anmeldung, Profil, Admin */
const areaIdSet = new Set(AREAS.map(a => a.id));
const loginFails = new Map();   // E-Mail -> [Zeitpunkte], gegen Passwort-Raten
function loginBlocked(email) {
  const now = Date.now(), l = (loginFails.get(email) || []).filter(t => now - t < 15 * 60000);
  loginFails.set(email, l);
  return l.length >= 8;
}
const inviteRow = code => {
  const r = /^[a-z0-9]{6,20}$/.test(String(code || '')) ? dbGet('SELECT * FROM invites WHERE code=?', [code]) : null;
  return r && !r.used_by && (!r.expires || r.expires > nowIso()) ? r : null;
};
function userStats(uid) {
  const fl = dbAll("SELECT data FROM logbook WHERE uid=? AND kind='flight'", [uid]).map(r => JSON.parse(r.data));
  const st = JSON.parse(dbGet("SELECT data FROM logbook WHERE uid=? AND kind='settings'", [uid])?.data || '{}');
  const min = fl.reduce((t, f) => t + (f.durMin || 0), 0);
  const y = String(new Date().getFullYear());
  const sites = {};
  for (const f of fl) if (f.siteName) sites[f.siteName] = (sites[f.siteName] || 0) + 1;
  const top = Object.entries(sites).sort((a, b) => b[1] - a[1])[0];
  return {
    flights: fl.length + (Number(st.flightsBefore) || 0), logged: fl.length, hours: Math.round((min / 60 + (Number(st.hoursBefore) || 0)) * 10) / 10,
    year: fl.filter(f => f.date?.startsWith(y)).length, last: fl.map(f => f.date).sort().at(-1) || null,
    verdicts: fl.filter(f => f.afcVerdict).length, igc: fl.filter(f => f.track).length, topSite: top ? top[0] : null,
    longest: fl.reduce((m, f) => Math.max(m, f.durMin || 0), 0), farthest: fl.reduce((m, f) => Math.max(m, f.km || 0), 0)
  };
}
/** Pilotentyp heute laut Profil: Stufe, Ausweis, Flugstil, Flächenbelastung (für jeden gespeicherten Flug). */
function pilotSnap(uid) {
  const u = uid ? dbGet('SELECT profile, prefs FROM users WHERE id=?', [uid]) : null;
  if (!u) return null;
  const pr = cleanProfile(JSON.parse(u.profile || '{}')), pf = cleanUserPrefs(JSON.parse(u.prefs || '{}'));
  return cleanPilotSnap({ level: pf.level, license: pr.license, styles: pr.styles, load: wingLoading(pr).load });
}
/** Ein Flug behält den Pilotentyp vom ersten Speichern; was die App mitschickt, zählt nicht. */
function withPilot(uid, id, item) {
  const old = dbGet("SELECT data FROM logbook WHERE uid=? AND kind='flight' AND id=?", [uid, id]);
  item.pilot = (old && JSON.parse(old.data).pilot) || pilotSnap(uid);
  return item;
}
/** Alle Flüge mit Pilotentyp; ältere Flüge ohne Angabe bekommen das heutige Profil ihres Piloten. */
function flightsWithPilot() {
  const snaps = new Map();
  return dbAll("SELECT uid, data FROM logbook WHERE kind='flight'").map(r => {
    const f = JSON.parse(r.data);
    if (!f.pilot) { if (!snaps.has(r.uid)) snaps.set(r.uid, pilotSnap(r.uid)); f.pilot = snaps.get(r.uid); }
    return f;
  });
}
/** Testphase nach Pilotentyp: je Flugstil und Stufe Piloten, Flüge, Urteile, Gründe fürs Nicht-Starten, Rückmeldungen. */
function pilotGroups(users) {
  const LV = { careful: 'Vorsichtig', normal: 'Normal', expert: 'Erfahren' };
  const g = {}, add = (key, label) => (g[key] ||= { key, label, pilots: 0, flights: 0, richtig: 0, streng: 0, mild: 0, nofly: {}, feedback: 0 });
  const keysOf = p => [...(p?.styles?.length ? p.styles.map(x => ['s:' + x, STYLES[x]]) : [['s:-', 'Flugstil nicht angegeben']]), ['l:' + voterLevel(p), 'Stufe ' + LV[voterLevel(p)]]];
  const byUid = new Map(users.map(u => [u.id, pilotSnap(u.id)]));
  for (const [, snap] of byUid) for (const [k, l] of keysOf(snap)) add(k, l).pilots++;
  for (const f of flightsWithPilot()) for (const [k, l] of keysOf(f.pilot)) { const x = add(k, l); x.flights++; if (f.afcVerdict) x[f.afcVerdict]++; }
  for (const r of dbAll('SELECT uid, kind, data FROM feedback')) {
    const d = JSON.parse(r.data);
    for (const [k, l] of keysOf(byUid.get(r.uid))) { const x = add(k, l); x.feedback++; if (r.kind === 'nofly' && d.reason) x.nofly[d.reason] = (x.nofly[d.reason] || 0) + 1; }
  }
  return Object.values(g).filter(x => x.pilots || x.flights).sort((a, b) => a.key.localeCompare(b.key));
}
const kvGet = k => dbGet('SELECT v FROM app_kv WHERE k=?', [k])?.v ?? null;
const kvSet = (k, v) => (v == null ? dbRun('DELETE FROM app_kv WHERE k=?', [k]) : dbRun('INSERT INTO app_kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', [k, String(v)]));
function meResponse(u) {
  // Abschluss-Umfrage: sobald der Admin sie freischaltet, bis der Pilot sie beantwortet hat
  const survey = !!kvGet('survey') && !dbGet("SELECT 1 x FROM feedback WHERE uid=? AND kind='survey'", [u.id]);
  return { ok: true, auth: true, user: publicUser(u), profile: cleanProfile(JSON.parse(u.profile || '{}')), prefs: cleanUserPrefs(JSON.parse(u.prefs || '{}')), prefsSet: u.prefs !== '{}', stats: userStats(u.id), survey };
}
function deleteUserData(uid) {
  db.exec('BEGIN');
  try {
    for (const sql of ['DELETE FROM logbook WHERE uid=?', 'DELETE FROM watch WHERE uid=?', 'DELETE FROM sessions WHERE uid=?', 'DELETE FROM photos WHERE uid=?', 'DELETE FROM feedback WHERE uid=?', 'DELETE FROM client_errors WHERE uid=?', 'DELETE FROM invites WHERE uid=? AND used_by IS NULL', 'DELETE FROM users WHERE id=?']) dbRun(sql, [uid]);
    for (const r of dbAll('SELECT endpoint FROM push_subs WHERE uid=?', [uid])) { dbRun('DELETE FROM push_sent WHERE endpoint=?', [r.endpoint]); dbRun('DELETE FROM push_subs WHERE endpoint=?', [r.endpoint]); }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  AUTH.count = null;
}
function createUser({ email, name, pw, role }) {
  const id = newId(), at = nowIso();
  dbRun('INSERT INTO users(id,email,name,pw,role,created,last_seen) VALUES(?,?,?,?,?,?,?)', [id, email, name, hashPassword(pw), role, at, at]);
  AUTH.count = null;
  return dbGet('SELECT * FROM users WHERE id=?', [id]);
}
async function accountRoute(req, res, p, u) {
  const me = userOf(req);
  const body = async (max) => readBody(req, max);
  const post = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE';
  if (post && limited(req, 'post', 60)) return sendJson(req, res, 429, { error: 'zu viele Anfragen' });

  if (p === '/api/auth/state' && req.method === 'GET') {
    const inv = u.searchParams.get('invite') ? inviteRow(u.searchParams.get('invite')) : null;
    return sendJson(req, res, 200, { ok: true, auth: authOn(), setup: !authOn(), user: publicUser(me), invite: inv ? { ok: true, kind: inv.kind, name: inv.kind === 'reset' ? dbGet('SELECT name FROM users WHERE id=?', [inv.uid])?.name : null } : u.searchParams.get('invite') ? { ok: false } : null });
  }
  if (p === '/api/auth/setup' && req.method === 'POST') {
    if (authOn()) return sendJson(req, res, 409, { error: 'Es gibt schon ein Admin-Konto. Bitte anmelden.' });
    const b = await body();
    const email = cleanEmail(b.email), name = cleanName(b.name), bad = passwordProblem(b.password);
    if (!name) return sendJson(req, res, 400, { error: 'Bitte deinen Namen eingeben' });
    if (!email) return sendJson(req, res, 400, { error: 'Bitte eine gültige E-Mail-Adresse eingeben' });
    if (bad) return sendJson(req, res, 400, { error: bad });
    await backup(db, path.join(backupsDir, `afc-vor-erstem-konto-${nowIso().replace(/[:.]/g, '-')}.sqlite`)).catch(e => console.warn('Sicherung vor dem ersten Konto', errMsg(e)));
    const user = createUser({ email, name, pw: b.password, role: 'admin' });
    // bisherige Daten gehören dem ersten Konto
    for (const t of ['logbook', 'watch', 'push_subs']) dbRun(`UPDATE ${t} SET uid=? WHERE uid=''`, [user.id]);
    if (b.prefs) dbRun('UPDATE users SET prefs=? WHERE id=?', [JSON.stringify(cleanUserPrefs(b.prefs)), user.id]);
    setSession(req, res, user.id);
    return sendJson(req, res, 200, meResponse(dbGet('SELECT * FROM users WHERE id=?', [user.id])));
  }
  if (p === '/api/auth/register' && req.method === 'POST') {
    const b = await body();
    const inv = inviteRow(b.invite);
    if (!inv || inv.kind !== 'invite') return sendJson(req, res, 400, { error: 'Dieser Einladungslink ist nicht mehr gültig. Bitte Lars um einen neuen.' });
    const email = cleanEmail(b.email), name = cleanName(b.name), bad = passwordProblem(b.password);
    if (!name) return sendJson(req, res, 400, { error: 'Bitte deinen Namen eingeben' });
    if (!email) return sendJson(req, res, 400, { error: 'Bitte eine gültige E-Mail-Adresse eingeben' });
    if (bad) return sendJson(req, res, 400, { error: bad });
    if (dbGet('SELECT 1 x FROM users WHERE email=?', [email])) return sendJson(req, res, 409, { error: 'Mit dieser E-Mail gibt es schon ein Konto. Bitte anmelden.' });
    const user = createUser({ email, name, pw: b.password, role: 'pilot' });
    dbRun('UPDATE invites SET used_by=?, used_at=? WHERE code=?', [user.id, nowIso(), inv.code]);
    if (b.prefs) dbRun('UPDATE users SET prefs=? WHERE id=?', [JSON.stringify(cleanUserPrefs(b.prefs)), user.id]);
    setSession(req, res, user.id);
    return sendJson(req, res, 200, meResponse(dbGet('SELECT * FROM users WHERE id=?', [user.id])));
  }
  if (p === '/api/auth/reset' && req.method === 'POST') {
    // neues Passwort über einen Link, den der Admin erstellt hat
    const b = await body();
    const inv = inviteRow(b.invite);
    if (!inv || inv.kind !== 'reset') return sendJson(req, res, 400, { error: 'Dieser Link ist nicht mehr gültig. Bitte Lars um einen neuen.' });
    const bad = passwordProblem(b.password);
    if (bad) return sendJson(req, res, 400, { error: bad });
    dbRun('UPDATE users SET pw=? WHERE id=?', [hashPassword(b.password), inv.uid]);
    dbRun('DELETE FROM sessions WHERE uid=?', [inv.uid]);
    dbRun('UPDATE invites SET used_by=?, used_at=? WHERE code=?', [inv.uid, nowIso(), inv.code]);
    setSession(req, res, inv.uid);
    return sendJson(req, res, 200, meResponse(dbGet('SELECT * FROM users WHERE id=?', [inv.uid])));
  }
  if (p === '/api/auth/login' && req.method === 'POST') {
    if (limited(req, 'login', 20)) return sendJson(req, res, 429, { error: 'Zu viele Versuche. Bitte eine Minute warten.' });
    const b = await body();
    const email = cleanEmail(b.email);
    if (!email) return sendJson(req, res, 400, { error: 'Bitte die E-Mail-Adresse eingeben' });
    if (loginBlocked(email)) return sendJson(req, res, 429, { error: 'Zu viele falsche Passwörter. Bitte in 15 Minuten nochmals versuchen.' });
    const user = dbGet('SELECT * FROM users WHERE email=?', [email]);
    if (!user || !verifyPassword(b.password, user.pw)) {
      loginFails.get(email).push(Date.now());
      return sendJson(req, res, 401, { error: 'E-Mail oder Passwort stimmt nicht' });
    }
    loginFails.delete(email);
    setSession(req, res, user.id);
    return sendJson(req, res, 200, meResponse(user));
  }
  if (p === '/api/auth/logout' && req.method === 'POST') {
    const t = parseCookies(req.headers.cookie)[COOKIE];
    if (t) dbRun('DELETE FROM sessions WHERE token=?', [tokenHash(t)]);
    clearSession(res);
    return sendJson(req, res, 200, { ok: true });
  }

  // ab hier nur angemeldet
  if (!me) return sendJson(req, res, 401, { error: 'Bitte anmelden', login: true });
  if (p === '/api/me' && req.method === 'GET') return sendJson(req, res, 200, meResponse(me));
  if (p === '/api/me' && req.method === 'PUT') {
    const b = await body(32 * 1024);
    if (b.name !== undefined) { const n = cleanName(b.name); if (!n) return sendJson(req, res, 400, { error: 'Bitte deinen Namen eingeben' }); dbRun('UPDATE users SET name=? WHERE id=?', [n, me.id]); }
    if (b.profile) dbRun('UPDATE users SET profile=? WHERE id=?', [JSON.stringify(cleanProfile(b.profile, areaIdSet)), me.id]);
    if (b.prefs) dbRun('UPDATE users SET prefs=? WHERE id=?', [JSON.stringify(cleanUserPrefs({ ...JSON.parse(me.prefs || '{}'), ...b.prefs })), me.id]);
    return sendJson(req, res, 200, meResponse(dbGet('SELECT * FROM users WHERE id=?', [me.id])));
  }
  if (p === '/api/me/photo' && (req.method === 'PUT' || req.method === 'DELETE')) {
    if (req.method === 'DELETE') { dbRun('DELETE FROM photos WHERE uid=?', [me.id]); dbRun('UPDATE users SET photo_at=NULL WHERE id=?', [me.id]); }
    else {
      const ph = cleanPhoto((await body(600 * 1024)).photo);
      if (!ph) return sendJson(req, res, 400, { error: 'Das Bild konnte nicht gelesen werden (JPEG oder PNG, höchstens 400 KB)' });
      dbRun('INSERT INTO photos(uid,type,data) VALUES(?,?,?) ON CONFLICT(uid) DO UPDATE SET type=excluded.type, data=excluded.data', [me.id, ph.type, ph.buf]);
      dbRun('UPDATE users SET photo_at=? WHERE id=?', [nowIso(), me.id]);
    }
    return sendJson(req, res, 200, meResponse(dbGet('SELECT * FROM users WHERE id=?', [me.id])));
  }
  if (p === '/api/me/password' && req.method === 'POST') {
    const b = await body();
    if (!verifyPassword(b.old, me.pw)) return sendJson(req, res, 400, { error: 'Das bisherige Passwort stimmt nicht' });
    const bad = passwordProblem(b.password);
    if (bad) return sendJson(req, res, 400, { error: bad });
    dbRun('UPDATE users SET pw=? WHERE id=?', [hashPassword(b.password), me.id]);
    dbRun('DELETE FROM sessions WHERE uid=?', [me.id]);
    setSession(req, res, me.id);
    return sendJson(req, res, 200, { ok: true });
  }
  if (p === '/api/me/export' && req.method === 'GET') {
    const data = { app: 'AFC', type: 'meine-daten', exportedAt: nowIso(), konto: { ...publicUser(me), lastSeen: me.last_seen }, profil: cleanProfile(JSON.parse(me.profile || '{}')), einstellungen: cleanUserPrefs(JSON.parse(me.prefs || '{}')), flugbuch: logbookData(me.id), waechter: dbAll('SELECT site_id, date, level FROM watch WHERE uid=?', [me.id]), rueckmeldungen: dbAll('SELECT at, kind, data FROM feedback WHERE uid=?', [me.id]).map(r => ({ at: r.at, kind: r.kind, ...JSON.parse(r.data) })), geraete: dbAll('SELECT created, expires, device FROM sessions WHERE uid=?', [me.id]) };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="AFC-meine-Daten-${nowIso().slice(0, 10)}.json"`, 'Cache-Control': 'no-store', ...SEC });
    return res.end(JSON.stringify(data, null, 1));
  }
  if (p === '/api/me' && req.method === 'DELETE') {
    const b = await body();
    if (!verifyPassword(b.password, me.pw)) return sendJson(req, res, 400, { error: 'Das Passwort stimmt nicht' });
    if (me.role === 'admin' && dbGet("SELECT COUNT(*) n FROM users WHERE role='admin'").n <= 1 && userCount() > 1) return sendJson(req, res, 400, { error: 'Du bist der einzige Admin. Lösche zuerst die anderen Konten.' });
    await backup(db, path.join(backupsDir, `afc-vor-loeschen-${nowIso().replace(/[:.]/g, '-')}.sqlite`)).catch(() => {});
    deleteUserData(me.id);
    clearSession(res);
    return sendJson(req, res, 200, { ok: true });
  }
  const ph = p.match(/^\/api\/photo\/([\w-]{6,20})$/);
  if (ph && req.method === 'GET') {
    const r = dbGet('SELECT type, data FROM photos WHERE uid=?', [ph[1]]);
    if (!r) return sendJson(req, res, 404, { error: 'kein Bild' });
    res.writeHead(200, { 'Content-Type': r.type, 'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Length': r.data.length, ...SEC });
    return res.end(Buffer.from(r.data));
  }
  // Rückmeldungen aus der App (Idee, Fehler, «heute nicht gestartet», Umfrage)
  if (p === '/api/feedback' && req.method === 'POST') {
    if (limited(req, 'feedback', 20)) return sendJson(req, res, 429, { error: 'zu viele Rückmeldungen, bitte später' });
    const b = await body(420 * 1024);
    const f = cleanFeedback(b);
    if (!f) return sendJson(req, res, 400, { error: 'Bitte etwas schreiben' });
    const shot = typeof b.shot === 'string' && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(b.shot) && b.shot.length < 400 * 1024 ? b.shot : null;
    dbRun('INSERT INTO feedback(uid,at,kind,data) VALUES(?,?,?,?)', [me.id, nowIso(), f.kind, JSON.stringify({ ...f, shot })]);
    return sendJson(req, res, 200, { ok: true });
  }
  if (p === '/api/feedback' && req.method === 'GET') {
    return sendJson(req, res, 200, { ok: true, items: dbAll('SELECT at, kind, data FROM feedback WHERE uid=? ORDER BY at DESC LIMIT 50', [me.id]).map(r => { const d = JSON.parse(r.data); delete d.shot; return { at: r.at, kind: r.kind, ...d }; }) });
  }

  // Admin: Einladungen, Überblick über die Testphase
  if (p.startsWith('/api/admin/')) {
    if (me.role !== 'admin') return sendJson(req, res, 403, { error: 'nur für den Admin' });
    if (p === '/api/admin/overview' && req.method === 'GET') {
      const users = dbAll('SELECT * FROM users ORDER BY created').map(x => ({ ...publicUser(x), lastSeen: x.last_seen, profile: cleanProfile(JSON.parse(x.profile || '{}')), stats: userStats(x.id), push: dbGet('SELECT COUNT(*) n FROM push_subs WHERE uid=?', [x.id]).n, feedback: dbGet('SELECT COUNT(*) n FROM feedback WHERE uid=?', [x.id]).n }));
      const names = Object.fromEntries(users.map(x => [x.id, x.name]));
      const invites = dbAll('SELECT * FROM invites ORDER BY created DESC LIMIT 60').map(x => ({ code: x.code, kind: x.kind, note: x.note, created: x.created, expires: x.expires, usedBy: x.used_by ? names[x.used_by] || '(gelöscht)' : null, usedAt: x.used_at, forUser: x.uid ? names[x.uid] || null : null }));
      const feedback = dbAll('SELECT id, uid, at, kind, data, done FROM feedback ORDER BY at DESC LIMIT 200').map(r => ({ id: r.id, at: r.at, kind: r.kind, done: !!r.done, who: names[r.uid] || '(gelöscht)', ...JSON.parse(r.data) }));
      const errors = dbAll('SELECT id, uid, at, n, data FROM client_errors ORDER BY at DESC LIMIT 60').map(r => ({ id: r.id, at: r.at, n: r.n, who: names[r.uid] || '–', ...JSON.parse(r.data) }));
      const verdicts = {};
      for (const r of dbAll("SELECT data FROM logbook WHERE kind='flight'")) { const v = JSON.parse(r.data).afcVerdict; if (v) verdicts[v] = (verdicts[v] || 0) + 1; }
      return sendJson(req, res, 200, { ok: true, users, invites, feedback, errors, verdicts, groups: pilotGroups(users), licenses: LICENSES, styles: STYLES, kinds: FEEDBACK_KINDS, reasons: NOFLY_REASONS, survey: !!kvGet('survey') });
    }
    if (p === '/api/admin/survey' && req.method === 'PUT') { const b = await body(); kvSet('survey', b.on ? nowIso() : null); return sendJson(req, res, 200, { ok: true, survey: !!b.on }); }
    if (p === '/api/admin/invite' && req.method === 'POST') {
      const b = await body();
      const kind = b.kind === 'reset' ? 'reset' : 'invite';
      const uid = kind === 'reset' ? String(b.uid || '') : null;
      if (kind === 'reset' && !dbGet('SELECT 1 x FROM users WHERE id=?', [uid])) return sendJson(req, res, 404, { error: 'Konto nicht gefunden' });
      const code = newCode(10), days = kind === 'reset' ? 3 : Math.min(60, Math.max(1, Number(b.days) || 30));
      dbRun('INSERT INTO invites(code,kind,note,uid,created,expires) VALUES(?,?,?,?,?,?)', [code, kind, cleanText(b.note, 60) || null, uid, nowIso(), new Date(Date.now() + days * 86400000).toISOString()]);
      return sendJson(req, res, 200, { ok: true, code, kind, expires: new Date(Date.now() + days * 86400000).toISOString() });
    }
    const di = p.match(/^\/api\/admin\/invite\/([a-z0-9]{6,20})$/);
    if (di && req.method === 'DELETE') { dbRun('DELETE FROM invites WHERE code=? AND used_by IS NULL', [di[1]]); return sendJson(req, res, 200, { ok: true }); }
    const fd = p.match(/^\/api\/admin\/feedback\/(\d+)$/);
    if (fd && req.method === 'PUT') { const b = await body(); dbRun('UPDATE feedback SET done=? WHERE id=?', [b.done ? 1 : 0, Number(fd[1])]); return sendJson(req, res, 200, { ok: true }); }
    const fs2 = p.match(/^\/api\/admin\/feedback\/(\d+)\/shot$/);
    if (fs2 && req.method === 'GET') { const r = dbGet('SELECT data FROM feedback WHERE id=?', [Number(fs2[1])]); return sendJson(req, res, 200, { ok: true, shot: r ? JSON.parse(r.data).shot || null : null }); }
    if (p === '/api/admin/errors' && req.method === 'DELETE') { dbRun('DELETE FROM client_errors'); return sendJson(req, res, 200, { ok: true }); }
    const du = p.match(/^\/api\/admin\/user\/([\w-]{6,20})$/);
    if (du && req.method === 'DELETE') {
      if (du[1] === me.id) return sendJson(req, res, 400, { error: 'Das eigene Konto unter «Konto löschen» löschen' });
      await backup(db, path.join(backupsDir, `afc-vor-loeschen-${nowIso().replace(/[:.]/g, '-')}.sqlite`)).catch(() => {});
      deleteUserData(du[1]);
      return sendJson(req, res, 200, { ok: true });
    }
    return sendJson(req, res, 404, { error: 'unbekannt' });
  }
  return sendJson(req, res, 404, { error: 'unbekannt' });
}
/** JavaScript-Fehler aus der App: gleiche Meldungen werden gezählt statt gespeichert. */
function clientErrorRoute(req, res, body) {
  const e = cleanClientError(body);
  if (!e) return sendJson(req, res, 400, { error: 'leer' });
  const uid = uidOf(req) || null, sig = crypto.createHash('sha1').update(e.msg + '|' + e.src + '|' + e.line).digest('hex').slice(0, 16);
  const row = dbGet('SELECT id FROM client_errors WHERE sig=? AND COALESCE(uid,\'\')=?', [sig, uid || '']);
  if (row) dbRun('UPDATE client_errors SET n=n+1, at=?, data=? WHERE id=?', [nowIso(), JSON.stringify(e), row.id]);
  else dbRun('INSERT INTO client_errors(uid,at,sig,data) VALUES(?,?,?,?)', [uid, nowIso(), sig, JSON.stringify(e)]);
  dbRun('DELETE FROM client_errors WHERE id NOT IN (SELECT id FROM client_errors ORDER BY at DESC LIMIT 300)');
  return sendJson(req, res, 200, { ok: true });
}

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

    // Regenradar und Webcam-Bilder: eigene Grenze, weil eine Karte viele Kacheln auf einmal lädt
    if (req.method === 'GET' && (p === '/api/radar' || p.startsWith('/api/radar/') || p === '/api/camimg')) {
      if (limited(req, 'media', 600)) return sendJson(req, res, 429, { error: 'zu viele Anfragen' });
      if (authOn() && !userOf(req)) return sendJson(req, res, 401, { error: 'Bitte anmelden', login: true });
      return mediaRoute(req, res, p, u);
    }
    if (p.startsWith('/api/')) {
      if (limited(req, 'api', 180)) return sendJson(req, res, 429, { error: 'zu viele Anfragen' });
      if (p === '/api/client-error' && req.method === 'POST') {
        if (limited(req, 'cerr', 20)) return sendJson(req, res, 429, { error: 'zu viele' });
        return clientErrorRoute(req, res, await readBody(req, 8 * 1024));
      }
      if (p.startsWith('/api/auth/') || p === '/api/me' || p.startsWith('/api/me/') || p.startsWith('/api/admin/') || p.startsWith('/api/photo/') || p === '/api/feedback') return accountRoute(req, res, p, u);
      // Mit Konten braucht alles eine Anmeldung (ausser der Version für die Anzeige vor dem Anmelden)
      if (authOn() && !userOf(req) && p !== '/api/meta') return sendJson(req, res, 401, { error: 'Bitte anmelden', login: true });
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
        // Piloten ohne Admin-Rechte sehen Version und Gelerntes, aber keine Update- und Betriebsdetails des Macs
        if (!isAdmin(req)) return sendJson(req, res, 200, { ok: true, version: SERVER_VERSION, admin: false, learned: learnedList(), learnGuard: learnGuard(), thermal: thermalLearned() });
        return sendJson(req, res, 200, { ok: true, version: SERVER_VERSION, admin: true, openMeteo: openMeteoUsage(), update: { ...updater.status(), canApply: AUTOSTART && isLocal(req) }, backtest: backtestStatus(), learned: learnedList(), learnGuard: learnGuard(), thermal: thermalLearned(), awake: awakeStatus(), problems: healthProblems().map(p => ({ id: p.id, title: p.title, body: p.body })) });
      }
      if (req.method === 'POST' && p === '/api/backtest') {
        if (!isLocal(req) || !isAdmin(req) || req.headers['x-afc-client'] === undefined) return sendJson(req, res, 403, { error: 'nur auf diesem Rechner' });
        return sendJson(req, res, 200, { ok: true, started: maybeBacktest(true), ...backtestStatus() });
      }
      if (req.method === 'POST' && p === '/api/update') {
        if (!isLocal(req) || !AUTOSTART || !isAdmin(req)) return sendJson(req, res, 403, { error: 'Update nur auf dem eigenen Mac mit eingerichtetem Autostart' });
        if (req.headers['x-afc-client'] === undefined) return sendJson(req, res, 400, { error: 'Kopfzeile fehlt' });
        const r = await updater.apply();
        if (!r.ok) return sendJson(req, res, 500, { error: r.error });
        sendJson(req, res, 200, { ok: true, restarting: true });
        // launchd startet den Dienst nach dem Beenden mit der neuen Version wieder
        setTimeout(() => shutdown('Update'), 300);
        return;
      }
      if (req.method === 'POST' && p === '/api/update/check') {
        if (!isLocal(req) || !isAdmin(req)) return sendJson(req, res, 403, { error: 'nur lokal' });
        return sendJson(req, res, 200, { ok: true, update: { ...(await updater.check()), canApply: AUTOSTART } });
      }
      if (req.method === 'GET' && p === '/api/meta') {
        return sendJson(req, res, 200, { ok: true, version: SERVER_VERSION, publicApp: PUBLIC_APP || null, sites: RANKED.length, areas: AREAS.length, sitesChecked: SITES_FILE.meta?.checked, areaList: AREAS.map(a => ({ id: a.id, name: a.name })) });
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
      // Flugtag-Wächter: «Heute fliege ich hier»
      if (p === '/api/watch') {
        if (!clientId(req)) return sendJson(req, res, 400, { error: 'X-AFC-Client fehlt' });
        const today = zurichParts(Date.now()).date, uid = uidOf(req);
        dbRun('DELETE FROM watch WHERE date<>?', [today]);
        const list = () => dbAll('SELECT site_id siteId, level, created FROM watch WHERE date=? AND uid=?', [today, uid]);
        const devices = () => dbGet('SELECT COUNT(*) n FROM push_subs WHERE uid=?', [uid]).n;
        if (req.method === 'GET') return sendJson(req, res, 200, { ok: true, watches: list(), devices: devices(), from: WATCH_FROM, to: WATCH_TO });
        if (req.method !== 'POST') return sendJson(req, res, 405, { error: 'Methode nicht erlaubt' });
        if (limited(req, 'post', 60)) return sendJson(req, res, 429, { error: 'zu viele Anfragen' });
        const b = await readBody(req);
        const sid = String(b.siteId || '');
        if (!SITE_IDS.has(sid)) return sendJson(req, res, 400, { error: 'Unbekannter Startplatz' });
        if (b.on === false) dbRun('DELETE FROM watch WHERE site_id=? AND uid=?', [sid, uid]);
        else {
          if (!dbGet('SELECT 1 x FROM watch WHERE site_id=? AND uid=?', [sid, uid]) && list().length >= WATCH_MAX) return sendJson(req, res, 400, { error: `Höchstens ${WATCH_MAX} Startplätze gleichzeitig` });
          const level = LEVELS[b.level] ? b.level : DEFAULT_LEVEL;
          dbRun('INSERT INTO watch(uid,site_id,date,level,state,created) VALUES(?,?,?,?,?,?) ON CONFLICT(uid,site_id) DO UPDATE SET date=excluded.date, level=excluded.level', [uid, sid, today, level, '{}', nowIso()]);
          tick('watch', watchTick);   // gleich einmal prüfen
        }
        return sendJson(req, res, 200, { ok: true, watches: list(), devices: devices() });
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
          dbRun('INSERT INTO push_subs(endpoint,keys,prefs,created,uid) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET keys=excluded.keys, prefs=excluded.prefs, uid=excluded.uid', [sub.endpoint, JSON.stringify(sub.keys), JSON.stringify(prefs), nowIso(), uidOf(req)]);
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
        if (p === '/api/push/run' && pushFetch) return sendJson(req, res, 200, { ok: true, sent: b.phase === 'health' ? await healthTick(Date.now(), b.hour) : b.phase === 'watch' ? await watchTick(Date.now(), b.hour) : b.phase === 'snapshot' ? snapshotSiteForecasts(Date.parse(b.now) || Date.now()) : await pushTick(b.phase) });   // nur in den Tests
        if (p === '/api/push/status') {
          return sendJson(req, res, 200, { ok: true, enabled: PUSH_ON, subscribed: !!row, prefs: row ? JSON.parse(row.prefs) : null, lastOk: row?.last_ok || null, lastError: row?.last_error || null });
        }
        return sendJson(req, res, 404, { error: 'unbekannt' });
      }
      // Flugbuch (persönlich, bleibt auf diesem Rechner): Flüge, Ausrüstung, Einstellungen
      if (p === '/api/logbook' || p.startsWith('/api/logbook/')) {
        if (!clientId(req)) return sendJson(req, res, 400, { error: 'X-AFC-Client fehlt' });
        const uid = uidOf(req);
        // Sicherung auf dem Mac und in iCloud gilt dem Flugbuch des Admins; alle anderen sind in der täglichen Datenbank-Sicherung
        if (req.method === 'GET' && p === '/api/logbook') return sendJson(req, res, 200, { ok: true, ...logbookData(uid), backup: uid === adminUid() ? lbBackupStatus() : null });
        if (req.method === 'GET' && (p === '/api/logbook/export.json' || p === '/api/logbook/export.csv')) {
          const file = logbookFile(uid), csv = p.endsWith('.csv');
          const day = file.exportedAt.slice(0, 10);
          res.writeHead(200, { 'Content-Type': csv ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="AFC-Flugbuch-${day}.${csv ? 'csv' : 'json'}"`, 'Cache-Control': 'no-store', ...SEC, ...corsHeaders(req) });
          return res.end(csv ? flightsCsv(file.flights, file.gear) : JSON.stringify(file, null, 1));
        }
        if (req.method === 'POST' && p === '/api/logbook/backup') {
          if (limited(req, 'post', 20)) return sendJson(req, res, 429, { error: 'zu viele Anfragen' });
          if (uid !== adminUid()) return sendJson(req, res, 403, { error: 'Dein Flugbuch wird jede Nacht automatisch gesichert. Mit «Sicherungsdatei» bekommst du eine eigene Kopie.' });
          await backupLogbook();
          return sendJson(req, res, 200, { ok: true, backup: lbBackupStatus() });
        }
        if (req.method === 'POST' && p === '/api/logbook/import') {
          // Sicherung einspielen: Flüge und Ausrüstung nach id zusammenführen, nichts wird gelöscht
          if (limited(req, 'post', 20)) return sendJson(req, res, 429, { error: 'zu viele Anfragen' });
          const b = cleanBackup(await readBody(req, 30 * 1024 * 1024));
          if (!b) return sendJson(req, res, 400, { error: 'Das ist keine AFC-Flugbuch-Sicherung' });
          await backup(db, path.join(backupsDir, `afc-vor-import-${nowIso().replace(/[:.]/g, '-')}.sqlite`));
          const has = new Set(dbAll("SELECT kind||'/'||id k FROM logbook WHERE uid=?", [uid]).map(r => r.k));
          const n = { added: 0, updated: 0, gear: 0 };
          const put = (kind, id, item) => dbRun('INSERT INTO logbook(uid,kind,id,data,updated) VALUES(?,?,?,?,?) ON CONFLICT(uid,kind,id) DO UPDATE SET data=excluded.data, updated=excluded.updated', [uid, kind, id, JSON.stringify(item), nowIso()]);
          db.exec('BEGIN');
          try {
            for (const f of b.flights) { n[has.has('flight/' + f.id) ? 'updated' : 'added']++; put('flight', f.id, withPilot(uid, f.id, f)); }
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
        if (req.method === 'DELETE') { dbRun('DELETE FROM logbook WHERE uid=? AND kind=? AND id=?', [uid, kind, lid]); backupLogbookSoon(); return sendJson(req, res, 200, { ok: true }); }
        if (req.method === 'PUT') {
          const body = await readBody(req, 64 * 1024);   // Flug mit vereinfachter IGC-Spur
          const item = kind === 'flight' ? cleanFlight({ ...body, id: lid }) : kind === 'gear' ? cleanGear({ ...body, id: lid }) : cleanSettings(body);
          if (item && kind === 'flight') withPilot(uid, lid, item);
          if (!item) return sendJson(req, res, 400, { error: kind === 'flight' ? 'Datum fehlt' : 'Art der Ausrüstung fehlt' });
          dbRun('INSERT INTO logbook(uid,kind,id,data,updated) VALUES(?,?,?,?,?) ON CONFLICT(uid,kind,id) DO UPDATE SET data=excluded.data, updated=excluded.updated', [uid, kind, kind === 'settings' ? 'main' : lid, JSON.stringify(item), nowIso()]);
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
  const lbs = {};
  const plans = {};
  let sent = 0;
  for (const row of subs) {
    const prefs = cleanPrefs(JSON.parse(row.prefs));
    const plan = plans[prefs.level] ||= model.planPayload(prefs.level);
    const lb = lbs[row.uid] ||= logbookData(row.uid);   // Ausrüstung und Flüge des Piloten, dem das Gerät gehört
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

/* ------------------------------------------------------------------ Lernen aus Flügen */
// Prognose je Startplatz und Stunde festhalten (die letzte vor der Stunde, höchstens 3 h voraus),
// damit spätere IGC-Flüge mit der Prognose zur Flugzeit verglichen werden können (lib/learn.js).
function snapshotSiteForecasts(now = Date.now()) {
  const model = currentModel();
  if (!model?.ok) return 0;
  const res = model.compute(DEFAULT_LEVEL);
  let n = 0;
  const up = db.prepare('INSERT INTO site_fc(site_id,date,hour,lead,top,base) VALUES(?,?,?,?,?,?) ON CONFLICT(site_id,date,hour) DO UPDATE SET lead=excluded.lead, top=excluded.top, base=excluded.base WHERE excluded.lead<=site_fc.lead');
  for (let i = 0; i < model.n; i++) {
    const lead = (model.t[i] - now) / 3600000;
    if (lead < -0.5 || lead > 3) continue;
    const zp = zurichParts(model.t[i]);
    for (const [id, r] of res) {
      const w = r?.hours?.[i]?.w;
      if (!w?.thermik || !isNum(w.thermik.top)) continue;
      const top = isNum(w.cloudBase) ? Math.min(w.thermik.top, w.cloudBase) : w.thermik.top;
      up.run(id, zp.date, zp.hour, Math.max(0, lead), Math.round(top), isNum(w.cloudBase) ? Math.round(w.cloudBase) : null);
      n++;
    }
  }
  return n;
}
const SITE_AREA = Object.fromEntries(SITES.map(s => [s.id, s.area]));
function thermalLearned() {
  if (state.thermal && Date.now() - state.thermalAt < 3600000) return state.thermal;
  const flights = allFlights().filter(f => f.track?.thermals?.length);   // Flüge aller Piloten
  const fc = new Map();
  for (const d of new Set(flights.map(f => f.date))) for (const r of dbAll('SELECT site_id, hour, top FROM site_fc WHERE date=?', [d])) fc.set(`${r.site_id}|${d}|${r.hour}`, r.top);
  state.thermal = thermalLearn(flights, fc, SITE_AREA);
  state.thermalAt = Date.now();
  return state.thermal;
}

/* ------------------------------------------------------------------ Flugtag-Wächter */
async function watchTick(now = Date.now(), hourOverride = null) {
  const zp = zurichParts(now), h = hourOverride ?? zp.hour;
  const rows = dbAll('SELECT * FROM watch WHERE date=?', [zp.date]);
  if (!rows.length || h < WATCH_FROM || h > WATCH_TO) return 0;
  const model = currentModel();
  if (!model?.ok) return 0;
  const subs = PUSH_ON ? dbAll('SELECT * FROM push_subs') : [];
  let sent = 0;
  for (const w of rows) {
    const detail = model.siteDetail(w.site_id, w.level);
    if (!detail) continue;
    const { state, alerts } = watchCheck(detail, w.level, JSON.parse(w.state || '{}'), h, now);
    dbRun('UPDATE watch SET state=? WHERE site_id=? AND uid=?', [JSON.stringify(state), w.site_id, w.uid]);
    for (const a of alerts) for (const row of subs.filter(x => x.uid === w.uid)) {
      const r = await pushTo(row, { title: a.title, body: a.body, tag: `watch-${w.site_id}-${a.type}`, url: '/?site=' + encodeURIComponent(w.site_id) });
      if (r.ok) sent++;
    }
  }
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
  // Betriebsmeldungen des Macs nur an den Admin
  const subs = dbAll('SELECT * FROM push_subs WHERE uid=?', [adminUid()]).filter(r => cleanPrefs(JSON.parse(r.prefs)).health);
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
function logbookData(uid = '') {
  const pick = k => dbAll('SELECT data FROM logbook WHERE uid=? AND kind=?', [uid, k]).map(r => JSON.parse(r.data));
  return { flights: pick('flight').sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start)), gear: pick('gear'), settings: cleanSettings(pick('settings')[0] || {}) };
}
const allFlights = () => dbAll("SELECT data FROM logbook WHERE kind='flight'").map(r => JSON.parse(r.data));
const logbookFile = (uid = adminUid()) => ({ app: 'AFC', type: 'flugbuch', version: 1, exportedAt: nowIso(), ...logbookData(uid) });
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
  state.thermalAt = 0;
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
    dbRun('DELETE FROM site_fc WHERE date<?', [new Date(Date.now() - 800 * 86400000).toISOString().slice(0, 10)]);
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
  if (PUSH_ON) timers.push(setInterval(() => tick('push', async () => { await pushTick(); await healthTick(); await watchTick(); }), 10 * 60000));
  timers.push(setInterval(() => { try { snapshotSiteForecasts(); } catch (e) { console.warn('Prognose festhalten', errMsg(e)); } }, 10 * 60000));
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
  // Zuerst ohne Lernen (Vergleich), dann mit Lernen (zählt). Ist das Lernen schlechter, wird es pausiert.
  const run = args => new Promise(res => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'backtest.js'), '--days', '14', ...args], { cwd: ROOT, env: { ...process.env, AFC_DATA_DIR: DATA }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err = (err + d).slice(-400); });
    child.on('error', e => res({ code: 1, err: String(e.message) }));
    child.on('exit', code => res({ code, err }));
  });
  (async () => {
    const a = await run(['--vergleich', '--ohne-lernen']);
    const b = await run(['--auto']);
    const bad = [a, b].find(x => x.code);
    backtestJob.error = bad ? (bad.err.trim().split('\n').pop() || `Abbruch (${bad.code})`) : null;
    if (!bad) judgeLearning();
    console.log(bad ? `Rückblick-Test fehlgeschlagen: ${backtestJob.error}` : 'Rückblick-Test fertig');
  })().finally(() => { backtestJob.running = false; });
  return true;
}
/* Selbstprüfung: Macht das Gelernte den Rückblick-Test schlechter, wird es pausiert (data/learn-guard.json). */
const guardFile = () => path.join(DATA, 'learn-guard.json');
function learnGuard() { try { return JSON.parse(fsc.readFileSync(guardFile(), 'utf8')); } catch { return { off: false }; } }
function judgeLearning() {
  let base;
  try { base = JSON.parse(fsc.readFileSync(path.join(DATA, 'backtest-vergleich.json'), 'utf8')); } catch { return; }
  const withL = backtestHistory().at(-1);
  if (!withL || !base) return;
  const g = learnedVerdict(base, withL);
  fsc.writeFileSync(guardFile(), JSON.stringify({ ...g, at: nowIso() }, null, 1));
  state.learnedAt = 0; invalidate();
  console.log('Selbstprüfung Lernen:', g.off ? 'pausiert, ' + g.reason : 'bleibt aktiv');
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
