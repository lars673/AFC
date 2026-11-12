// Welche Benachrichtigungen fällig sind: guter Flugtag morgen, Föhn, Ausrüstung (Retter packen, Schirm-Check).
// Reine Funktion; der Server entscheidet über Zeitpunkt und schickt jede Meldung je Gerät nur einmal.
import { gearStatus, gearName } from './logbook.js';

export const DEFAULT_PREFS = { good: true, threshold: 75, foehn: true, gear: true, health: true, review: true, group: true, replies: true, favs: [], level: 'normal' };

export function cleanPrefs(p = {}) {
  const t = Number(p.threshold);
  return {
    good: p.good !== false, foehn: p.foehn !== false, gear: p.gear !== false, health: p.health !== false, review: p.review !== false,
    group: p.group !== false, replies: p.replies !== false,
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

/** Bise in der Region (Tagesstunden 8–18): stark = Warnung, mindestens zwei Stunden Vorsicht = Hinweis. */
export function biseNotice(plan, d) {
  const date = plan?.dates?.[d], hours = (plan?.region?.days?.[d]?.hours || []).filter(h => h.h >= 8 && h.h <= 18);
  if (!date || !hours.length) return null;
  const danger = hours.filter(h => h.bise === 'danger'), warn = hours.filter(h => h.bise === 'warn' && !h.biseWeak);
  if (danger.length) return { key: `bise:${date}:danger`, tag: `bise-${date}`, title: `Starke Bise ${dayWord(d)}`, body: `Ab etwa ${danger[0].h} Uhr. Am Thuner- und Brienzersee (Interlaken) liegen Süd- und Westhänge im Lee: Rotoren, harte Böen, starker Wind am Landeplatz.`, url: '/?tab=lage' };
  if (warn.length >= 2) return { key: `bise:${date}:warn`, tag: `bise-${date}`, title: `Bise ${dayWord(d)}`, body: `Ab etwa ${warn[0].h} Uhr Bise möglich. Lee-Hänge meiden und den Wind in Thun und Interlaken prüfen.`, url: '/?tab=lage' };
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

/** Abends: Rückblick auf die heutigen Flüge, die noch keine Rückmeldung haben. */
export function reviewNotices(flights = [], today) {
  return flights.filter(f => f.date === today && !f.afcVerdict).slice(0, 2).map(f => ({
    key: `review:${f.id}`, tag: `review-${f.id}`,
    title: `Dein Flug heute${f.siteName ? ' am ' + f.siteName : ''}`,
    body: `${f.track ? 'Prognose gegen deinen Flug ansehen und' : 'Wie war es?'} kurz sagen, ob AFC richtig lag. So wird AFC genauer.`,
    url: '/?tab=book&flight=' + encodeURIComponent(f.id)
  }));
}

/**
 * Meldungen für ein Gerät. phase: 'evening' (Ausblick auf morgen) oder 'morning' (heute: Föhn, Ausrüstung).
 * plan: planPayload in der Erfahrungsstufe des Geräts.
 */
export function buildNotices({ phase, plan, prefs, gear = [], flights = [], now = Date.now(), today = plan?.dates?.[0] }) {
  const out = [];
  if (phase === 'evening') {
    if (prefs.review && today) out.push(...reviewNotices(flights, today));
    if (prefs.good) { const n = goodDayNotice(plan, 1, prefs); if (n) out.push(n); }
    if (prefs.foehn) { const n = foehnNotice(plan, 1); if (n) out.push(n); }
    if (prefs.foehn) { const n = biseNotice(plan, 1); if (n) out.push(n); }
  } else if (phase === 'morning') {
    if (prefs.foehn) { const n = foehnNotice(plan, 0); if (n) out.push(n); }
    if (prefs.foehn) { const n = biseNotice(plan, 0); if (n) out.push(n); }
    if (prefs.gear) out.push(...gearNotices(gear, flights, now));
  }
  return out;
}

/**
 * Neuer Beitrag in der Gruppe: wer bekommt eine Mitteilung? Neue Beiträge alle mit «group», Antworten nur, wer am
 * Gespräch beteiligt ist (Beitrag geschrieben oder geantwortet) und «replies» an hat. Nie der Schreiber selbst,
 * nachts (22–7 Uhr) niemand: die App zeigt den roten Punkt trotzdem.
 * post: { id, uid, parent, kind, text, siteName, name }, involved: Set der uids im Gespräch, hour: Stunde in Zürich.
 */
export const GROUP_KIND_WORD = { report: 'Bericht', plan: 'geht fliegen', ask: 'Frage', warn: 'Achtung', brief: 'Briefing' };
export function groupNotice(post, rowUid, prefs, involved = new Set(), hour = 12) {
  if (!post || !rowUid || rowUid === post.uid || hour >= 22 || hour < 7) return null;
  const short = t => (t.length > 140 ? t.slice(0, 137).trimEnd() + ' …' : t);
  if (post.parent) {
    if (!prefs.replies || !involved.has(rowUid)) return null;
    return { key: `post:${post.id}`, tag: `grp-${post.parent}`, title: `${post.name} hat geantwortet`, body: short(post.text), url: '/?tab=group' };
  }
  if (!prefs.group) return null;
  const what = post.kind === 'plan' ? 'geht fliegen' : post.kind === 'warn' ? 'warnt' : post.kind === 'ask' ? 'fragt' : post.kind === 'brief' ? 'teilt ein Briefing' : 'berichtet';
  return { key: `post:${post.id}`, tag: `grp-${post.id}`, title: `${post.name} ${what}${post.siteName ? ' · ' + post.siteName : ''}`, body: short(post.text), url: '/?tab=group' };
}
