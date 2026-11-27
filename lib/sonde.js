// Wetterballon Payerne (MeteoSchweiz, Open Government Data, CC BY 4.0, «Quelle: MeteoSchweiz»).
// Zweimal am Tag (00 und 12 UTC) misst die Sonde Temperatur, Taupunkt und Wind bis weit über 10 km. MeteoSchweiz
// stellt immer nur die letzte Messung hin, AFC speichert deshalb jede selbst. Gebraucht wird sie, um das Höhenprofil
// der Modelle nachzuprüfen: Wie gut lagen Temperatur, Sperrschicht (Inversion) und Thermikobergrenze?
import { httpGet } from './http.js';
import { isNum } from './util.js';

const URL_ = () => process.env.AFC_SONDE_URL || 'https://data.geo.admin.ch/ch.meteoschweiz.messwerte/radiosondierungen/VZUS01.csv';
export const PAYERNE = { key: 'PAY', name: 'Payerne', lat: 46.8116, lon: 6.9425, alt: 491 };

/** VZUS01.csv lesen -> { time (ms), levels: [{p, z, t, td, dir, ff}] } von unten nach oben, oder null. */
export function parseSonde(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  const hi = lines.findIndex(l => /\bzreppzs0\b/.test(l));
  if (hi < 0) return null;
  const head = lines[hi].trim().split(/\s+/), ix = n => head.indexOf(n);
  const c = { time: ix('zzzztttt'), p: ix('zreppps0'), z: ix('zreppzs0'), t: ix('zrettts0'), td: ix('zretdes0'), dir: ix('zklddds0'), ff: ix('zklfffs0') };
  if (c.z < 0 || c.t < 0) return null;
  const num = v => (v === undefined || v === '/' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  let time = null;
  const levels = [];
  for (const l of lines.slice(hi + 1)) {
    const v = l.trim().split(/\s+/);
    if (v.length < head.length - 2) continue;
    const ts = v[c.time];
    if (/^\d{12}$/.test(ts || '')) time ??= Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12));
    const lv = { p: num(v[c.p]), z: num(v[c.z]), t: num(v[c.t]), td: num(v[c.td]), dir: num(v[c.dir]), ff: num(v[c.ff]) };
    if (isNum(lv.z) && isNum(lv.t)) levels.push(lv);
  }
  levels.sort((a, b) => a.z - b.z);
  // doppelte Höhen (Normflächen und signifikante Punkte) zusammenlegen
  const out = [];
  for (const l of levels) { const last = out[out.length - 1]; if (last && Math.abs(last.z - l.z) < 1) Object.assign(last, Object.fromEntries(Object.entries(l).filter(([, x]) => x !== null))); else out.push({ ...l }); }
  return time && out.length >= 5 ? { time, levels: out } : null;
}

export async function fetchSonde() {
  const r = await httpGet(URL_(), { accept: 'text/csv', timeoutMs: 30000 });
  return parseSonde(new TextDecoder('latin1').decode(await r.arrayBuffer()));
}

/** Wert bei Höhe z (linear zwischen den Punkten), sonst null. */
export function at(levels, z, k = 't') {
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1], b = levels[i];
    if (z >= a.z && z <= b.z && isNum(a[k]) && isNum(b[k])) return a[k] + ((b[k] - a[k]) * (z - a.z)) / (b.z - a.z || 1);
  }
  return null;
}

/** Stärkste Inversion (mind. +0.5 K) zwischen zLo und zHi -> { z (Untergrenze), dt } oder null. */
export function inversion(levels, zLo, zHi) {
  let best = null;
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1];
    if (a.z < zLo || a.z > zHi) continue;
    let k = i;
    while (k < levels.length && levels[k].t >= levels[k - 1].t) k++;
    const dt = levels[k - 1].t - a.t;
    if (k - 1 > i - 1 && dt >= 0.5 && (!best || dt > best.dt)) best = { z: Math.round(a.z), dt: Math.round(dt * 10) / 10 };
  }
  return best;
}

/**
 * Modellprofil mit der Messung vergleichen (500 bis 4000 m ü. M., alle 100 m).
 * prof: { z:[], tc:[], td:[] } (wie lib/iconch.js speichert). -> { mae, bias, n, invSonde, invModel, invDz }
 */
export function compareProfile(prof, sonde, { zLo = 500, zHi = 4000 } = {}) {
  if (!prof?.z?.length || !sonde?.levels?.length) return null;
  const m = prof.z.map((z, i) => ({ z, t: prof.tc[i], td: prof.td?.[i] }));
  let s = 0, sa = 0, n = 0;
  for (let z = zLo; z <= zHi; z += 100) {
    const a = at(m, z), b = at(sonde.levels, z);
    if (!isNum(a) || !isNum(b)) continue;
    s += a - b; sa += Math.abs(a - b); n++;
  }
  if (!n) return null;
  const iS = inversion(sonde.levels, zLo, zHi), iM = inversion(m, zLo, zHi);
  return { mae: Math.round((sa / n) * 100) / 100, bias: Math.round((s / n) * 100) / 100, n, invSonde: iS, invModel: iM, invDz: iS && iM ? iM.z - iS.z : null };
}
