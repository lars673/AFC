// Messstationen (SwissMetNet) und Abruf aktueller Messwerte.
import { httpGet } from './http.js';
import { haversineKm, toIsoTime, isNum } from './util.js';

/** Feste Kernstationen: für die regionale Lage (Föhn/Bise/Talwind) unverzichtbar. */
export const CORE_STATIONS = {
  GRH: { name: 'Grimsel Hospiz', lat: 46.571689, lon: 8.333256, alt: 1980 },
  THU: { name: 'Thun', lat: 46.749853, lon: 7.585222, alt: 570 },
  INT: { name: 'Interlaken', lat: 46.6655, lon: 7.8706, alt: 577 },
  ABO: { name: 'Adelboden', lat: 46.491703, lon: 7.560703, alt: 1321 },
  MER: { name: 'Meiringen', lat: 46.732222, lon: 8.169247, alt: 589 },
  GTT: { name: 'Guttannen', lat: 46.566, lon: 8.294, alt: 1055 },
  KAS: { name: 'Kandersteg', lat: 46.5, lon: 7.67, alt: 1176 },
  BER: { name: 'Bern/Zollikofen', lat: 46.9907, lon: 7.4649, alt: 553 },
  GUE: { name: 'Gütsch', lat: 46.655, lon: 8.618, alt: 2283 }
};

const BBOX = { latMin: 46.3, latMax: 47.0, lonMin: 7.2, lonMax: 8.7 };
const MAX_STATIONS = 28;

export function parseCSVLine(line, sep = ';') {
  const o = []; let c = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { c += '"'; i++; } else q = !q; }
    else if (ch === sep && !q) { o.push(c); c = ''; } else c += ch;
  }
  o.push(c);
  return o;
}

/**
 * Stationsliste: Kernstationen plus Stationen aus der Metadatei der MeteoSchweiz im Berner Oberland.
 * Die Metadatei wird tolerant nach Spaltennamen gelesen; schlägt das fehl, bleiben die Kernstationen.
 */
