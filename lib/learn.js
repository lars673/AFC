// Selbstlernen mit Selbstprüfung. Zwei Teile:
// 1. learnedVerdict: Der wöchentliche Rückblick-Test läuft mit und ohne das Gelernte (Böen an Bergstationen).
//    Wird es mit dem Gelernten gefährlicher (mehr «gefährlich» oder klar mehr «zu mild»), wird das Lernen pausiert.
// 2. thermalLearn: Aus IGC-Flügen lernen, wie hoch die Thermik je Gebiet wirklich ging, verglichen mit der
//    Prognose zur Flugzeit (site_fc). Übernommen wird eine Korrektur nur, wenn sie die vergangenen Flüge
//    besser erklärt hätte als gar keine Korrektur (Prüfung je Flug ohne diesen Flug, «leave one out»).

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Vergleich zweier Rückblick-Zusammenfassungen: ohne (base) und mit Lernen (withL). */
export function learnedVerdict(base, withL) {
  const danger = x => (x?.gefaehrlich ?? 0) + (x?.berg?.gefaehrlich ?? 0);
  const mild = x => x?.berg?.zuMild ?? 0;
  if (danger(withL) > danger(base)) return { off: true, reason: `mit dem Gelernten ${danger(withL)} gefährliche Fälle, ohne ${danger(base)}` };
  if (mild(withL) > mild(base) + 1) return { off: true, reason: `mit dem Gelernten ${mild(withL)}× «zu mild» am Berg, ohne ${mild(base)}` };
  return { off: false, reason: `mit dem Gelernten ${danger(withL)} gefährlich / ${mild(withL)} zu mild, ohne ${danger(base)} / ${mild(base)}` };
}

/** Selbstprüfung in Stufen: alles behalten, nur das Einfache, oder pausieren (Vergleich mit dem Lauf ohne Lernen). */
export function chooseLearnMode(base, simple, withL) {
  const full = learnedVerdict(base, withL), easy = simple ? learnedVerdict(base, simple) : { off: true, reason: 'kein Lauf' };
  const mode = !full.off ? 'full' : !easy.off ? 'simple' : 'off';
  return { mode, off: mode === 'off', reason: mode === 'full' ? full.reason : mode === 'simple' ? `Details nicht bestätigt (${full.reason}), nur das Einfache: ${easy.reason}` : full.reason };
}

export const THERMAL_MIN_N = 3, THERMAL_MAX_UP = 500, THERMAL_MAX_DOWN = 300, THERMAL_DAYS = 730;

/**
 * Pro Flug: höchste Thermik-Obergrenze aus der IGC-Spur gegen die höchste prognostizierte Thermik-Obergrenze
 * während der Flugstunden. fc: Map `${siteId}|${date}|${hour}` -> thermalTop (m ü. M.).
 * siteArea: siteId -> Gebiet. Ergebnis je Gebiet: { n, median, add, checked, why }.
 */
export function thermalSamples(flights, fc) {
  const out = [];
  const topOf = v => (isNum(v) ? v : v?.top), wsOf = v => (isNum(v) ? null : v?.wstar);
  for (const f of flights) {
    const th = f.track?.thermals;
    if (!f.siteId || !Array.isArray(th) || !th.length || !f.start) continue;
    const obsTop = Math.max(...th.map(t => t.alt).filter(isNum));
    const rates = th.map(t => t.rate).filter(r => isNum(r) && r > 0);
    const h0 = Number(f.start.slice(0, 2)), h1 = Math.min(21, h0 + Math.max(0, Math.ceil((f.durMin || 0) / 60)));
    const fcs = [], ws = [];
    for (let h = h0; h <= h1; h++) {
      const v = fc.get(`${f.siteId}|${f.date}|${h}`);
      if (isNum(topOf(v))) fcs.push(topOf(v));
      if (isNum(wsOf(v)) && wsOf(v) > 0.3) ws.push(wsOf(v));
    }
    if (!isNum(obsTop) || !fcs.length) continue;
    // Steigen: Mittel der Bärte gegen das prognostizierte Steigen (w*) als Verhältnis
    const climb = rates.length >= 2 && ws.length ? (rates.reduce((a, b) => a + b, 0) / rates.length) / Math.max(...ws) : null;
    out.push({ siteId: f.siteId, date: f.date, diff: obsTop - Math.max(...fcs), climb: isNum(climb) ? Math.min(3, climb) : null });
  }
  return out;
}

