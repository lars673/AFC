// Thermiksäule aus dem Wettermodell ICON-CH1-EPS von MeteoSchweiz (Open Government Data, CC BY 4.0,
// «Quelle: MeteoSchweiz»). Open-Meteo liefert von diesem Modell nur Bodenwerte; für das Höhenprofil nutzt AFC dort
// DWD-ICON mit 7 Druckflächen. Hier holt AFC das ganze Profil (80 Schichten, 1 km Gitter) direkt von MeteoSchweiz
// und rechnet daraus je Startplatz und Stunde: wie hoch die Thermik reicht, wo die Wolkenbasis liegt, wie stark es
// steigt und wo die Sperrschicht (Inversion) beginnt.
//
// Datenweg: Die Dateien (GRIB2, eine Nachricht je Schicht, 16 Bit einfach gepackt, ~180 MB je Grösse und Stunde)
// liegen bei MeteoSchweiz/CSCS. Die Gitterzellen sind so nummeriert, dass alle Startplätze im Berner Oberland
// (und Payerne für den Ballonvergleich) in einem Fenster von rund 33 000 Zellen liegen. AFC liest deshalb mit
// HTTP-Range je Nachricht nur den Kopf (300 Bytes) und dieses Fenster (~65 KB) statt der ganzen Datei.
//
// Physik (wie bei Thermikprognosen üblich, Paketmethode auf der virtuellen potentiellen Temperatur):
//   - Druck in den Modellschichten hydrostatisch aus dem Bodendruck PS, den Schichthöhen HHL und T/QV
//   - Luftpaket am Boden mit θv aus T_2M/TD_2M plus Überwärmung aus dem Wärmestrom des Bodens (ASHFL_S)
//   - Thermikobergrenze: wo die Umgebung wärmer wird als das Paket
//   - w* (Deardorff) aus dem echten Wärmestrom des Modells statt aus einer Schätzung über die Sonne
//   - Wolkenbasis: Kondensationsniveau des Bodenpakets (q bleibt gleich, T sinkt trocken-adiabatisch)
//   - Inversion: stärkste Erwärmung mit der Höhe in den 1500 m über der Thermikobergrenze
import { httpGet } from './http.js';
import { isNum, zurichParts } from './util.js';
import { thermalSamples } from './learn.js';
import { gustAtLaunch } from './scoring.js';

const STAC = () => (process.env.AFC_ICONCH_STAC || 'https://data.geo.admin.ch/api/stac/v1').replace(/\/$/, '');
export const COLL = 'ch.meteoschweiz.ogd-forecasting-icon-ch1';
export const SOURCE = 'MeteoSchweiz ICON-CH1-EPS';
const G = 9.80665, RD = 287.05, CP = 1005, KAPPA = RD / CP;

/* ---------------------------------------------------------------- GRIB2 (nur was MeteoSchweiz hier liefert) */
/**
 * Kopf einer GRIB2-Nachricht lesen. buf: die ersten Bytes der Nachricht (300 reichen).
 * -> { len, ref:R, e:E, d:D, bits, data (Abstand des ersten Datenbytes vom Nachrichtenanfang), n, level, levelType, step }
 */
export function gribHead(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.toString('latin1', 0, 4) !== 'GRIB' || b[7] !== 2) throw new Error('keine GRIB2-Nachricht');
  const len = Number(b.readBigUInt64BE(8));
  const out = { len, discipline: b[6] };
  let p = 16;
  while (p + 5 <= b.length) {
    const sl = b.readUInt32BE(p), sn = b[p + 4];
    if (sn === 3 && p + 10 <= b.length) out.n = b.readUInt32BE(p + 6);
    if (sn === 4 && p + 34 <= b.length) {
      out.cat = b[p + 9]; out.num = b[p + 10];
      out.unit = b[p + 17]; out.step = b.readInt32BE(p + 18);
      out.levelType = b[p + 22];
      const sc = b.readInt8(p + 23), v = b.readUInt32BE(p + 24);
      out.level = sc ? v / 10 ** sc : v;
    }
    if (sn === 5) {
      if (b.readUInt16BE(p + 9) !== 0) throw new Error('GRIB2: nur einfache Packung (5.0) wird gelesen');
      out.n ??= b.readUInt32BE(p + 5);
      out.ref = b.readFloatBE(p + 11);
      out.e = signMag16(b.readUInt16BE(p + 15));
      out.d = signMag16(b.readUInt16BE(p + 17));
      out.bits = b[p + 19];
    }
    if (sn === 6 && b[p + 5] === 0) { out.bitmap = [p + 6, p + sl - 1]; out.data = p + sl + 5; return out; }   // Bitmap: Werte nur, wo gesetzt
    if (sn === 6 && b[p + 5] !== 255) throw new Error('GRIB2: diese Bitmap-Art wird nicht unterstützt');
    if (sn === 7) { out.data = p + 5; return out; }
    if (!(sl > 0)) break;
    p += sl;
  }
  throw new Error('GRIB2-Kopf unvollständig');
}
const signMag16 = v => (v & 0x8000 ? -(v & 0x7fff) : v);

/** Werte der Zellen lo..hi (einschliesslich) aus den Datenbytes ab Zelle lo. bits 0 = überall gleich (ref). */
export function gribValues(head, bytes, lo, hi) {
  const n = hi - lo + 1, out = new Float32Array(n);
  const f2 = 2 ** head.e, f10 = 10 ** -head.d;
  if (!head.bits) { out.fill(head.ref * f10); return out; }
  if (head.bits === 16) {
    for (let i = 0; i < n; i++) out[i] = (head.ref + ((bytes[2 * i] << 8) | bytes[2 * i + 1]) * f2) * f10;
    return out;
  }
  // allgemein: Bitstrom ab Zelle lo (lo*bits ist hier auf ein Byte ausgerichtet, siehe byteRange)
  const bits = head.bits, skip = (lo * bits) % 8;
  for (let i = 0; i < n; i++) {
    let x = 0;
    for (let k = 0; k < bits; k++) { const bit = skip + i * bits + k; x = (x << 1) | ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1); }
    out[i] = (head.ref + x * f2) * f10;
  }
  return out;
}
/** Byte-Bereich (relativ zum Nachrichtenanfang) mit den Zellen lo..hi. */
export function byteRange(head, lo, hi) {
  if (!head.bits) return null;
  const a = head.data + Math.floor((lo * head.bits) / 8), b = head.data + Math.ceil(((hi + 1) * head.bits) / 8) - 1;
  return [a, b];
}

