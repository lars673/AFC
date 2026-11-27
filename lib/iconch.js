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
async function search(body) {
  const items = [];
  let url = `${STAC()}/search`, payload = { collections: [COLL], limit: 100, ...body };
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
const hoursOf = iso => { const m = String(iso || '').match(/P(\d+)DT(\d+)H/); return m ? +m[1] * 24 + +m[2] : NaN; };
export const horizonIso = h => `P${Math.floor(h / 24)}DT${String(h % 24).padStart(2, '0')}H00M00S`;

/**
 * Dateien eines Laufs: { ref (ms), files: { VAR: { step(h): url } } } für den neuesten Lauf, in dem alle gewünschten
 * Grössen für alle gewünschten Stunden schon liegen.
 */
export async function latestRun(vars, wantSteps, now = Date.now()) {
  const probe = await search({ 'forecast:variable': vars[0], 'forecast:perturbed': false, 'forecast:horizon': horizonIso(0) });
  const refs = [...new Set(probe.map(f => f.properties['forecast:reference_datetime']))].sort().reverse();
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
  return { lo, hi, map };
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
  return { lo: grid.lo, hi: grid.hi, byKey: grid.byKey, hsurf: hs, hhl: hhlAll.slice(fromMsg).map(m => m.values), fromMsg, levels: hhlAll.length - 1, raster: rc };
}
const inRange = (v, a, b) => { let mn = Infinity, mx = -Infinity; for (let i = 0; i < v.length; i += 997) { mn = Math.min(mn, v[i]); mx = Math.max(mx, v[i]); } return mn >= a && mx <= b; };
async function headOf(url) { return gribHead(await retry(() => range(url, 0, 299))); }

/**
 * Thermik für alle Orte und Stunden des neuesten Laufs.
 * grid: fetchGrid(); places: dieselben Orte. -> { ref, at, steps, byKey: { key: [{ t, top, base, lcl, wstar, inv, invDt, hbas, htop, cape, cin, clcl, snow, h0 }] }, profiles }
 */
export async function fetchThermals(grid, places, { now = Date.now(), run = limiter(16), log = () => {} } = {}) {
  const lr = await latestRun([...MULTI, ...SINGLE], ref => stepsFor(ref, now), now);
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
  for (const h of lr.steps) {
    const t = lr.ref + h * 3600000;
    const [Tm, Qm, ...S] = await Promise.all([
      readWindow(lr.files.T[h], lo, hi, { fromMsg, run }), readWindow(lr.files.QV[h], lo, hi, { fromMsg, run }),
      ...SINGLE.filter(v => v !== 'ASHFL_S').map(v => single(v, h))
    ]);
    const sv = Object.fromEntries(SINGLE.filter(v => v !== 'ASHFL_S').map((v, i) => [v, S[i]]));
    // Stundenmittel des Wärmestroms aus den Mitteln seit Laufbeginn; ICON zählt nach unten positiv
    const hourShf = i => { const a = shf[h]?.[i], b = h > 1 ? shf[h - 1]?.[i] : 0; return isNum(a) && isNum(b) ? -(h * a - (h - 1) * b) : null; };
    for (const p of places) {
      const pc = grid.byKey[p.key];
      const cellRes = pc.cells.map(ci => {
        const i = ci - lo;
        const col = column(grid.hhl.map(l => l[i]), Tm.map(m => m.values[i]), Qm.map(m => m.values[i]), sv.PS[i]);
        return cellThermal(col, { zs: grid.hsurf[i], t2: sv.T_2M[i], td2: sv.TD_2M[i], ps: sv.PS[i], shf: hourShf(i) });
      });
      const r = placeThermal(cellRes);
      const i = pc.nearest - lo, one = (v, f = x => x) => (isNum(sv[v]?.[i]) ? f(sv[v][i]) : null);
      const hb = one('HBAS_SC'), ht = one('HTOP_SC');
      byKey[p.key].push({ t, ...r, hbas: hb > 0 ? Math.round(hb) : null, htop: ht > 0 ? Math.round(ht) : null, cape: one('CAPE_ML', Math.round), cin: one('CIN_ML', Math.round),
        clcl: one('CLCL', Math.round), snow: one('SNOWC', Math.round), h0: one('HZEROCL', Math.round), zs: Math.round(grid.hsurf[i]) });
      // Profil der nächsten Zelle für die Anzeige (Temperatur und Taupunkt bis 6000 m)
      const col = column(grid.hhl.map(l => l[i]), Tm.map(m => m.values[i]), Qm.map(m => m.values[i]), sv.PS[i]);
      profiles[p.key].push({ t, z: col.filter(l => l.z <= 6000).map(l => Math.round(l.z)), tc: col.filter(l => l.z <= 6000).map(l => Math.round(l.t * 10) / 10), td: col.filter(l => l.z <= 6000).map(l => Math.round(l.td * 10) / 10) });
    }
    log(`Stunde +${h} fertig`);
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
  return { ref: lr.ref, at: Date.now(), steps: lr.steps, byKey, profiles, snow, source: SOURCE };
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
