// Tagesplan für das Gratis-Kontingent von Open-Meteo (10 000 Aufrufe pro Tag, Zähler beginnt um Mitternacht UTC).
// Wie viele Leute AFC brauchen, spielt keine Rolle: der Server holt die Prognose einmal für alle und rechnet daraus.
// Teuer sind nur die regelmässigen Abrufe. Darum:
//  - tagsüber (5 bis 21 Uhr Zürcher Zeit) so oft wie bisher, nachts seltener: dann fliegt niemand, und die Modelle
//    rechnen ohnehin nur alle 3 Stunden neu;
//  - nach einem Neustart zählt der letzte Abruf weiter (ein Update kostet nichts mehr);
//  - reicht der Rest des Tages trotzdem nicht, werden die Abstände gleichmässig gestreckt, statt dass um 14 Uhr
//    Schluss ist. Die Prognose bleibt so den ganzen Tag frisch, im schlimmsten Fall etwas seltener erneuert.
import { zurichParts } from './util.js';

const DAY = 86400000, MIN = 60000;
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/** Abstände in Minuten (Flugzeit / Nacht) und geschätzte Kosten je Abruf, bis AFC die echten gemessen hat. */
export function makePlan(env = process.env) {
  const fcDay = num(env.AFC_FORECAST_MIN, 60), windDay = num(env.AFC_WINDGRID_MIN, 180), ensDay = num(env.AFC_ENSEMBLE_MIN, 360);
  return {
    budget: num(env.AFC_OPENMETEO_BUDGET, 9000),   // 1000 Reserve für Neustarts, Nachlernen und den Rückblick-Test
    jobs: {
      fc: { day: fcDay, night: Math.max(fcDay, num(env.AFC_FORECAST_NIGHT_MIN, 180)), cost: 180, emergency: 180 },
      wind: { day: windDay, night: Math.max(windDay, num(env.AFC_WINDGRID_NIGHT_MIN, 360)), cost: 300 },
      ens: { day: ensDay, night: Math.max(ensDay, num(env.AFC_ENSEMBLE_NIGHT_MIN, 360)), cost: 25 }
    }
  };
}

export const isFlyHour = h => h >= 5 && h < 21;
/** Normaler Abstand eines Abrufs zur Zeit ms (Zürcher Uhrzeit entscheidet über Tag oder Nacht). */
export function everyMs(def, ms) { return (isFlyHour(zurichParts(ms).hour) ? def.day : def.night) * MIN; }
/** Ende des Open-Meteo-Tages (Mitternacht UTC). */
export const dayEnd = now => Math.floor(now / DAY) * DAY + DAY;

/** Was der normale Plan bis zum Ende des Open-Meteo-Tages noch braucht. jobs: [{ def, lastAt, cost }] */
export function needUntilReset(jobs, now) {
  const end = dayEnd(now);
  let need = 0;
  for (const j of jobs) {
    let t = j.lastAt ? Math.max(now, j.lastAt + everyMs(j.def, j.lastAt)) : now;
    for (let i = 0; t < end && i < 200; i++) { need += j.cost; t += everyMs(j.def, t); }
  }
  return need;
}

/** Streckfaktor für alle Abstände: 1 = normal, 1.5 = anderthalbmal so lange warten, Infinity = nichts mehr übrig. */
export function stretchFactor(jobs, used, budget, now) {
  const need = needUntilReset(jobs, now), left = budget - used;
  if (need <= 0 || left >= need) return 1;
  return left <= 0 ? Infinity : need / left;
}

/**
 * Ist ein Abruf jetzt fällig? Nie während einer Sperre durch Open-Meteo, nicht gleich wieder nach einem Fehlschlag
 * (15 Minuten Pause) und nur, wenn der Rest des Tages ihn noch trägt. Ohne bisherigen Abruf: sofort.
 * Ist die eigene Grenze erreicht, holt AFC die Prognose (emergency) trotzdem alle 3 Stunden, solange das echte
 * Limit von Open-Meteo noch Platz hat: lieber die Reserve antasten als eine alte Prognose zeigen.
 */
export function isDue({ def, lastAt, lastTry, cost, factor, used, budget, limit = 10000, now, blocked }) {
  if (blocked) return false;
  if (lastTry && (!lastAt || lastTry > lastAt) && now - lastTry < 15 * MIN) return false;
  if (budget - used < cost) return !!(def.emergency && limit - used >= cost && (!lastAt || now - lastAt >= def.emergency * MIN));
  if (!lastAt) return true;
  return now - lastAt >= everyMs(def, now) * factor - 2 * MIN;
}