export const CLIMB_MIN = 0.75, CLIMB_MAX = 1.3;
/** Faktor fürs Steigen je Gebiet: nur wenn er die übrigen Flüge besser erklärt hätte; schwächer nur halb (vorsichtig). */
function climbLearn(ratios) {
  const n = ratios.length;
  if (n < THERMAL_MIN_N) return { n, factor: 1 };
  const fit = xs => { const m = median(xs); return Math.min(CLIMB_MAX, Math.max(CLIMB_MIN, m >= 1 ? 1 + (m - 1) * 0.6 : 1 + (m - 1) * 0.5)); };
  let eW = 0, e0 = 0;
  ratios.forEach((r, i) => { eW += Math.abs(Math.log(r / fit(ratios.filter((_, j) => j !== i)))); e0 += Math.abs(Math.log(r)); });
  const factor = eW < e0 * 0.9 ? Math.round(fit(ratios) * 20) / 20 : 1;
  return { n, factor, median: Math.round(median(ratios) * 100) / 100 };
}

const clampAdd = m => Math.round(Math.max(-THERMAL_MAX_DOWN, Math.min(THERMAL_MAX_UP, m)) / 50) * 50;

export function thermalLearn(flights, fc, siteArea, now = Date.now()) {
  const from = new Date(now - THERMAL_DAYS * 86400000).toISOString().slice(0, 10);
  const by = {}, cl = {};
  for (const s of thermalSamples(flights.filter(f => f.date >= from), fc)) {
    const a = siteArea[s.siteId];
    if (!a) continue;
    (by[a] ||= []).push(s.diff);
    if (isNum(s.climb) && s.climb > 0) (cl[a] ||= []).push(s.climb);
  }
  const out = {};
  for (const [area, diffs] of Object.entries(by)) {
    const n = diffs.length, med = Math.round(median(diffs));
    if (n < THERMAL_MIN_N) { out[area] = { n, median: med, add: 0, climb: cl[area] ? climbLearn(cl[area]) : null, why: `erst ${n} von ${THERMAL_MIN_N} Flügen` }; continue; }
    // Hätte die Korrektur aus den übrigen Flügen jeden Flug besser getroffen als keine Korrektur?
    let errWith = 0, errWithout = 0;
    diffs.forEach((d, i) => { const rest = diffs.filter((_, j) => j !== i); errWith += Math.abs(d - clampAdd(median(rest))); errWithout += Math.abs(d); });
    const better = errWith < errWithout * 0.9;
    // Weniger hoch geflogen heisst nicht sicher: weniger Thermik (man verlässt sie auch früher). Nach unten nur halb.
    const add = better ? clampAdd(med > 0 ? med * 0.6 : med * 0.3) : 0;
    out[area] = { n, median: med, add, climb: cl[area] ? climbLearn(cl[area]) : null, why: better ? `${n} Flüge, im Mittel ${med > 0 ? '+' : ''}${med} m gegenüber der Prognose` : `${n} Flüge, aber zu unterschiedlich für eine Korrektur` };
  }
  return out;
}

/* ---------------------------------------------------------------- Lernen aus Messwerten (ohne Flüge)
 * Jede Stunde vergleicht AFC die Prognose am Stationsort mit der Messung. Daraus lernt es je Station, wie stark
 * die Böen meist danebenliegen: insgesamt und je Tageszeit und Windrichtung («am Nachmittag bei West mehr»).
 * Jüngere Tage zählen mehr (Halbwertszeit 7 Tage). Kleine Gruppen werden zum Stationsmittel hin gezogen.
 * Übernommen wird nur, was sich bewährt: Für jeden Tag wird aus den übrigen Tagen gelernt und geprüft, ob die
 * Korrektur diesen Tag besser getroffen hätte. Nur wenn ja, gilt sie (mode 'bucket', 'overall' oder 'none').
 */
