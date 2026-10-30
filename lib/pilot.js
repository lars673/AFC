// Pilotenprofil: aus Erfahrung, Übung und Schirm die passende Erfahrungsstufe ableiten und
// persönliche Hinweise je Stunde geben. Läuft im Browser (als /pilot.js) und in den Tests.

export const GLIDERS = { A: 'EN-A', B: 'EN-B', C: 'EN-C', D: 'EN-D / CCC' };
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const STEP = ['careful', 'normal', 'expert'];

/** Tage seit dem letzten Flug (null, wenn unbekannt). */
export function daysSince(dateStr, now = Date.now()) {
  const t = Date.parse(dateStr || '');
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86400000)) : null;
}

/**
 * profile: { student, flights, hours12, glider: 'A'|'B'|'C'|'D', lastFlight: 'YYYY-MM-DD' }
 * -> { level, points, why: [Sätze], days } oder null, wenn das Profil leer ist.
 */
export function pilotLevel(profile, now = Date.now()) {
  if (!profile || (!isNum(profile.flights) && !isNum(profile.hours12) && !profile.student)) return null;
  const why = [];
  const f = profile.flights ?? 0, h = profile.hours12 ?? 0;
  let points = (f >= 300 ? 3 : f >= 100 ? 2 : f >= 30 ? 1 : 0) + (h >= 60 ? 3 : h >= 30 ? 2 : h >= 10 ? 1 : 0) + ({ A: 0, B: 1, C: 2, D: 3 }[profile.glider] ?? 1);
  let i = points >= 7 ? 2 : points >= 4 ? 1 : 0;
  why.push(`${f} Flüge, ${h} Stunden in den letzten 12 Monaten${profile.glider ? ', Schirm ' + GLIDERS[profile.glider] : ''}`);
  if (profile.student) { i = 0; why.push('In Ausbildung: strenge Grenzen'); }
  const days = daysSince(profile.lastFlight, now);
  if (days !== null && days > 120) { i = 0; why.push(`Seit ${days} Tagen nicht geflogen: strenge Grenzen, bis du wieder im Training bist`); }
  else if (days !== null && days > 42) { i = Math.max(0, i - 1); why.push(`Seit ${days} Tagen nicht geflogen: ${i === 0 ? 'strenge Grenzen' : 'eine Stufe vorsichtiger'}`); }
  return { level: STEP[i], points, why, days };
}

/** Persönlicher Punkt für «Kurz erklärt»: { k: 'Du', lvl, t } */
export function pilotHint(profile, hour, now = Date.now()) {
  const pl = pilotLevel(profile, now);
  if (!pl || !hour) return null;
  const novice = profile.student || (profile.hours12 ?? 0) < 20 || profile.glider === 'A';
  const notes = [];
  let lvl = 'ok';
  if (isNum(hour.wstar) && hour.wstar >= 2.5 && novice) { lvl = 'warn'; notes.push(`kräftige Thermik (Steigen um ${hour.wstar.toFixed(1)} m/s) ist für deine Erfahrung anspruchsvoll: eher früh oder am Abend fliegen`); }
  else if (isNum(hour.wstar) && hour.wstar >= 3.2 && profile.glider !== 'D') { lvl = 'warn'; notes.push(`sehr kräftige Thermik (${hour.wstar.toFixed(1)} m/s): aktiv fliegen, Schirm gut kontrollieren`); }
  if (isNum(hour.gust) && isNum(hour.speed) && hour.gust - hour.speed >= 10 && novice) { lvl = 'warn'; notes.push('böiger Wind am Start: für wenig Übung heikel'); }
  if (pl.days !== null && pl.days > 42) { lvl = 'warn'; notes.push(`seit ${pl.days} Tagen nicht geflogen: Start am Übungshang auffrischen, ruhige Bedingungen wählen`); }
  if (!notes.length) notes.push(`passt zu deinem Profil (${pl.level === 'careful' ? 'vorsichtige' : pl.level === 'expert' ? 'erfahrene' : 'normale'} Grenzen)`);
  const t = notes.join('; ');
  return { k: 'Du', lvl, t: t[0].toUpperCase() + t.slice(1) };
}

if (typeof window !== 'undefined') window.AFCPilot = { GLIDERS, daysSince, pilotLevel, pilotHint };
