// Welche Benachrichtigungen fällig sind: guter Flugtag morgen, Föhn, Ausrüstung (Retter packen, Schirm-Check).
// Reine Funktion; der Server entscheidet über Zeitpunkt und schickt jede Meldung je Gerät nur einmal.
import { gearStatus, gearName } from './logbook.js';

export const DEFAULT_PREFS = { good: true, threshold: 75, foehn: true, gear: true, health: true, favs: [], level: 'normal' };

export function cleanPrefs(p = {}) {
  const t = Number(p.threshold);
  return {
    good: p.good !== false, foehn: p.foehn !== false, gear: p.gear !== false, health: p.health !== false,
    threshold: [65, 70, 75, 80, 85].includes(t) ? t : DEFAULT_PREFS.threshold,
    favs: Array.isArray(p.favs) ? p.favs.filter(x => /^[\w-]{1,60}$/.test(String(x))).slice(0, 60).map(String) : [],
    level: ['careful', 'normal', 'expert'].includes(p.level) ? p.level : 'normal'
  };
}

const dayWord = d => (d === 0 ? 'heute' : 'morgen');
const Day = d => (d === 0 ? 'Heute' : 'Morgen');

/** Bester Startplatz eines Tages (Favoriten, sonst alle) und die nächsten zwei. */
export function goodDayNotice(plan, d, prefs) {
  const date = plan?.dates?.[d];
  if (!date) return null;
  const favs = new Set(prefs.favs);
  const pool = (plan.sites || []).filter(s => !s.blocked && s.days?.[d]?.best && (!favs.size || favs.has(s.id)));
  const ranked = pool.map(s => ({ s, b: s.days[d].best })).sort((a, b) => b.b.score - a.b.score);
  const top = ranked[0];
  if (!top || top.b.score < prefs.threshold) return null;
  const more = ranked.slice(1, 3).filter(x => x.b.score >= prefs.threshold).map(x => `${x.s.name} ${x.b.score}`);
  return {
    key: `good:${date}`, tag: `good-${date}`,
    title: `${Day(d)} ${top.b.score} am ${top.s.name}`,
    body: `Bestes Fenster ${top.b.from}–${top.b.to} Uhr${top.b.decision?.label ? ` (${top.b.decision.label})` : ''}.${more.length ? ' Auch gut: ' + more.join(', ') + '.' : ''} Vor dem Start Wind und Lage prüfen.`,
    url: '/?site=' + encodeURIComponent(top.s.id)
  };
}

/** Föhn in der Region (Tagesstunden 8–18): Warnung bei «K.-o.», Hinweis bei mindestens zwei Stunden «Vorsicht». */
export function foehnNotice(plan, d) {
  const date = plan?.dates?.[d], hours = (plan?.region?.days?.[d]?.hours || []).filter(h => h.h >= 8 && h.h <= 18);
  if (!date || !hours.length) return null;
  const danger = hours.filter(h => h.foehn === 'danger'), warn = hours.filter(h => h.foehn === 'warn');
  if (danger.length) {
    return { key: `foehn:${date}:danger`, tag: `foehn-${date}`, title: `Föhnwarnung ${dayWord(d)}`, body: `Föhn ab etwa ${danger[0].h} Uhr erwartet. In föhnexponierten Tälern nicht fliegen. Details in AFC unter «Lage».`, url: '/?tab=lage' };
  }
  if (warn.length >= 2) {
    return { key: `foehn:${date}:warn`, tag: `foehn-${date}`, title: `Föhn möglich ${dayWord(d)}`, body: `Föhnsignal ab etwa ${warn[0].h} Uhr. Vor dem Start die Messwerte am Alpenkamm prüfen.`, url: '/?tab=lage' };
  }
  return null;
}

/** Ausrüstung: fällig, oder in höchstens 14 Tagen bzw. 5 Stunden fällig. */
export function gearNotices(gear = [], flights = [], now = Date.now()) {
  const out = [];
  for (const g of gear) {
    if (g.retired) continue;
    for (const it of gearStatus(g, flights, now).items) {
      const soon = it.level === 'due' || (it.level === 'warn' && ((Number.isFinite(it.days) && it.days <= 14) || (Number.isFinite(it.hours) && it.hours <= 5)));
      if (!soon) continue;
      const due = it.level === 'due' || it.days === 0;
      out.push({
        key: `gear:${g.id}:${it.label}:${it.date || ''}:${due ? 'due' : 'soon'}`, tag: `gear-${g.id}`,
        title: `${it.label} ${due ? 'fällig' : 'bald fällig'}`, body: `${gearName(g)}: ${it.text}.`, url: '/?tab=book'
      });
    }
  }
  return out;
}

/**
 * Meldungen für ein Gerät. phase: 'evening' (Ausblick auf morgen) oder 'morning' (heute: Föhn, Ausrüstung).
 * plan: planPayload in der Erfahrungsstufe des Geräts.
 */
export function buildNotices({ phase, plan, prefs, gear = [], flights = [], now = Date.now() }) {
  const out = [];
  if (phase === 'evening') {
    if (prefs.good) { const n = goodDayNotice(plan, 1, prefs); if (n) out.push(n); }
    if (prefs.foehn) { const n = foehnNotice(plan, 1); if (n) out.push(n); }
  } else if (phase === 'morning') {
    if (prefs.foehn) { const n = foehnNotice(plan, 0); if (n) out.push(n); }
    if (prefs.gear) out.push(...gearNotices(gear, flights, now));
  }
  return out;
}
