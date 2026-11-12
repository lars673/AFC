// Wettervarianten (Ensemble): dasselbe Modell mehrmals mit leicht anderen Startwerten gerechnet.
// Liegen die Varianten eng beieinander, ist die Prognose sicher; gehen sie auseinander, sagt AFC das offen
// ("in 3 von 21 Varianten Bise") statt den ganzen Tag vorsorglich zu sperren (Lars, 12.11.2026).
import { httpGet } from './http.js';
import { omTimeToMs, isNum } from './util.js';

const BASE = () => (process.env.AFC_ENSEMBLE_URL || 'https://ensemble-api.open-meteo.com').replace(/\/$/, '');
export const ENS_VARS = ['wind_speed_10m', 'wind_gusts_10m', 'precipitation', 'pressure_msl', 'cape'];
// Die Namen der Modelle hat Open-Meteo schon geändert: der Reihe nach probieren, das erste, das antwortet, gilt.
// MeteoSwiss ICON-CH2-EPS: 21 Varianten, 2 km, 5 Tage. Danach das ICON-Ensemble des DWD (40 Varianten).
export const ENS_MODELS = ['meteoswiss_icon_ch2_eps', 'meteoswiss_icon_ch2_ensemble', 'meteoswiss_icon_ch2', 'dwd_icon_seamless_eps', 'icon_seamless_eps', 'icon_seamless'];
const CHUNK = 16;
export const ENS_MIN = 8;   // weniger Varianten sind keine Statistik

/**
 * Open-Meteo-Antwort eines Punktes -> { t:[ms], elevation, m: { variable: [ [Wert je Stunde] je Variante ] } }.
 * Schlüssel: "wind_gusts_10m" (Variante 0) und "wind_gusts_10m_member01" ..., je nach Abfrage mit Modellnamen dahinter.
 */
export function parseEnsemble(d, vars = ENS_VARS) {
  const h = d?.hourly;
  if (!h?.time?.length) return null;
  const out = { t: h.time.map(omTimeToMs), elevation: isNum(d.elevation) ? d.elevation : null, m: {} };
  const byLen = [...vars].sort((a, b) => b.length - a.length);
  for (const k of Object.keys(h)) {
    const v = byLen.find(x => k === x || k.startsWith(x + '_'));
    if (!v) continue;
    const rest = k.slice(v.length);
    if (rest && !/^(_member\d+)?(_(meteoswiss|dwd|icon|ecmwf|gfs|gem|ukmo|bom|ncep)[a-z0-9_]*)?$/.test(rest)) continue;
    const mm = rest.match(/_member(\d+)/), idx = mm ? Number(mm[1]) : 0;
    if (!Array.isArray(h[k]) || !h[k].some(isNum)) continue;
    (out.m[v] ||= [])[idx] = h[k];
  }
  for (const v of Object.keys(out.m)) out.m[v] = out.m[v].filter(Boolean);
  return Object.keys(out.m).length ? out : null;
}

const coords = pts => `latitude=${pts.map(p => p.lat.toFixed(4)).join(',')}&longitude=${pts.map(p => p.lon.toFixed(4)).join(',')}`;

/**
 * Varianten für viele Punkte. model: zuletzt erfolgreiches Modell (zuerst probiert).
 * -> { byId, model, members, errors }
 */
export async function fetchEnsemble(points, { days = 3, model = null } = {}) {
  const order = model ? [model, ...ENS_MODELS.filter(m => m !== model)] : ENS_MODELS;
  const errors = [];
  for (const m of order) {
    const byId = {};
    let failed = false;
    for (let i = 0; i < points.length && !failed; i += CHUNK) {
      const chunk = points.slice(i, i + CHUNK);
      try {
        const r = await httpGet(`${BASE()}/v1/ensemble?${coords(chunk)}&hourly=${ENS_VARS.join(',')}&models=${m}&forecast_days=${days}&timezone=UTC&wind_speed_unit=kmh`, { accept: 'application/json' });
        const raw = await r.json();
        const arr = Array.isArray(raw) ? raw : [raw];
        chunk.forEach((p, k) => { const e = parseEnsemble(arr[k]); if (e) byId[p.id] = e; });
      } catch (e) { errors.push(`${m}: ${e.message}`); failed = true; }
    }
    const members = Math.max(0, ...Object.values(byId).map(e => e.m.wind_gusts_10m?.length || 0));
    if (!failed && members >= ENS_MIN) return { byId, model: m, members, errors };
    if (!failed) errors.push(`${m}: nur ${members} Varianten`);
  }
  return { byId: {}, model: null, members: 0, errors };
}

/** Index der Stunde ms in einer Variantenreihe (oder -1). */
export function ensIdx(e, ms) {
  if (!e?.t?.length) return -1;
  const i = Math.round((ms - e.t[0]) / 3600000);
  return i >= 0 && i < e.t.length && Math.abs(e.t[i] - ms) < 1800000 ? i : -1;
}

/** Werte aller Varianten einer Variable zur Stunde i (nur Zahlen). */
export function membersAt(e, v, i) {
  const rows = e?.m?.[v];
  if (!rows || i < 0) return [];
  const out = [];
  for (const r of rows) if (isNum(r[i])) out.push(r[i]);
  return out;
}

export const quantile = (arr, q) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b), p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
  return s[lo] + (s[hi] - s[lo]) * (p - lo);
};
/** Anteil der Varianten, für die f gilt (0..1). */
export const share = (arr, f) => (arr.length ? arr.filter(f).length / arr.length : null);

/**
 * Druckunterschied je Variante (gleiche Variante an beiden Orten): a minus b plus gelernte Abweichung.
 * Varianten sind an allen Orten dieselben Rechenläufe, darum darf man sie paarweise abziehen.
 */
export function pairDiff(ea, eb, ms, bias = 0) {
  const ia = ensIdx(ea, ms), ib = ensIdx(eb, ms);
  const A = ea?.m?.pressure_msl, B = eb?.m?.pressure_msl;
  if (ia < 0 || ib < 0 || !A || !B) return [];
  const out = [];
  for (let k = 0; k < Math.min(A.length, B.length); k++) if (isNum(A[k][ia]) && isNum(B[k][ib])) out.push(A[k][ia] - B[k][ib] + bias);
  return out;
}

/** "3 von 21" aus einem Anteil. */
export const ofN = (p, n) => `${Math.round(p * n)} von ${n}`;

/**
 * Selbstprüfung (wie lib/learn.js): Wenn AFC «Bise unter 10 %» sagte, wie oft kam sie trotzdem?
 * rows: [{ p, hit }] (p = Anteil der Varianten mit Bise mindestens 2 h vorher, hit = im Oberland gemessen).
 * Erst ab 20 Stunden mit kleiner Wahrscheinlichkeit wird geprüft; kam die Bise dort in mehr als 15 % trotzdem,
 * lockert AFC wegen der Varianten nicht mehr.
 */
export function ensembleCheck(rows) {
  const low = rows.filter(r => r.p <= 0.1), hi = rows.filter(r => r.p >= 0.5);
  const rate = a => (a.length ? Math.round(a.filter(r => r.hit).length / a.length * 100) : null);
  const n = low.length, miss = rate(low);
  const ok = n < 20 || miss <= 15;
  return { n, miss, nHi: hi.length, hitHi: rate(hi), ok, mode: n < 20 ? 'lernt' : ok ? 'bestätigt' : 'aus' };
}