/* ---------------------------------------------------------------- Lesen über HTTP-Range */
async function range(url, a, b) {
  const r = await fetch(url, { headers: { Range: `bytes=${a}-${b}`, 'User-Agent': 'AFC (+paragliding weather assistant)' }, signal: AbortSignal.timeout(60000) });
  if (r.status !== 206 && r.status !== 200) throw new Error(`MeteoSchweiz-Daten: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (r.status === 200) return buf.subarray(a, b + 1);   // Server ohne Range: ganze Antwort, Ausschnitt nehmen
  const total = Number((r.headers.get('content-range') || '').split('/')[1]);
  return Object.assign(buf, { total });
}
async function retry(fn, n = 3) {
  let last;
  for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { last = e; await new Promise(r => setTimeout(r, 500 * (i + 1))); } }
  throw last;
}
/** Kleine Warteschlange: höchstens k Abfragen gleichzeitig. */
export function limiter(k) {
  let active = 0;
  const q = [];
  const next = () => { if (active >= k || !q.length) return; active++; const { fn, res, rej } = q.shift(); fn().then(res, rej).finally(() => { active--; next(); }); };
  return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}

/**
 * Alle Nachrichten einer Datei lesen, je nur das Zellfenster lo..hi.
 * maxMsgs: nur die ersten n Nachrichten (Schichten werden von oben nach unten gezählt; wer nur die unteren will,
 * gibt fromMsg an). -> [{ level, step, values: Float32Array(hi-lo+1) }]
 */
export async function readWindow(url, lo, hi, { fromMsg = 0, run = fn => fn() } = {}) {
  const first = await run(() => retry(() => range(url, 0, 299)));
  const h0 = gribHead(first), total = first.total;
  // Gleich lange Nachrichten (der Normalfall bei den Prognosen): Lage aller Nachrichten bekannt
  const uniform = total && total % h0.len === 0;
  const offs = [];
  if (uniform) for (let o = 0; o < total; o += h0.len) offs.push(o);
  else {
    // ungleich lang (z. B. Konstanten): von Kopf zu Kopf gehen
    let o = 0;
    while (o < total) { const h = o ? gribHead(await run(() => retry(() => range(url, o, o + 299)))) : h0; offs.push(o); o += h.len; }
  }
  const out = [];
  await Promise.all(offs.map(async (o, k) => {
    if (k < fromMsg) return;
    const head = k === 0 ? h0 : gribHead(await run(() => retry(() => range(url, o, o + 299))));
    if (head.bitmap) { out[k] = { level: head.level, step: head.step, values: await bitmapWindow(url, o, head, lo, hi, run) }; return; }
    const br = byteRange(head, lo, hi);
    const bytes = br ? await run(() => retry(() => range(url, o + br[0], o + br[1]))) : null;
    out[k] = { level: head.level, step: head.step, values: gribValues(head, bytes, lo, hi) };
  }));
  return out.filter(Boolean);
}

/** Fenster einer Nachricht mit Bitmap: gepackt sind nur die gesetzten Zellen, fehlende werden NaN. */
async function bitmapWindow(url, o, head, lo, hi, run) {
  const bm = await run(() => retry(() => range(url, o + head.bitmap[0], o + head.bitmap[1])));
  const set = i => (bm[i >> 3] >> (7 - (i & 7))) & 1;
  let rank = 0;
  for (let i = 0; i < lo; i++) rank += set(i);
  const n = hi - lo + 1, out = new Float32Array(n).fill(NaN);
  let cnt = 0;
  for (let i = lo; i <= hi; i++) cnt += set(i);
  if (!cnt) return out;
  const br = byteRange(head, rank, rank + cnt - 1);
  const packed = br ? gribValues(head, await run(() => retry(() => range(url, o + br[0], o + br[1]))), rank, rank + cnt - 1) : gribValues(head, null, 0, cnt - 1);
  for (let i = lo, j = 0; i <= hi; i++) if (set(i)) out[i - lo] = packed[j++];
  return out;
}

/* ---------------------------------------------------------------- STAC: welche Dateien gibt es */
export async function search(body, coll = COLL) {
  const items = [];
  let url = `${STAC()}/search`, payload = { collections: [coll], limit: 100, ...body };
  for (let page = 0; page < 20 && url; page++) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/geo+json', 'User-Agent': 'AFC (+paragliding weather assistant)' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`MeteoSchweiz-Katalog: HTTP ${r.status}`);
    const d = await r.json();
    items.push(...(d.features || []));
    const nx = (d.links || []).find(l => l.rel === 'next');
    url = nx?.href || null; payload = nx?.body ? { ...payload, ...nx.body } : null;
    if (!payload) url = null;
  }
  return items;
}
export const hoursOf = iso => { const m = String(iso || '').match(/P(\d+)DT(\d+)H/); return m ? +m[1] * 24 + +m[2] : NaN; };
export const horizonIso = h => `P${Math.floor(h / 24)}DT${String(h % 24).padStart(2, '0')}H00M00S`;

/**
 * Dateien eines Laufs: { ref (ms), files: { VAR: { step(h): url } } } für den neuesten Lauf, in dem alle gewünschten
 * Grössen für alle gewünschten Stunden schon liegen.
 */
export async function latestRun(vars, wantSteps, now = Date.now()) {
  const probe = await search({ 'forecast:variable': vars[0], 'forecast:perturbed': false, 'forecast:horizon': horizonIso(0) });
  const refs = [...new Set(probe.map(f => f.properties['forecast:reference_datetime']))].filter(r => Date.parse(r) <= now).sort().reverse();
  for (const ref of refs.slice(0, 3)) {
    const refMs = Date.parse(ref), steps = new Set(wantSteps(refMs));
    const files = {};
    let ok = true;
    for (const v of vars) {
      const items = await search({ 'forecast:variable': v, 'forecast:perturbed': false, 'forecast:reference_datetime': ref });
      files[v] = {};
      for (const f of items) {
        const h = hoursOf(f.properties['forecast:horizon']);
        if (steps.has(h)) files[v][h] = Object.values(f.assets || {})[0]?.href;
      }
      if (Object.keys(files[v]).length < steps.size) { ok = false; break; }
    }
    if (ok) return { ref: refMs, files, steps: [...steps].sort((a, b) => a - b) };
  }
  return null;
}

/** Dateien einer Grösse eines Laufs je Vorlaufstunde: { step(h): url }. perturbed: die 10 gestörten Varianten (eine Datei, je Variante eine Nachricht). */
export async function filesOf(refMs, v, perturbed = false) {
  const items = await search({ 'forecast:variable': v, 'forecast:perturbed': perturbed, 'forecast:reference_datetime': new Date(refMs).toISOString().replace('.000', '') });
  const out = {};
  for (const f of items) out[hoursOf(f.properties['forecast:horizon'])] = Object.values(f.assets || {})[0]?.href;
  return out;
}

/* ---------------------------------------------------------------- Gitter: welche Zellen gehören zu welchem Ort */
/** Zellen im Umkreis (km) um jeden Ort. lat/lon: Float32Array aller Zellen. -> { lo, hi, byKey: {key: [idx]} } */
export function pickCells(lat, lon, places, radiusKm = 2) {
  const byKey = {};
  let lo = Infinity, hi = -Infinity;
  for (const p of places) {
    const cosl = Math.cos(p.lat * Math.PI / 180), r2 = (radiusKm / 111.2) ** 2;
    let near = [], best = -1, bd = Infinity;
    for (let i = 0; i < lat.length; i++) {
      const dy = lat[i] - p.lat; if (dy * dy > r2) continue;
      const dx = (lon[i] - p.lon) * cosl, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
      if (d <= r2) near.push(i);
    }
    if (!near.length && best >= 0) near = [best];
    byKey[p.key] = { cells: near, nearest: best };
    for (const i of near) { lo = Math.min(lo, i); hi = Math.max(hi, i); }
  }
  return { lo, hi, byKey };
}

/* ---------------------------------------------------------------- Physik */
const esat = tc => 6.112 * Math.exp((17.67 * tc) / (tc + 243.5));            // hPa, über Wasser
const qFromTd = (tdK, pHa) => { const e = esat(tdK - 273.15); return (0.622 * e) / (pHa - 0.378 * e); };
const tdFromQ = (q, pHa) => { const e = (q * pHa) / (0.622 + 0.378 * q), l = Math.log(Math.max(e, 1e-6) / 6.112); return (243.5 * l) / (17.67 - l); }; // °C
const thetaV = (tK, pHa, q) => tK * (1000 / pHa) ** KAPPA * (1 + 0.608 * q);

/**
 * Profil einer Zelle aufbereiten. hhl: Halbschicht-Höhen von oben nach unten (n+1), T/QV: Vollschichten (n, oben
 * nach unten), ps in Pa. -> [{z, p (hPa), t (°C), td (°C), tv (θv K)}] von unten nach oben.
 */
export function column(hhl, T, QV, ps) {
  const n = T.length, out = [];
  let p = ps / 100, zPrev = hhl[n];        // Boden
  for (let k = n - 1; k >= 0; k--) {
    const z = (hhl[k] + hhl[k + 1]) / 2, tv = T[k] * (1 + 0.608 * QV[k]);
    p *= Math.exp((-G * (z - zPrev)) / (RD * tv));   // hydrostatisch
    zPrev = z;
    out.push({ z, p, t: T[k] - 273.15, td: tdFromQ(QV[k], p), tv: thetaV(T[k], p, QV[k]) });
  }
  return out;
}

/**
 * Thermik einer Zelle. col: column(), s: Bodenwerte { zs, t2 (K), td2 (K), ps (Pa), shf (W/m², nach oben positiv) }.
 * -> { top, lcl, base, wstar, inv, invDt, excess } (Höhen in m ü. M.; top = Thermikobergrenze ohne Wolkenbegrenzung)
 */
export function cellThermal(col, s) {
  if (!col?.length || !isNum(s.t2) || !isNum(s.td2) || !isNum(s.ps)) return null;
  const pS = s.ps / 100, q2 = qFromTd(s.td2, pS), tvS = thetaV(s.t2, pS, q2);
  const rho = (pS * 100) / (RD * s.t2 * (1 + 0.608 * q2));
  const H = isNum(s.shf) ? s.shf : 0, wt = Math.max(0, H) / (rho * CP);   // kinematischer Wärmestrom K m/s
  // Kondensationsniveau des Bodenpakets: trocken-adiabatisch, Mischungsverhältnis bleibt
  let lcl = null;
  for (const l of col) {
    if (l.z <= s.zs) continue;
    const tp = s.t2 * (l.p / pS) ** KAPPA - 273.15, tdp = tdFromQ(q2, l.p);
    if (tp <= tdp) { lcl = l.z; break; }
  }
  if (lcl === null) lcl = s.zs + Math.max(0, 125 * (s.t2 - s.td2));
  if (!(H > 15)) return { top: Math.round(s.zs), lcl: Math.round(lcl), base: null, wstar: 0, inv: inversionAbove(col, s.zs), invDt: null, excess: 0, shf: Math.round(H) };
  // Obergrenze mit Überwärmung (Holtslag: 8.5·w'θ'/w*), zweimal nachgerechnet, weil w* von der Höhe abhängt
  let excess = 0.5, top = s.zs, wstar = 0;
  for (let it = 0; it < 3; it++) {
    top = s.zs;
    const tvP = tvS + excess;
    let prev = { z: s.zs, tv: tvS };
    for (const l of col) {
      if (l.z <= s.zs + 10) continue;
      if (l.tv > tvP) { top = prev.z + ((l.z - prev.z) * (tvP - prev.tv)) / (l.tv - prev.tv || 1e-6); break; }
      prev = l; top = l.z;
    }
    wstar = Math.cbrt((G / tvS) * wt * Math.max(0, top - s.zs));
    excess = Math.min(3, Math.max(0.2, wstar > 0.1 ? (8.5 * wt) / wstar : 0.5));
  }
  const inv = inversionAbove(col, top);
  return { top: Math.round(top), lcl: Math.round(lcl), base: lcl < top + 150 ? Math.round(lcl) : null, wstar: Math.round(wstar * 10) / 10, inv: inv?.z ?? null, invDt: inv?.dt ?? null, excess: Math.round(excess * 10) / 10, shf: Math.round(H) };
}
/** Stärkste Erwärmung mit der Höhe (mind. +0.3 K/100 m) in den 1500 m über z -> { z (Untergrenze), dt (K über die Schicht) }. */
export function inversionAbove(col, z0) {
  let best = null;
  for (let k = 1; k < col.length; k++) {
    const a = col[k - 1], b = col[k];
    if (a.z < z0 - 50 || a.z > z0 + 1500) continue;
    const g = (b.t - a.t) / (b.z - a.z);
    if (g < 0.003) continue;
    let top = k;   // Schicht nach oben fortsetzen, solange es wärmer wird
    while (top + 1 < col.length && col[top + 1].t >= col[top].t) top++;
    const dt = col[top].t - a.t;
    if (!best || dt > best.dt) best = { z: Math.round(a.z), dt: Math.round(dt * 10) / 10 };
  }
  return best;
}
const median = a => { const s = a.filter(isNum).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Ergebnis eines Ortes aus seinen Zellen (Median, damit einzelne Tal- oder Gratzellen nicht den Ausschlag geben). */
export function placeThermal(cells) {
  const ok = cells.filter(Boolean);
  if (!ok.length) return null;
  const pick = k => { const m = median(ok.map(c => c[k])); return m === null ? null : Math.round(m * (k === 'wstar' || k === 'invDt' ? 10 : 1)) / (k === 'wstar' || k === 'invDt' ? 10 : 1); };
  const cu = ok.filter(c => c.base !== null).length / ok.length;
  const bases = median(ok.map(c => c.base));
  return { top: pick('top'), lcl: pick('lcl'), base: cu >= 0.5 && bases !== null ? Math.round(bases) : null, wstar: pick('wstar'), inv: pick('inv'), invDt: pick('invDt'), shf: pick('shf'), cells: ok.length };
}

/* ---------------------------------------------------------------- Abholen und rechnen */
export const MULTI = ['T', 'QV'];
export const SINGLE = ['T_2M', 'TD_2M', 'PS', 'ASHFL_S', 'HBAS_SC', 'HTOP_SC', 'CAPE_ML', 'CIN_ML', 'CLCL', 'SNOWC', 'HZEROCL'];
export const TOP_Z = 7000;            // höher braucht die Thermik nicht

/** Welche Stunden (Vorlaufzeiten) des Laufs: 7 bis 20 Uhr Zürich, ab jetzt minus 1 h. */
export function stepsFor(refMs, now = Date.now(), maxStep = 33) {
  const out = [];
  for (let h = 0; h <= maxStep; h++) {
    const t = refMs + h * 3600000, zh = zurichParts(t).hour;
    if (t >= now - 3600000 && zh >= 7 && zh <= 20) out.push(h);
  }
  return out;
}

/**
 * Konstanten (Gitter, Bodenhöhe, Schichthöhen) für die Orte. Einmal holen, dann aus dem Zwischenspeicher.
 * places: [{key, lat, lon, alt}] -> { lo, hi, byKey, hsurf: Float32Array, hhl: [Float32Array] (oben->unten), fromMsg }
 */
/**
 * Für die Schneekarte: zu jeder Zelle eines Rasters (z.B. lib/terrain-grid.bin) die nächste ICON-Zelle.
 * -> { lo, hi, map: Int32Array (ICON-Index - lo, -1 = keine) } oder null.
 */
export function rasterCells(lat, lon, g) {
  const s = g.la0 - 0.02, n = g.la0 + (g.ny - 1) * g.dla + 0.02, w = g.lo0 - 0.03, e = g.lo0 + (g.nx - 1) * g.dlo + 0.03;
  const B = 0.01, bx = Math.ceil((e - w) / B) + 1, by = Math.ceil((n - s) / B) + 1, buckets = new Map();
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < lat.length; i++) {
    const la = lat[i], lx = lon[i];
    if (la < s || la > n || lx < w || lx > e) continue;
    const k = Math.floor((la - s) / B) * bx + Math.floor((lx - w) / B);
    (buckets.get(k) || buckets.set(k, []).get(k)).push(i);
    lo = Math.min(lo, i); hi = Math.max(hi, i);
  }
  if (!buckets.size) return null;
  const map = new Int32Array(g.nx * g.ny).fill(-1), cl = Math.cos(46.6 * Math.PI / 180);
  for (let y = 0; y < g.ny; y++) for (let x = 0; x < g.nx; x++) {
    const la = g.la0 + y * g.dla, lx = g.lo0 + x * g.dlo, cy = Math.floor((la - s) / B), cx = Math.floor((lx - w) / B);
    let best = -1, bd = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (cy + dy < 0 || cy + dy >= by || cx + dx < 0 || cx + dx >= bx) continue;
      for (const i of buckets.get((cy + dy) * bx + cx + dx) || []) { const d = (lat[i] - la) ** 2 + ((lon[i] - lx) * cl) ** 2; if (d < bd) { bd = d; best = i; } }
    }
    if (best >= 0 && bd < 0.02 ** 2) map[y * g.nx + x] = best - lo;
  }
  return { lo, hi, map, g: { la0: g.la0, lo0: g.lo0, dla: g.dla, dlo: g.dlo, nx: g.nx, ny: g.ny } };
}

export async function fetchGrid(places, { run = limiter(12), raster = null } = {}) {
  const coll = await (await httpGet(`${STAC()}/collections/${COLL}`, { accept: 'application/json', timeoutMs: 60000 })).json();
  const a = coll.assets || {};
  const href = k => Object.entries(a).find(([n]) => n.startsWith(k))?.[1]?.href;
  const hor = href('horizontal_constants'), ver = href('vertical_constants');
  if (!hor || !ver) throw new Error('MeteoSchweiz: Gitterkonstanten fehlen im Katalog');
  // Breite/Länge der Zellen: ganze Nachricht (alle Zellen) einmal lesen
  const n = (await headOf(hor)).n;
  const msgs = await readWindow(hor, 0, n - 1, { run });
  // Reihenfolge laut MeteoSchweiz: ..., HSURF (Index 4), ..., CLON (15), CLAT (16); zur Sicherheit über die Wertebereiche
  const lonM = msgs.find((m, i) => i === 15) || msgs.find(m => inRange(m.values, -1, 18) && !inRange(m.values, 41, 51));
  const latM = msgs.find((m, i) => i === 16) || msgs.find(m => inRange(m.values, 41, 51));
  const grid0 = pickCells(latM.values, lonM.values, places);
  // Nur Zellen auf ähnlicher Höhe wie der Startplatz (±500 m, sonst die 3 ähnlichsten): Gratzellen und tiefe
  // Talzellen haben eine andere Thermik als der Hang, an dem man startet
  const H = msgs[4].values;
  for (const p of places) {
    const pc = grid0.byKey[p.key];
    if (!isNum(p.alt) || pc.cells.length <= 3) continue;
    const near = pc.cells.filter(i => Math.abs(H[i] - p.alt) <= 500);
    pc.cells = near.length >= 3 ? near : [...pc.cells].sort((a, b) => Math.abs(H[a] - p.alt) - Math.abs(H[b] - p.alt)).slice(0, 3);
  }
  let lo = Infinity, hi = -Infinity;
  for (const pc of Object.values(grid0.byKey)) for (const i of [...pc.cells, pc.nearest]) { lo = Math.min(lo, i); hi = Math.max(hi, i); }
  const grid = { ...grid0, lo, hi };
  const hs = H.slice(grid.lo, grid.hi + 1);
  const hhlAll = await readWindow(ver, grid.lo, grid.hi, { run });
  // nur die Schichten, die irgendwo im Fenster unter TOP_Z liegen
  let fromMsg = 0;
  while (fromMsg < hhlAll.length - 2 && Math.min(...hhlAll[fromMsg + 1].values) > TOP_Z) fromMsg++;
  const rc = raster ? rasterCells(latM.values, lonM.values, raster) : null;
  if (rc) {
    // Für die 3D-Wolken: Schichthöhen an jeder 4. Rasterzelle (rund 1 km), nur Schichten unter TOP_Z, in ganzen Metern
    const g = rc.g, nx = Math.floor((g.nx - 1) / WIND_SUB) + 1, ny = Math.floor((g.ny - 1) / WIND_SUB) + 1, sub = new Int32Array(nx * ny);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) sub[y * nx + x] = rc.map[(y * WIND_SUB) * g.nx + x * WIND_SUB];
    const all = await readWindow(ver, rc.lo, rc.hi, { run });
    let from = 0;
    while (from < all.length - 2 && Math.min(...[...sub].filter(c => c >= 0).map(c => all[from + 1].values[c])) > TOP_Z) from++;
    const L = all.length - from, hh = new Int16Array(L * sub.length);
    for (let l = 0; l < L; l++) for (let k = 0; k < sub.length; k++) hh[l * sub.length + k] = sub[k] >= 0 ? Math.round(all[from + l].values[sub[k]]) : 0;
    Object.assign(rc, { sub, subG: { la0: g.la0, lo0: g.lo0, dla: g.dla * WIND_SUB, dlo: g.dlo * WIND_SUB, nx, ny }, hhlSub: hh, hhlFrom: from, hhlN: L });
  }
  return { lo: grid.lo, hi: grid.hi, byKey: grid.byKey, hsurf: hs, hhl: hhlAll.slice(fromMsg).map(m => m.values), fromMsg, levels: hhlAll.length - 1, raster: rc };
}
const inRange = (v, a, b) => { let mn = Infinity, mx = -Infinity; for (let i = 0; i < v.length; i += 997) { mn = Math.min(mn, v[i]); mx = Math.max(mx, v[i]); } return mn >= a && mx <= b; };
async function headOf(url) { return gribHead(await retry(() => range(url, 0, 299))); }

/**
 * Thermik für alle Orte und Stunden des neuesten Laufs.
 * grid: fetchGrid(); places: dieselben Orte. -> { ref, at, steps, byKey: { key: [{ t, top, base, lcl, wstar, inv, invDt, hbas, htop, cape, cin, clcl, snow, h0 }] }, profiles }
 */
export const WIND1 = ['U_10M', 'V_10M', 'VMAX_10M'];
export const WINDL = ['U', 'V'];       // Wind auf den Modellflächen (für Wind auf Starthöhe, 2000 und 3000 m)
/** Wind (u, v in m/s) auf Höhe z (m ü. M.) aus den Modellflächen; unter der untersten Fläche deren Wert, darüber null. */
export function windAt(hhl, U, V, z) {
  const n = U.length;
  let lo = null;
  for (let k = n - 1; k >= 0; k--) {
    const zk = (hhl[k] + hhl[k + 1]) / 2;
    if (!isNum(U[k]) || !isNum(V[k])) continue;
    if (zk >= z) {
      if (!lo) return [U[k], V[k]];
      const f = (z - lo.z) / (zk - lo.z || 1);
      return [lo.u + (U[k] - lo.u) * f, lo.v + (V[k] - lo.v) * f];
    }
    lo = { z: zk, u: U[k], v: V[k] };
  }
  return null;
}
/* Wettervarianten: Bodenwerte je Variante. Die Schichtung darüber kommt aus dem Hauptlauf (Mehrflächen-Daten aller
   Varianten wären zehnmal so viel); was die Varianten unterscheidet, sind vor allem Sonne, Wolken, Boden und Wind. */
export const ENS1 = ['T_2M', 'TD_2M', 'PS', 'ASHFL_S', 'U_10M', 'V_10M', 'VMAX_10M', 'TOT_PREC', 'CLCT'];
const ENS_CTL = ['TOT_PREC', 'CLCT'];   // fehlen im Hauptlauf noch (der Rest liegt schon vor)
const ENS_ACC = ['TOT_PREC', 'ASHFL_S']; // seit Laufbeginn aufsummiert bzw. gemittelt: es braucht auch die Stunde davor

/**
 * Eine Variante eines Ortes: Thermikobergrenze aus der Schichtung des Hauptlaufs mit den Bodenwerten der Variante,
 * Wind auf Starthöhe = Wind des Hauptlaufs + Unterschied der Variante am Boden, Böen am Start, Regen der Stunde (mm), Bewölkung (%).
 * -> [top, wind, dir, gust, rain, cloud, base] (base: Wolkenbasis, wenn Quellwolken)
 */
export function memberRow({ cells, cols, zs, t2, td2, ps, shf, u10, v10, g10, wl, cu10, cv10, rain, cloud }) {
  const r = placeThermal(cells.map((_, j) => cellThermal(cols[j], { zs: zs[j], t2: t2[j], td2: td2[j], ps: ps[j], shf: shf[j] })));
  let w = null, gust = null;
  if (wl && isNum(u10) && isNum(v10) && isNum(cu10) && isNum(cv10)) {
    w = windOf(wl[0] + u10 - cu10, wl[1] + v10 - cv10);
    gust = gustAtLaunch(w.wind, Math.hypot(u10, v10) * 3.6, isNum(g10) ? g10 * 3.6 : null);
  }
  const top = r ? (isNum(r.base) ? Math.min(r.top, r.base) : r.top) : null;
  return [isNum(top) ? Math.round(top) : null, w ? w.wind : null, w ? w.dir : null, isNum(gust) ? Math.round(gust) : null,
    isNum(rain) ? Math.round(Math.max(0, rain) * 10) / 10 : null, isNum(cloud) ? Math.round(cloud) : null, isNum(r?.base) ? Math.round(r.base) : null];
}
/** Alle Varianten eines Ortes (Hauptlauf zuerst) -> { n, m: [[top, wind, dir, gust, rain, cloud, base]] } */
function placeMembers(EM, idx, cols, i, wl, h, hsurf, shfCtl, sv) {
  const { P, Pp, C, Cp, n } = EM;
  const zs = idx.map(k => hsurf[k]);
  const acc = (a, b) => (isNum(a) && (h <= 1 || isNum(b)) ? a - (h > 1 ? b : 0) : null);
  const mean = (a, b) => (isNum(a) && (h <= 1 || isNum(b)) ? -(h * a - (h - 1) * (h > 1 ? b : 0)) : null);
  const rows = [];
  // Hauptlauf
  rows.push(memberRow({ cells: idx, cols, zs, t2: idx.map(k => sv.T_2M[k]), td2: idx.map(k => sv.TD_2M[k]), ps: idx.map(k => sv.PS[k]),
    shf: idx.map(k => mean(shfCtl[h]?.[k], shfCtl[h - 1]?.[k])), u10: C.U_10M[i], v10: C.V_10M[i], g10: C.VMAX_10M[i], wl, cu10: C.U_10M[i], cv10: C.V_10M[i],
    rain: acc(C.TOT_PREC[i], Cp.TOT_PREC?.[i]), cloud: C.CLCT[i] }));
  for (let m = 0; m < n; m++) {
    rows.push(memberRow({ cells: idx, cols, zs, t2: idx.map(k => P.T_2M[m][k]), td2: idx.map(k => P.TD_2M[m][k]), ps: idx.map(k => P.PS[m][k]),
      shf: idx.map(k => mean(P.ASHFL_S[m][k], Pp.ASHFL_S?.[m]?.[k])), u10: P.U_10M[m][i], v10: P.V_10M[m][i], g10: P.VMAX_10M[m][i], wl, cu10: C.U_10M[i], cv10: C.V_10M[i],
      rain: acc(P.TOT_PREC[m][i], Pp.TOT_PREC?.[m]?.[i]), cloud: P.CLCT[m][i] }));
  }
  return { n: rows.length, m: rows };
}
/**
 * Unterste Wolkenschicht einer Säule. hh: Halbschicht-Höhen oben->unten (n+1), clc: Bedeckung in % auf den Vollschichten
 * oben->unten (n). Eine Schicht beginnt, wo die Bedeckung min erreicht, und endet, wo sie darunter fällt.
 * -> { base, top, cov (grösste Bedeckung %) } oder null
 */
export function cloudLayer(hh, clc, min = 30) {
  let base = null, top = null, cov = 0;
  for (let k = clc.length - 1; k >= 0; k--) {
    const c = clc[k];
    if (isNum(c) && c >= min) { if (base === null) base = hh[k + 1]; top = hh[k]; cov = Math.max(cov, c); }
    else if (base !== null) break;
  }
  return base === null ? null : { base: Math.round(base), top: Math.round(top), cov: Math.round(Math.min(100, cov)) };
}
const WIND_SUB = 4;                   // Windkarte: jede 4. Zelle des Geländerasters (rund 1 km, wie ICON-CH1)
/** Wind (km/h, Richtung woher) aus u/v in m/s. */
export const windOf = (u, v) => ({ wind: Math.round(Math.hypot(u, v) * 36) / 10, dir: Math.round((Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360) });

export async function fetchThermals(grid, places, { now = Date.now(), run = limiter(16), log = () => {}, stations = [], members = false } = {}) {
  const lr = await latestRun([...MULTI, ...WINDL, ...SINGLE, ...(grid.raster || members ? WIND1 : []), ...(grid.raster?.hhlSub ? ['CLC'] : [])], ref => stepsFor(ref, now), now);
  if (!lr) throw new Error('MeteoSchweiz ICON-CH1: noch kein vollständiger Lauf');
  // Wärmestrom ist ein Mittel seit Laufbeginn: für die Stunde h braucht es auch h-1
  const shfSteps = [...new Set(lr.steps.flatMap(h => [h, h - 1]).filter(h => h >= 0))];
  const shfFiles = (await search({ 'forecast:variable': 'ASHFL_S', 'forecast:perturbed': false, 'forecast:reference_datetime': new Date(lr.ref).toISOString().replace('.000', '') }))
    .reduce((o, f) => { o[hoursOf(f.properties['forecast:horizon'])] = Object.values(f.assets || {})[0]?.href; return o; }, {});
  const { lo, hi, fromMsg } = grid;
  const single = async (v, h) => (await readWindow(lr.files[v]?.[h] || (v === 'ASHFL_S' ? shfFiles[h] : null), lo, hi, { run }))[0].values;
  const shf = {};
  await Promise.all(shfSteps.map(async h => { if (h === 0) { shf[0] = null; return; } shf[h] = await single('ASHFL_S', h); }));
  const byKey = Object.fromEntries(places.map(p => [p.key, []]));
  const profiles = Object.fromEntries(places.map(p => [p.key, []]));
  // Wettervarianten (ICON-CH1-EPS: Hauptlauf + 10 gestörte Läufe): dieselben Bodenwerte je Variante, für «wie sicher»
  let ef = null;
  if (members) {
    try {
      const ref = lr.ref;
      const [pert, ctl] = await Promise.all([
        Promise.all(ENS1.map(v => filesOf(ref, v, true))),
        Promise.all(ENS_CTL.map(v => filesOf(ref, v, false)))
      ]);
      ef = { p: Object.fromEntries(ENS1.map((v, k) => [v, pert[k]])), c: Object.fromEntries(ENS_CTL.map((v, k) => [v, ctl[k]])) };
    } catch (e) { log('Varianten: ' + e.message); ef = null; }
  }
  const stepMembers = async h => {
    if (!ef) return null;
    const need = (o, v) => o[v]?.[h] && (!ENS_ACC.includes(v) || h <= 1 || o[v]?.[h - 1]);
    if (!ENS1.every(v => need(ef.p, v)) || !ENS_CTL.every(v => need(ef.c, v))) return null;
    try {
      const rd = (url, k) => readWindow(url, lo, hi, { run }).then(ms => ms.map(m => m.values));
      const P = {}, Pp = {}, C = {}, Cp = {};
      await Promise.all([
        ...ENS1.map(async v => { P[v] = await rd(ef.p[v][h]); if (ENS_ACC.includes(v) && h > 1) Pp[v] = await rd(ef.p[v][h - 1]); }),
        ...ENS_CTL.map(async v => { C[v] = (await rd(ef.c[v][h]))[0]; if (ENS_ACC.includes(v) && h > 1) Cp[v] = (await rd(ef.c[v][h - 1]))[0]; }),
        ...WIND1.map(async v => { C[v] = (await rd(lr.files[v][h]))[0]; })
      ]);
      const n = Math.min(...ENS1.map(v => P[v].length));
      return n >= 5 ? { P, Pp, C, Cp, n } : null;
    } catch (e) { log(`Varianten +${h}: ${e.message}`); return null; }
  };
  for (const h of lr.steps) {
    const t = lr.ref + h * 3600000;
    const [Tm, Qm, Um, Vm, EM, ...S] = await Promise.all([
      readWindow(lr.files.T[h], lo, hi, { fromMsg, run }), readWindow(lr.files.QV[h], lo, hi, { fromMsg, run }),
      readWindow(lr.files.U[h], lo, hi, { fromMsg, run }), readWindow(lr.files.V[h], lo, hi, { fromMsg, run }),
      stepMembers(h),
      ...SINGLE.filter(v => v !== 'ASHFL_S').map(v => single(v, h))
    ]);
    const sv = Object.fromEntries(SINGLE.filter(v => v !== 'ASHFL_S').map((v, i) => [v, S[i]]));
    // Stundenmittel des Wärmestroms aus den Mitteln seit Laufbeginn; ICON zählt nach unten positiv
    const hourShf = i => { const a = shf[h]?.[i], b = h > 1 ? shf[h - 1]?.[i] : 0; return isNum(a) && isNum(b) ? -(h * a - (h - 1) * b) : null; };
    const wUV = (i, z) => windAt(grid.hhl.map(l => l[i]), Um.map(m => m.values[i]), Vm.map(m => m.values[i]), z);
    const wAt = (i, z) => { const w = wUV(i, z); return w ? windOf(w[0], w[1]) : null; };
    for (const p of places) {
      const pc = grid.byKey[p.key];
      if (p.st) {
        // Messstation: nur Wind auf Stationshöhe (10 m über Grund), zum Prüfen gegen die Messung
        const i = pc.nearest - lo;
        byKey[p.key].push({ t, wl: wAt(i, p.alt + 10), zs: Math.round(grid.hsurf[i]) });
        continue;
      }
      const cols = pc.cells.map(ci => { const i = ci - lo; return column(grid.hhl.map(l => l[i]), Tm.map(m => m.values[i]), Qm.map(m => m.values[i]), sv.PS[i]); });
      const cellRes = pc.cells.map((ci, j) => { const i = ci - lo; return cellThermal(cols[j], { zs: grid.hsurf[i], t2: sv.T_2M[i], td2: sv.TD_2M[i], ps: sv.PS[i], shf: hourShf(i) }); });
      const r = placeThermal(cellRes);
      const i = pc.nearest - lo, one = (v, f = x => x) => (isNum(sv[v]?.[i]) ? f(sv[v][i]) : null);
      const hb = one('HBAS_SC'), ht = one('HTOP_SC');
      const zg = Math.max(p.alt ?? grid.hsurf[i], grid.hsurf[i]);
      const wl = wUV(i, zg + 30);
      byKey[p.key].push({ t, ...r, wl: wl ? windOf(wl[0], wl[1]) : null, w2000: zg < 1900 ? wAt(i, 2000) : null, w3000: zg < 2900 ? wAt(i, 3000) : null, hbas: hb > 0 ? Math.round(hb) : null, htop: ht > 0 ? Math.round(ht) : null, cape: one('CAPE_ML', Math.round), cin: one('CIN_ML', Math.round),
        clcl: one('CLCL', Math.round), snow: one('SNOWC', Math.round), h0: one('HZEROCL', Math.round), zs: Math.round(grid.hsurf[i]),
        ens: EM && wl ? placeMembers(EM, pc.cells.map(ci => ci - lo), cols, i, wl, h, grid.hsurf, shf, sv) : null });
      // Profil der nächsten Zelle für die Anzeige (Temperatur und Taupunkt bis 6000 m)
      const col = column(grid.hhl.map(l => l[i]), Tm.map(m => m.values[i]), Qm.map(m => m.values[i]), sv.PS[i]);
      profiles[p.key].push({ t, z: col.filter(l => l.z <= 6000).map(l => Math.round(l.z)), tc: col.filter(l => l.z <= 6000).map(l => Math.round(l.t * 10) / 10), td: col.filter(l => l.z <= 6000).map(l => Math.round(l.td * 10) / 10) });
    }
    log(`Stunde +${h} fertig`);
  }
  // Bodenwind (10 m) und Böen: an den Messstationen (zum Prüfen gegen die Messung) und als feine Windkarte (rund 1 km)
  let wind10 = null, st = null, cloud3 = null;
  if (grid.raster?.map && grid.raster.g) {
    try {
      const R = grid.raster, g = R.g, cellOf = (lat, lon) => { const x = Math.round((lon - g.lo0) / g.dlo), y = Math.round((lat - g.la0) / g.dla); return x < 0 || y < 0 || x >= g.nx || y >= g.ny ? -1 : R.map[y * g.nx + x]; };
      const sts = stations.map(s => ({ ...s, c: cellOf(s.lat, s.lon) })).filter(s => s.c >= 0);
      const nx = Math.floor((g.nx - 1) / WIND_SUB) + 1, ny = Math.floor((g.ny - 1) / WIND_SUB) + 1, sub = [];
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) sub.push(R.map[(y * WIND_SUB) * g.nx + x * WIND_SUB]);
      wind10 = { grid: { la0: g.la0, lo0: g.lo0, dla: g.dla * WIND_SUB, dlo: g.dlo * WIND_SUB, nx, ny }, t: [], u: [], v: [], gust: [], shf: [] };
      // 3D-Wolken: unterste Wolkenschicht je km (Basis, Obergrenze, Bedeckung) aus der Bedeckung auf den Modellflächen
      const c3 = R.hhlSub && lr.files.CLC ? { grid: wind10.grid, t: [], base: [], top: [], cov: [] } : null;
      if (c3) cloud3 = c3;
      // Die Bedeckungsdateien haben ungleich lange Nachrichten: der Weg von Kopf zu Kopf dauert, darum mehrere Stunden gleichzeitig
      const cloudStep = async h => {
        try {
          const C = await readWindow(lr.files.CLC[h], R.lo, R.hi, { fromMsg: R.hhlFrom, run });
          const ns = R.sub.length, L = R.hhlN, b = [], tp = [], cv = [];
          if (C.length !== L - 1) throw new Error(`${C.length} Schichten statt ${L - 1}`);
          for (let k = 0; k < ns; k++) {
            const c = R.sub[k];
            const lay = c >= 0 ? cloudLayer(Array.from({ length: L }, (_, l) => R.hhlSub[l * ns + k]), C.map(m => m.values[c])) : null;
            b.push(lay ? lay.base : null); tp.push(lay ? lay.top : null); cv.push(lay ? lay.cov : 0);
          }
          return { t: lr.ref + h * 3600000, b, tp, cv };
        } catch (e) { log(`3D-Wolken +${h}: ${e.message}`); return null; }
      };
      const cloudJobs = c3 ? (async () => {
        const out = new Array(lr.steps.length);
        let next = 0;
        await Promise.all(Array.from({ length: 5 }, async () => { while (next < lr.steps.length) { const i = next++; out[i] = await cloudStep(lr.steps[i]); } }));
        return out;
      })() : null;
      // Wärmestrom (W/m², Stundenmittel, nach oben positiv) für die eigene Thermikkarte: wie viel Wärme der Boden wirklich an die Luft gibt
      const shfR = new Map(), shfRaster = async hh => {
        if (hh <= 0) return null;
        if (!shfR.has(hh)) shfR.set(hh, readWindow(lr.files.ASHFL_S?.[hh] || shfFiles[hh], R.lo, R.hi, { run }).then(m => m[0].values).catch(() => null));
        return shfR.get(hh);
      };
      st = Object.fromEntries(sts.map(s => [s.code, []]));
      for (const h of lr.steps) {
        const [U, V, G, A, B] = await Promise.all([...WIND1.map(async v => (await readWindow(lr.files[v][h], R.lo, R.hi, { run }))[0].values), shfRaster(h), shfRaster(h - 1)]);
        if (shfR.has(h - 2)) shfR.delete(h - 2);
        const hs = c => { if (c < 0 || !A || !isNum(A[c])) return null; const b = h > 1 ? B?.[c] : 0; return isNum(b) ? Math.round(-(h * A[c] - (h - 1) * b)) : null; };
        wind10.shf.push(h > 0 ? sub.map(hs) : sub.map(() => null));
        const t = lr.ref + h * 3600000, r1 = x => (isNum(x) ? Math.round(x * 36) / 10 : null);
        wind10.t.push(t); wind10.u.push(sub.map(c => (c >= 0 ? r1(U[c]) : null))); wind10.v.push(sub.map(c => (c >= 0 ? r1(V[c]) : null))); wind10.gust.push(sub.map(c => (c >= 0 ? r1(G[c]) : null)));
        for (const s of sts) {
          if (!isNum(U[s.c]) || !isNum(V[s.c])) continue;
          // Station deutlich über dem Modellboden (Gipfel, Grat): Wind auf Stationshöhe aus den Modellflächen statt 10 m über dem geglätteten Boden
          const lv = byKey['st:' + s.code]?.find(x => x.t === t), high = lv?.wl && isNum(s.alt) && s.alt - lv.zs > 150;
          st[s.code].push({ t, ...(high ? lv.wl : windOf(U[s.c], V[s.c])), gust: isNum(G[s.c]) ? Math.round(G[s.c] * 36) / 10 : null, src: high ? 'level' : '10m' });
        }
      }
      if (cloudJobs) for (const r of await cloudJobs) if (r) { cloud3.t.push(r.t); cloud3.base.push(r.b); cloud3.top.push(r.tp); cloud3.cov.push(r.cv); }
    } catch (e) { log('Wind: ' + e.message); wind10 = null; st = null; cloud3 = null; }
  }
  // Schneekarte (Anteil Schnee je Rasterzelle, 0-100) für die eigene Thermikkarte, aus der ersten Stunde des Laufs
  let snow = null;
  if (grid.raster?.map) {
    try {
      const h = lr.steps[0], v = (await readWindow(lr.files.SNOWC[h], grid.raster.lo, grid.raster.hi, { run }))[0].values, m = grid.raster.map;
      const out = new Uint8Array(m.length).fill(255);
      for (let k = 0; k < m.length; k++) if (m[k] >= 0 && isNum(v[m[k]])) out[k] = Math.max(0, Math.min(100, Math.round(v[m[k]])));
      snow = { t: lr.ref + h * 3600000, data: Buffer.from(out).toString('base64') };
    } catch (e) { log('Schneekarte: ' + e.message); }
  }
  return { ref: lr.ref, at: Date.now(), steps: lr.steps, byKey, profiles, snow, wind10, cloud3, stations: st, source: SOURCE };
}

/* ---------------------------------------------------------------- Analyse (KENDA-CH1): so war es wirklich */
/* KENDA-CH1 ist die stündliche Analyse von MeteoSchweiz: das Modell mit allen Messungen (Stationen, Ballone, Flugzeuge,
   Radar, Satellit) zusammengeführt. Gleiches 1-km-Gitter wie ICON-CH1, rund 2 Stunden nach der Zeit bereit. */
export const KENDA = 'ch.meteoschweiz.ogd-analysis-kenda-ch1';
export const KENDA_SOURCE = 'MeteoSchweiz KENDA-CH1 (Analyse)';
const KENDA_NOW = ['T_2M', 'TD_2M', 'PS', 'U_10M', 'V_10M'];
const isoRef = ms => new Date(ms).toISOString().replace('.000', '');

/** Neueste Analysezeit (ms), für die alle Grössen bereitliegen, nicht älter als maxAgeH. */
export async function latestAnalysis(now = Date.now(), maxAgeH = 6) {
  for (let k = 1; k <= maxAgeH; k++) {
    const ref = Math.floor(now / 3600000) * 3600000 - k * 3600000;
    const items = await search({ 'forecast:reference_datetime': isoRef(ref), 'forecast:variable': 'T' }, KENDA);
    if (items.length) return ref;
  }
  return null;
}

/**
 * Thermiksäule und Wind auf Starthöhe aus der Analyse einer Stunde, für dieselben Orte wie die Prognose.
 * grid: fetchGrid() (dasselbe Gitter). -> { t, byKey: { key: { top, base, lcl, wstar, inv, wl, zs, shf } }, source }
 */
export async function fetchAnalysis(grid, places, { ref, run = limiter(16) } = {}) {
  const one = async (v, r = ref, horizon = 0) => {
    const it = await search({ 'forecast:reference_datetime': isoRef(r), 'forecast:variable': v, 'forecast:horizon': horizonIso(horizon) }, KENDA);
    const href = Object.values(it[0]?.assets || {})[0]?.href;
    if (!href) throw new Error(`KENDA-CH1: ${v} fehlt`);
    return href;
  };
  const { lo, hi, fromMsg } = grid;
  const [Tu, Qu, Uu, Vu, Hu, ...Su] = await Promise.all([one('T'), one('QV'), one('U'), one('V'), one('ASHFL_S', ref - 3600000, 1).catch(() => null), ...KENDA_NOW.map(v => one(v))]);
  const [Tm, Qm, Um, Vm, H, ...S] = await Promise.all([
    readWindow(Tu, lo, hi, { fromMsg, run }), readWindow(Qu, lo, hi, { fromMsg, run }), readWindow(Uu, lo, hi, { fromMsg, run }), readWindow(Vu, lo, hi, { fromMsg, run }),
    Hu ? readWindow(Hu, lo, hi, { run }).then(m => m[0].values) : null,
    ...Su.map(u => readWindow(u, lo, hi, { run }).then(m => m[0].values))
  ]);
  if (Tm.length !== grid.hhl.length - 1) throw new Error(`KENDA-CH1: ${Tm.length} Schichten statt ${grid.hhl.length - 1}`);
  const sv = Object.fromEntries(KENDA_NOW.map((v, i) => [v, S[i]]));
  const byKey = {};
  for (const p of places) {
    const pc = grid.byKey[p.key];
    if (!pc || p.st) continue;
    const cols = pc.cells.map(ci => { const i = ci - lo; return column(grid.hhl.map(l => l[i]), Tm.map(m => m.values[i]), Qm.map(m => m.values[i]), sv.PS[i]); });
    const r = placeThermal(pc.cells.map((ci, j) => { const i = ci - lo; return cellThermal(cols[j], { zs: grid.hsurf[i], t2: sv.T_2M[i], td2: sv.TD_2M[i], ps: sv.PS[i], shf: H && isNum(H[i]) ? -H[i] : null }); }));
    const i = pc.nearest - lo, zg = Math.max(p.alt ?? grid.hsurf[i], grid.hsurf[i]);
    const w = windAt(grid.hhl.map(l => l[i]), Um.map(m => m.values[i]), Vm.map(m => m.values[i]), zg + 30);
    byKey[p.key] = { ...r, wl: w ? windOf(w[0], w[1]) : null, zs: Math.round(grid.hsurf[i]) };
  }
  return { t: ref, at: Date.now(), byKey, source: KENDA_SOURCE };
}

/* ---------------------------------------------------------------- Prüfen gegen echte Flüge */
/**
 * Alt gegen neu: Wie weit lag die Thermikobergrenze daneben, gemessen an der höchsten Thermik der IGC-Flüge?
 * fcOld/fcNew: Map("site|datum|stunde" -> {top}). Nur Flüge, für die beide eine Prognose haben.
 * -> { n, old: {mae, bias}, neu: {mae, bias} } oder { n } wenn noch keine Flüge
 */
export function compareTops(flights, fcOld, fcNew) {
  const a = new Map(thermalSamples(flights, fcOld).map(s => [`${s.siteId}|${s.date}`, s.diff]));
  const pairs = thermalSamples(flights, fcNew).filter(s => a.has(`${s.siteId}|${s.date}`)).map(s => [a.get(`${s.siteId}|${s.date}`), s.diff]);
  if (!pairs.length) return { n: 0 };
  const st = k => ({ mae: Math.round(pairs.reduce((x, p) => x + Math.abs(p[k]), 0) / pairs.length), bias: Math.round(pairs.reduce((x, p) => x + p[k], 0) / pairs.length) });
  return { n: pairs.length, old: st(0), neu: st(1) };
}

/** Mittlere Abweichung Wind, Böen und Richtung (Richtung nur ab 8 km/h gemessen): alt (Open-Meteo) gegen neu (ICON-CH1). */
export function windCompare(rows) {
  const m = (f, ok = () => true) => { const v = rows.filter(r => ok(r) && isNum(f(r))).map(f); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10 : null; };
  const ad = (a, b) => (isNum(a) && isNum(b) ? Math.abs(((a - b + 540) % 360) - 180) : null), strong = r => r.ow >= 8;
  return { n: rows.length,
    old: { wind: m(r => Math.abs(r.pw - r.ow)), gust: m(r => (isNum(r.pg) && isNum(r.og) ? Math.abs(r.pg - r.og) : null)), dir: m(r => ad(r.pd, r.od), strong) },
    neu: { wind: m(r => Math.abs(r.iw - r.ow)), gust: m(r => (isNum(r.ig) && isNum(r.og) ? Math.abs(r.ig - r.og) : null)), dir: m(r => ad(r.idr, r.od), strong) } };
}