export async function loadStationList() {
  const list = Object.fromEntries(Object.entries(CORE_STATIONS).map(([code, s]) => [code, { code, ...s, core: true }]));
  let note = null;
  try {
    const url = process.env.AFC_STATION_META_URL || 'https://data.geo.admin.ch/ch.meteoschweiz.ogd-smn/ogd-smn_meta_stations.csv';
    const text = (await (await httpGet(url, { accept: 'text/csv' })).text()).replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const sep = lines[0].includes(';') ? ';' : ',';
    const h = parseCSVLine(lines[0], sep).map(s => s.trim().toLowerCase());
    const col = re => h.findIndex(x => re.test(x));
    const ci = col(/^station_abbr$|^abbr/), ni = col(/^station_name$|name/);
    const lai = col(/lat/), loi = col(/lon/), hi = col(/height_masl|altitude|height/);
    if (ci < 0 || lai < 0 || loi < 0) throw new Error('Spalten nicht erkannt');
    const extra = [];
    for (const line of lines.slice(1)) {
      const r = parseCSVLine(line, sep);
      const code = String(r[ci] || '').trim().toUpperCase();
      const lat = Number(String(r[lai]).replace(',', '.')), lon = Number(String(r[loi]).replace(',', '.'));
      const alt = Number(String(r[hi] ?? '').replace(',', '.'));
      if (!/^[A-Z0-9]{3}$/.test(code) || list[code] || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (lat < BBOX.latMin || lat > BBOX.latMax || lon < BBOX.lonMin || lon > BBOX.lonMax) continue;
      extra.push({ code, name: String(r[ni] || code).trim(), lat, lon, alt: Number.isFinite(alt) ? alt : null, core: false });
    }
    extra.sort((a, b) => haversineKm(46.68, 7.9, a.lat, a.lon) - haversineKm(46.68, 7.9, b.lat, b.lon));
    for (const s of extra.slice(0, MAX_STATIONS - Object.keys(list).length)) if (isNum(s.alt)) list[s.code] = s;
    note = `Metadaten: ${Object.keys(list).length} Stationen`;
  } catch (e) { note = `Metadaten nicht lesbar (${e.message}), nur Kernstationen`; }
  return { list, note };
}

function parseObsCSV(text, want) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const hi = lines.findIndex(x => /station_abbr|Station\/Location|(^|;)stn(;|$)/.test(x) && /reference_timestamp|ReferenceTS|Date|(^|;)time(;|$)/.test(x));
  if (hi < 0) throw new Error('Messwert-Header nicht erkannt');
  const h = parseCSVLine(lines[hi]).map(s => s.trim());
  const idx = n => h.indexOf(n);
  const si = ['station_abbr', 'Station/Location', 'stn'].map(idx).find(i => i >= 0);
  const ti = ['reference_timestamp', 'ReferenceTS', 'Date', 'time'].map(idx).find(i => i >= 0);
  if (si == null || ti == null) throw new Error('Messwert-Spalten nicht erkannt');
  const out = {};
  for (const line of lines.slice(hi + 1)) {
    const r = parseCSVLine(line), code = String(r[si] || '').trim().toUpperCase();
    if (!want.has(code)) continue;
    const time = toIsoTime(r[ti]);
    if (!time) continue;
    const num = names => {
      const ii = names.map(idx).find(i => i >= 0);
      if (ii == null) return null;
      const raw = String(r[ii] ?? '').trim();
      if (!raw || raw === '-') return null;
      const n = Number(raw.replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    };
    const row = { code, time, wind: num(['fu3010z0']), gust: num(['fu3010z1']), dir: num(['dkl010z0']), temp: num(['tre200s0']), rh: num(['ure200s0']), pressure: num(['prestas0']), dew: num(['tde200s0']), sun: num(['gre000z0']), precip: num(['rre150z0']) };
    if (!out[code] || row.time > out[code].time) out[code] = row;
  }
  if (!Object.keys(out).length) throw new Error('keine passenden Stationen in der Datei');
  return out;
}
export { parseObsCSV };

const SMN = () => (process.env.AFC_SMN_URL || 'https://data.geo.admin.ch').replace(/\/$/, '');

/** Aktuelle Messwerte: zuerst die Sammeldatei, sonst pro Station. Liefert { data, source }. */
export async function fetchObservations(stationCodes) {
  const want = new Set(stationCodes);
  const errors = [];
  try {
    const r = await httpGet(`${SMN()}/ch.meteoschweiz.messwerte-aktuell/VQHA80.csv`, { accept: 'text/csv' });
    return { data: parseObsCSV(await r.text(), want), source: 'VQHA80' };
  } catch (e) { errors.push('VQHA80: ' + e.message); }
  const out = {};
  const res = await Promise.allSettled([...want].map(async code => {
    const c = code.toLowerCase();
    const r = await httpGet(`${SMN()}/ch.meteoschweiz.ogd-smn/${c}/ogd-smn_${c}_t_now.csv`, { accept: 'text/csv', retries: 0 });
    return parseObsCSV(await r.text(), new Set([code]))[code] || null;
  }));
  res.forEach(x => { if (x.status === 'fulfilled' && x.value) out[x.value.code] = x.value; });
  if (Object.keys(out).length) return { data: out, source: 'OGD-SMN' };
  errors.push('OGD-SMN: keine Station');
  throw new Error(errors.join(' | '));
}

/** Offizieller Föhnindex der MeteoSchweiz; Fehler sind nicht kritisch. */
export async function fetchFoehnIndex() {
  const r = await httpGet(`${SMN()}/ch.meteoschweiz.messwerte-foehn-10min/ch.meteoschweiz.messwerte-foehn-10min_en.json`, { accept: 'application/json' });
  const d = await r.json(), o = {};
  for (const f of d.features || []) o[String(f.id || f.properties?.station_abbr || '').toUpperCase()] = f.properties || {};
  return o;
}