export const STATION_DAYS = 30, STATION_HALF_DAYS = 7, SHRINK_K = 4, STATION_MIN_N = 30;   // SHRINK_K in gewichteten Stunden
const DAY_MS = 86400000;
export const blockOf = h => (h >= 9 && h <= 11 ? 'am' : h >= 12 && h <= 14 ? 'mid' : h >= 15 && h <= 18 ? 'pm' : null);
const SECTORS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
export const sectorOf = (dir, speed) => (!isNum(dir) || !(speed >= 5) ? 'ruhig' : SECTORS[Math.round((((dir % 360) + 360) % 360) / 45) % 8]);
export const BLOCK_NAMES = { am: 'Vormittag', mid: 'Mittag', pm: 'Nachmittag' };

function fitStation(samples, f = 'd') {
  let sw = 0, s = 0;
  const b = {};
  for (const x of samples) {
    const v = x[f];
    if (!isNum(v)) continue;
    sw += x.w; s += x.w * v;
    const o = (b[x.k] ||= { sw: 0, s: 0, n: 0 });
    o.sw += x.w; o.s += x.w * v; o.n++;
  }
  const overall = sw ? s / (sw + SHRINK_K) : 0;   // zu 0 hin gezogen
  const buckets = {};
  for (const [k, o] of Object.entries(b)) buckets[k] = { n: o.n, v: (o.s + SHRINK_K * overall) / (o.sw + SHRINK_K) };
  return { overall, buckets };
}
const predict = (fit, mode, k) => (mode === 'none' ? 0 : mode === 'bucket' ? (fit.buckets[k]?.v ?? fit.overall) : fit.overall);
const r1 = v => Math.round(v * 10) / 10;
/** Für jeden Tag aus den übrigen Tagen lernen und prüfen (leave one day out). Ergebnis: mode, mae0, mae, gain. */
function validate(xs, f) {
  const ys = xs.filter(x => isNum(x[f])), days = [...new Set(ys.map(x => x.day))];
  if (ys.length < STATION_MIN_N || days.length < 4) return { mode: 'none', mae0: null, mae: null, gain: 0 };
  const err = { none: 0, overall: 0, bucket: 0 };
  let wsum = 0;
  for (const day of days) {
    const fit = fitStation(ys.filter(x => x.day !== day), f);
    for (const x of ys) if (x.day === day) {
      for (const m of Object.keys(err)) err[m] += x.w * Math.abs(x[f] - predict(fit, m, x.k));
      wsum += x.w;
    }
  }
  for (const m of Object.keys(err)) err[m] /= wsum;
  const mode = err.bucket < err.overall * 0.97 && err.bucket < err.none * 0.95 ? 'bucket' : err.overall < err.none * 0.95 ? 'overall' : 'none';
  return { mode, mae0: r1(err.none), mae: r1(err[mode]), gain: r1(err.none - err[mode]) };
}

/**
 * rows: [{ code, ms, hour, pg, pw, pd, og, ow }] (Prognose p, Messung o). Ergebnis je Station:
 * { n, days, gust, mode, buckets: { 'pm|W': { n, gust } }, mae0, mae, gain,
 *   wind: { mode, avg, buckets: { k: { n, v } }, mae0, mae, gain } }   (Grundwind, gleich geprüft)
 */
