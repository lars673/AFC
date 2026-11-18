// Testphase nach Flügen statt nach Wochen (Lars, 18.11.2026):
// fertig bei 100 bewerteten Flügen von mindestens 10 Piloten an mindestens 15 verschiedenen Tagen.

export const TEST_GOAL = { flights: 100, pilots: 10, days: 15 };

/** Tagestyp aus der Prognose von damals (afcFc): grob, nur für die Übersicht. */
export function dayType(fc) {
  if (!fc) return 'ohne Prognose';
  if ((fc.gust ?? 0) >= 30 || (fc.speed ?? 0) >= 20) return 'windig';
  if ((fc.wstar ?? 0) >= 1.5) return 'Thermik';
  return 'ruhig';
}

const pct = (a, b) => Math.max(0, Math.min(100, Math.round((a / b) * 100)));

/**
 * Fortschritt der Testphase.
 * flights: [{uid, date, siteId, afcVerdict, afcFc}], nofly: [{uid, date}], areaOf: siteId -> Gebietsname.
 * Zählt nur Flüge mit Rückmeldung («richtig», «zu streng», «zu mild»).
 */
export function testProgress({ flights = [], nofly = [], goal = TEST_GOAL, uid = null } = {}) {
  const rated = flights.filter(f => f && f.afcVerdict);
  const pilots = new Set(rated.map(f => f.uid));
  const days = new Set(rated.map(f => f.date).filter(Boolean));
  const parts = [
    { k: 'flights', label: 'bewertete Flüge', have: rated.length, need: goal.flights },
    { k: 'pilots', label: 'Piloten', have: pilots.size, need: goal.pilots },
    { k: 'days', label: 'verschiedene Tage', have: days.size, need: goal.days }
  ].map(p => ({ ...p, ok: p.have >= p.need }));
  // Gesamtfortschritt: der schwächste Teil bestimmt, wie weit wir sind
  const overall = Math.min(...parts.map(p => pct(p.have, p.need)));
  const out = {
    goal, parts, rated: rated.length, pilots: pilots.size, days: days.size, nofly: nofly.length,
    pct: overall, done: parts.every(p => p.ok), left: Math.max(0, goal.flights - rated.length)
  };
  if (uid) out.mine = rated.filter(f => f.uid === uid).length;
  return out;
}

/** Für den Admin: Aufteilung nach Pilot, Gebiet, Tagestyp und Urteil. */
export function testBreakdown({ flights = [], areaOf = () => null, names = {} } = {}) {
  const rated = flights.filter(f => f && f.afcVerdict);
  const group = keyOf => {
    const m = new Map();
    for (const f of rated) {
      const k = keyOf(f) || 'unbekannt';
      const x = m.get(k) || { name: k, n: 0, richtig: 0, streng: 0, mild: 0 };
      x.n++; if (x[f.afcVerdict] != null) x[f.afcVerdict]++;
      m.set(k, x);
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  };
  return {
    byPilot: group(f => names[f.uid] || '(gelöscht)'),
    byArea: group(f => areaOf(f.siteId)),
    byType: group(f => dayType(f.afcFc))
  };
}
