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

export const THERMAL_MIN_N = 3, THERMAL_MAX_UP = 500, THERMAL_MAX_DOWN = 300, THERMAL_DAYS = 730;

/**
 * Pro Flug: höchste Thermik-Obergrenze aus der IGC-Spur gegen die höchste prognostizierte Thermik-Obergrenze
 * während der Flugstunden. fc: Map `${siteId}|${date}|${hour}` -> thermalTop (m ü. M.).
 * siteArea: siteId -> Gebiet. Ergebnis je Gebiet: { n, median, add, checked, why }.
 */
export function thermalSamples(flights, fc) {
  const out = [];
  for (const f of flights) {
    const th = f.track?.thermals;
    if (!f.siteId || !Array.isArray(th) || !th.length || !f.start) continue;
    const obsTop = Math.max(...th.map(t => t.alt).filter(isNum));
    const h0 = Number(f.start.slice(0, 2)), h1 = Math.min(21, h0 + Math.max(0, Math.ceil((f.durMin || 0) / 60)));
    const fcs = [];
    for (let h = h0; h <= h1; h++) { const v = fc.get(`${f.siteId}|${f.date}|${h}`); if (isNum(v)) fcs.push(v); }
    if (!isNum(obsTop) || !fcs.length) continue;
    out.push({ siteId: f.siteId, date: f.date, diff: obsTop - Math.max(...fcs) });
  }
  return out;
}

const clampAdd = m => Math.round(Math.max(-THERMAL_MAX_DOWN, Math.min(THERMAL_MAX_UP, m)) / 50) * 50;

export function thermalLearn(flights, fc, siteArea, now = Date.now()) {
  const from = new Date(now - THERMAL_DAYS * 86400000).toISOString().slice(0, 10);
  const by = {};
  for (const s of thermalSamples(flights.filter(f => f.date >= from), fc)) {
    const a = siteArea[s.siteId];
    if (a) (by[a] ||= []).push(s.diff);
  }
  const out = {};
  for (const [area, diffs] of Object.entries(by)) {
    const n = diffs.length, med = Math.round(median(diffs));
    if (n < THERMAL_MIN_N) { out[area] = { n, median: med, add: 0, why: `erst ${n} von ${THERMAL_MIN_N} Flügen` }; continue; }
    // Hätte die Korrektur aus den übrigen Flügen jeden Flug besser getroffen als keine Korrektur?
    let errWith = 0, errWithout = 0;
    diffs.forEach((d, i) => { const rest = diffs.filter((_, j) => j !== i); errWith += Math.abs(d - clampAdd(median(rest))); errWithout += Math.abs(d); });
    const better = errWith < errWithout * 0.9;
    // Weniger hoch geflogen heisst nicht sicher: weniger Thermik (man verlässt sie auch früher). Nach unten nur halb.
    const add = better ? clampAdd(med > 0 ? med * 0.6 : med * 0.3) : 0;
    out[area] = { n, median: med, add, why: better ? `${n} Flüge, im Mittel ${med > 0 ? '+' : ''}${med} m gegenüber der Prognose` : `${n} Flüge, aber zu unterschiedlich für eine Korrektur` };
  }
  return out;
}