export function stationLearn(rows, now = Date.now()) {
  const from = now - STATION_DAYS * DAY_MS, by = {};
  for (const r of rows) {
    if (!(r.ms >= from && r.ms < now) || !isNum(r.og) || !isNum(r.pg)) continue;
    const blk = blockOf(r.hour);
    if (!blk) continue;
    (by[r.code] ||= []).push({ day: Math.floor((r.ms + 3600000) / DAY_MS), k: `${blk}|${sectorOf(r.pd, r.pw)}`, d: r.og - r.pg, wd: isNum(r.ow) && isNum(r.pw) ? r.ow - r.pw : null, w: 0.5 ** ((now - r.ms) / (STATION_HALF_DAYS * DAY_MS)) });
  }
  const out = {};
  for (const [code, xs] of Object.entries(by)) {
    const fit = fitStation(xs, 'd'), fw = fitStation(xs, 'wd'), days = new Set(xs.map(x => x.day)).size;
    const vg = validate(xs, 'd'), vw = validate(xs, 'wd');
    const buckets = {}, wb = {};
    for (const [k, b] of Object.entries(fit.buckets)) if (b.n >= 6) buckets[k] = { n: b.n, gust: r1(b.v) };
    for (const [k, b] of Object.entries(fw.buckets)) if (b.n >= 6) wb[k] = { n: b.n, v: r1(b.v) };
    out[code] = { n: xs.length, days, gust: r1(fit.overall), ...vg, buckets, wind: { ...vw, avg: r1(fw.overall), buckets: wb } };
  }
  return out;
}

/** Korrektur der Böen für eine Stunde und Windrichtung, so wie die Station es gelernt hat (km/h, + = mehr Böen). */
export function stationCorrection(l, hour, dir, speed) {
  const mode = l?.mode ?? 'overall';
  if (!l || mode === 'none' || !(l.n >= STATION_MIN_N) || !isNum(l.gust)) return null;
  const blk = blockOf(hour);
  if (!blk) return null;
  const k = `${blk}|${sectorOf(dir, speed)}`, b = mode === 'bucket' ? l.buckets?.[k] : null;
  return b ? { gust: b.gust, key: k, n: b.n } : { gust: l.gust, key: null, n: l.n };
}
/** Gelernte Abweichung des Grundwinds (km/h, + = gemessen mehr), nur wenn sie sich Tag für Tag bewährt hat. */
export function windCorrection(l, hour, dir, speed) {
  const w = l?.wind;
  if (!w || !w.mode || w.mode === 'none' || !(l.n >= STATION_MIN_N)) return null;
  const blk = blockOf(hour);
  if (!blk) return null;
  const k = `${blk}|${sectorOf(dir, speed)}`, b = w.mode === 'bucket' ? w.buckets?.[k] : null;
  return b ? { wind: b.v, key: k } : { wind: w.avg, key: null };
}

/** Lernen einfacher machen, wenn die Selbstprüfung die Details nicht bestätigt: nur das Stationsmittel, nur anheben. */
export function simplifyLearned(learned) {
  return Object.fromEntries(Object.entries(learned || {}).map(([c, l]) => [c, { ...l, mode: l.mode === 'none' ? 'none' : 'overall', buckets: {}, raiseOnly: true, wind: l.wind ? { ...l.wind, mode: l.wind.mode === 'none' ? 'none' : 'overall', buckets: {} } : null }]));
}

/* ---------------------------------------------------------------- Föhn und Bise nachschärfen
 * Stündlich festgehalten: prognostizierter Druckunterschied (Lugano–Kloten für Föhn, Kloten–Genf für Bise, rund 3 h
 * voraus) und der gemessene samt Föhn- und Bise-Signal der Stationen (0–100). Gelernt wird:
 * 1. Wie weit der prognostizierte Druckunterschied danebenliegt (Mittel, jüngere Tage zählen mehr). Übernommen nur,
 *    wenn es Tag für Tag besser getroffen hätte. Mehr Föhn/Bise zählt voll, weniger nur halb, höchstens ±2 hPa.
 * 2. Ob Föhn oder Bise gemessen wurde (Signal ab 40), obwohl die Prognose unter der Warngrenze lag. Geschah das an
 *    mindestens 2 Tagen, sinkt die Warngrenze so weit, dass diese Tage gewarnt hätten (höchstens auf die Hälfte).
 *    Angehoben wird eine Grenze nie automatisch.
 */
