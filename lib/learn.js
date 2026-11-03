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

function fitStation(samples) {
  let sw = 0, s = 0, sww = 0, swd = 0;
  const b = {};
  for (const x of samples) {
    sw += x.w; s += x.w * x.d;
    if (isNum(x.wd)) { sww += x.w; swd += x.w * x.wd; }
    const k = x.k, o = (b[k] ||= { sw: 0, s: 0, n: 0 });
    o.sw += x.w; o.s += x.w * x.d; o.n++;
  }
  const overall = sw ? s / (sw + SHRINK_K) : 0;   // zu 0 hin gezogen
  const buckets = {};
  for (const [k, o] of Object.entries(b)) buckets[k] = { n: o.n, gust: (o.s + SHRINK_K * overall) / (o.sw + SHRINK_K) };
  return { overall, wind: sww ? swd / (sww + SHRINK_K) : null, buckets };
}
const predict = (fit, mode, k) => (mode === 'none' ? 0 : mode === 'bucket' ? (fit.buckets[k]?.gust ?? fit.overall) : fit.overall);

/**
 * rows: [{ code, ms, pg, pw, pd, og, ow }] (Prognose p, Messung o). Ergebnis je Station:
 * { n, gust, wind, mode, buckets: { 'pm|W': { n, gust } }, mae0, mae, gain, days }
 */
export function stationLearn(rows, now = Date.now()) {
  const from = now - STATION_DAYS * DAY_MS, by = {};
  for (const r of rows) {
    if (!(r.ms >= from && r.ms < now) || !isNum(r.og) || !isNum(r.pg)) continue;
    const blk = blockOf(r.hour ?? new Date(r.ms).getUTCHours() + 1);
    if (!blk) continue;
    (by[r.code] ||= []).push({ day: Math.floor((r.ms + 3600000) / DAY_MS), k: `${blk}|${sectorOf(r.pd, r.pw)}`, d: r.og - r.pg, wd: isNum(r.ow) && isNum(r.pw) ? r.ow - r.pw : null, w: 0.5 ** ((now - r.ms) / (STATION_HALF_DAYS * DAY_MS)) });
  }
  const out = {};
  for (const [code, xs] of Object.entries(by)) {
    const fit = fitStation(xs), days = [...new Set(xs.map(x => x.day))];
    const r1 = v => Math.round(v * 10) / 10;
    const res = { n: xs.length, days: days.length, gust: r1(fit.overall), wind: isNum(fit.wind) ? r1(fit.wind) : null, mode: 'none', mae0: null, mae: null, gain: 0, buckets: {} };
    if (xs.length >= STATION_MIN_N && days.length >= 4) {
      // Jeden Tag mit den übrigen Tagen vorhersagen (leave one day out), Fehler gewichtet wie die Daten
      const err = { none: 0, overall: 0, bucket: 0 };
      let wsum = 0;
      for (const day of days) {
        const f = fitStation(xs.filter(x => x.day !== day));
        for (const x of xs) if (x.day === day) {
          for (const m of Object.keys(err)) err[m] += x.w * Math.abs(x.d - predict(f, m, x.k));
          wsum += x.w;
        }
      }
      for (const m of Object.keys(err)) err[m] /= wsum;
      res.mae0 = r1(err.none);
      res.mode = err.bucket < err.overall * 0.97 && err.bucket < err.none * 0.95 ? 'bucket' : err.overall < err.none * 0.95 ? 'overall' : 'none';
      res.mae = r1(err[res.mode]);
      res.gain = r1(err.none - err[res.mode]);
    }
    for (const [k, b] of Object.entries(fit.buckets)) if (b.n >= 6) res.buckets[k] = { n: b.n, gust: r1(b.gust) };
    out[code] = res;
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

/** Lernen einfacher machen, wenn die Selbstprüfung die Details nicht bestätigt: nur das Stationsmittel, nur anheben. */
export function simplifyLearned(learned) {
  return Object.fromEntries(Object.entries(learned || {}).map(([c, l]) => [c, { ...l, mode: l.mode === 'none' ? 'none' : 'overall', buckets: {}, raiseOnly: true }]));
}
