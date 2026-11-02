// Flugtag-Wächter: «Heute fliege ich hier». AFC schaut alle 10 Minuten auf den Startplatz und meldet,
// sobald etwas kippt (Böen an der nächsten Station, Bewertung jetzt oder in den nächsten 2 Stunden),
// und noch einmal, wenn es sich wieder beruhigt. Reine Funktion; der Server speichert den Zustand.
import { levelOf } from './scoring.js';

export const WATCH_FROM = 7, WATCH_TO = 20, WATCH_MAX = 3, REPEAT_MIN = 60;

const firstReason = h => (h.hard?.[0] || h.reasons?.[0] || '').replace(/^K\.-o\.:\s*/, '');

/**
 * detail: siteDetail(...) des Plans, day 0 = heute. prev: { gust, score, at: {gust, score} } vom letzten Durchlauf.
 * Ergebnis: { state, alerts: [{ type, title, body }] }
 */
export function watchCheck(detail, levelId, prev = {}, nowHour, now = Date.now()) {
  const lv = levelOf(levelId), name = detail.site.name;
  const state = { gust: 'ok', score: 'ok', at: { ...(prev.at || {}) } };
  const alerts = [];
  const fire = (type, title, body) => {
    const last = state.at[type] ? Date.parse(state.at[type]) : 0;
    if (now - last < REPEAT_MIN * 60000) return;
    alerts.push({ type, title, body });
    state.at[type] = new Date(now).toISOString();
  };

  // 1. Gemessene Böen an der nächsten Station (höchstens 40 Minuten alt)
  const nc = detail.nowcast;
  const gustLimit = lv.gustHard - 4, windLimit = lv.windHard - 3;
  if (nc && (nc.ageMin ?? 99) <= 40) {
    const bad = (nc.obsGust ?? 0) >= gustLimit || (nc.obs ?? 0) >= windLimit;
    state.gust = bad ? 'bad' : 'ok';
    const where = `${nc.name}, ${nc.dist} km vom Start`;
    if (bad && prev.gust !== 'bad') fire('gust', `${name}: Böen jetzt ${nc.obsGust ?? nc.obs} km/h`, `Gemessen an ${where} (Wind ${nc.obs ?? '–'} km/h). Deine Grenze für Böen: etwa ${lv.gustHard} km/h. Start und Lage neu prüfen.`);
    if (!bad && prev.gust === 'bad') fire('gustOk', `${name}: Wind beruhigt sich`, `${where}: Wind ${nc.obs ?? '–'} km/h, Böen ${nc.obsGust ?? '–'} km/h. Trotzdem vor Ort prüfen.`);
  } else state.gust = prev.gust || 'ok';

  // 2. Bewertung jetzt und in den nächsten 2 Stunden
  const hours = (detail.days?.[0]?.hours || []).filter(h => h.h >= nowHour && h.h <= nowHour + 2);
  if (hours.length) {
    const badH = hours.find(h => h.score < 55 || (h.hard?.length && h.status === 'danger'));
    state.score = badH ? 'bad' : 'ok';
    if (badH && prev.score !== 'bad') {
      const when = badH.h <= nowHour ? 'jetzt' : `ab ${badH.h} Uhr`;
      fire('score', `${name}: ${when} nur noch ${badH.score}`, `${firstReason(badH) || 'Bedingungen werden schlechter'}. Prüfe, ob du noch starten oder früher landen willst.`);
    }
    if (!badH && prev.score === 'bad') {
      const h = hours[0];
      fire('scoreOk', `${name}: wieder ${h.score}`, `Die Bewertung ist wieder brauchbar (${h.h}–${h.h + 1} Uhr). Vor dem Start die Messwerte prüfen.`);
    }
  } else state.score = prev.score || 'ok';

  return { state, alerts };
}