export const PRESSURE_DEFAULTS = { foehn: { warn: 4, danger: 8 }, bise: { warn: 2, danger: 4 } };
export const PRESSURE_DAYS = 90, PRESSURE_HALF_DAYS = 14;
export function pressureLearn(rows, now = Date.now()) {
  const from = now - PRESSURE_DAYS * DAY_MS, out = {};
  for (const [kind, fk, ok, sk] of [['foehn', 'fdp', 'odp', 'foehnObs'], ['bise', 'bdp', 'obdp', 'biseObs']]) {
    const xs = rows.filter(r => r.ms >= from && r.ms < now && isNum(r[fk])).map(r => ({
      day: Math.floor((r.ms + 3600000) / DAY_MS), fc: r[fk], d: isNum(r[ok]) ? r[ok] - r[fk] : null, score: r[sk], k: 'all',
      w: 0.5 ** ((now - r.ms) / (PRESSURE_HALF_DAYS * DAY_MS))
    }));
    const def = PRESSURE_DEFAULTS[kind];
    const v = validate(xs.map(x => ({ ...x, d: x.d })), 'd'), fit = fitStation(xs, 'd');
    const raw = v.mode === 'none' ? 0 : fit.overall;
    const bias = r1(Math.max(-2, Math.min(2, raw > 0 ? raw : raw * 0.5)));
    // Verpasste Tage: Signal ab 40 gemessen, korrigierte Prognose unter der Warngrenze
    const byDay = new Map();
    for (const x of xs) { const o = byDay.get(x.day) || { fcMax: -99, obsMax: 0 }; o.fcMax = Math.max(o.fcMax, x.fc + bias); o.obsMax = Math.max(o.obsMax, x.score ?? 0); byDay.set(x.day, o); }
    const missed = [...byDay.values()].filter(o => o.obsMax >= 40 && o.fcMax < def.warn);
    let warn = def.warn, why = 'keine verpassten Tage';
    if (missed.length >= 2) {
      const need = Math.floor(Math.min(...missed.map(o => o.fcMax)) * 2) / 2;
      warn = Math.max(def.warn / 2, Math.min(def.warn, need));
      why = `${missed.length} Tage mit gemessenem ${kind === 'foehn' ? 'Föhn' : 'Bise'} unter der Warngrenze`;
    } else if (missed.length === 1) why = '1 Tag verpasst, erst ab 2 Tagen wird die Grenze gesenkt';
    out[kind] = { n: xs.length, days: byDay.size, bias, biasMode: v.mode, mae0: v.mae0, mae: v.mae, warn, defaultWarn: def.warn, danger: def.danger, missed: missed.length, why };
  }
  return out;
}

/* ---------------------------------------------------------------- Welches Wettermodell lag besser?
 * Je Gebiet: Böen von ICON (Hauptmodell) und ECMWF (Vergleich) rund 3 h voraus gegen die nächste Messstation.
 * Lag ECMWF in den letzten 30 Tagen klar besser (mindestens 10 % kleinerer Fehler, 40 Stunden, 4 Tage), bekommt es ein
 * Gewicht bis 0.5. Die Startplätze im Gebiet verschieben sich um Gewicht × (ECMWF − ICON) am Gebietspunkt;
 * mehr Wind voll, weniger nur halb.
 */
export function modelLearn(rows, now = Date.now()) {
  const from = now - STATION_DAYS * DAY_MS, by = {};
  for (const r of rows) if (r.ms >= from && r.ms < now && isNum(r.og) && isNum(r.ig) && isNum(r.eg)) (by[r.area] ||= []).push(r);
  const out = {};
  for (const [area, xs] of Object.entries(by)) {
    const mae = k => xs.reduce((t, x) => t + Math.abs(x.og - x[k]), 0) / xs.length;
    const mi = mae('ig'), me = mae('eg'), days = new Set(xs.map(x => Math.floor(x.ms / DAY_MS))).size;
    const ok = xs.length >= 40 && days >= 4 && me < mi * 0.9;
    out[area] = { n: xs.length, days, maeIcon: r1(mi), maeEc: r1(me), weight: ok ? Math.round(Math.min(0.5, (mi - me) / mi * 2) * 20) / 20 : 0, station: xs[0].code };
  }
  return out;
}
