// Flugbuch: Flüge und Ausrüstung prüfen, Statistik, fällige Checks (Schirm) und Packtermine (Retter).
// Läuft im Server (Prüfen vor dem Speichern) und im Browser (als /logbook.js).

export const GEAR_TYPES = { glider: 'Schirm', harness: 'Gurtzeug', reserve: 'Retter', other: 'Sonstiges' };
export const FLIGHT_KINDS = { thermik: 'Thermik', soaring: 'Soaring', abgleiter: 'Abgleiter', xc: 'Strecke', tandem: 'Tandem', training: 'Training' };

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const str = (v, n = 80) => String(v ?? '').trim().slice(0, n);
const num = (v, lo, hi) => { const x = Number(v); return v === '' || v === null || v === undefined || !Number.isFinite(x) ? null : Math.min(hi, Math.max(lo, x)); };
const date = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && Number.isFinite(Date.parse(v)) ? String(v) : null);
const time = v => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : '');
const id = v => (/^[\w-]{1,40}$/.test(String(v || '')) ? String(v) : null);
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** Flug prüfen und bereinigen; null, wenn Datum fehlt. */
export function cleanFlight(f = {}) {
  const d = date(f.date);
  if (!d) return null;
  return {
    id: id(f.id) || newId(), date: d, start: time(f.start),
    durMin: Math.round(num(f.durMin, 0, 24 * 60) ?? 0),
    siteId: id(f.siteId), siteName: str(f.siteName), landingId: id(f.landingId), landingName: str(f.landingName),
    km: num(f.km, 0, 1000), maxAlt: num(f.maxAlt, 0, 9000),
    gliderId: id(f.gliderId), harnessId: id(f.harnessId), reserveId: id(f.reserveId),
    rating: num(f.rating, 1, 5), kind: FLIGHT_KINDS[f.kind] ? f.kind : '',
    note: str(f.note, 500), afcScore: num(f.afcScore, 0, 100),
    track: f.track && typeof f.track === 'object' ? cleanTrack(f.track) : null
  };
}
// Zusammenfassung einer IGC-Spur (die Spur selbst bleibt als Datei)
function cleanTrack(t) {
  return { file: str(t.file, 80), points: num(t.points, 0, 1e6), climbMax: num(t.climbMax, -20, 20), thermals: Array.isArray(t.thermals) ? t.thermals.slice(0, 60).map(x => ({ lat: num(x.lat, -90, 90), lon: num(x.lon, -180, 180), alt: num(x.alt, 0, 9000), rate: num(x.rate, -10, 15), gain: num(x.gain, 0, 6000) })) : [] };
}

/** Ausrüstung prüfen und bereinigen; null, wenn die Art fehlt. */
export function cleanGear(g = {}) {
  if (!GEAR_TYPES[g.type]) return null;
  return {
    id: id(g.id) || newId(), type: g.type, brand: str(g.brand, 40), model: str(g.model, 40), size: str(g.size, 20),
    cert: str(g.cert, 20), serial: str(g.serial, 40), bought: date(g.bought),
    hoursBefore: num(g.hoursBefore, 0, 10000) ?? 0, flightsBefore: num(g.flightsBefore, 0, 100000) ?? 0,
    checkLast: date(g.checkLast), checkMonths: num(g.checkMonths, 0, 120), checkHours: num(g.checkHours, 0, 1000),
    packedLast: date(g.packedLast), packMonths: num(g.packMonths, 0, 60),
    retired: !!g.retired, note: str(g.note, 300)
  };
}

export function cleanSettings(s = {}) {
  return { flightsBefore: num(s.flightsBefore, 0, 100000) ?? 0, hoursBefore: num(s.hoursBefore, 0, 100000) ?? 0, defaults: { glider: id(s.defaults?.glider), harness: id(s.defaults?.harness), reserve: id(s.defaults?.reserve) } };
}

const DAY = 86400000;
const addMonths = (d, m) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
const daysUntil = (d, now) => Math.round((Date.parse(d + 'T12:00:00Z') - now) / DAY);
export const fmtDur = min => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;

/** Statistik: total (inkl. Flüge vor dem Flugbuch), dieses Jahr, letzte 12 Monate. */
export function logStats(flights = [], settings = {}, now = Date.now()) {
  const year = new Date(now).getUTCFullYear(), y12 = new Date(now - 365 * DAY).toISOString().slice(0, 10);
  const inYear = flights.filter(f => f.date.startsWith(String(year))), in12 = flights.filter(f => f.date >= y12);
  const sum = l => l.reduce((m, f) => m + (f.durMin || 0), 0);
  const sorted = flights.slice().sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start));
  const longest = flights.reduce((m, f) => (!m || (f.durMin || 0) > m.durMin ? f : m), null);
  const farthest = flights.reduce((m, f) => (isNum(f.km) && (!m || f.km > m.km) ? f : m), null);
  const sites = Object.entries(flights.reduce((m, f) => { const k = f.siteName || '–'; m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 5);
  return {
    total: flights.length + (settings.flightsBefore || 0), totalMin: sum(flights) + (settings.hoursBefore || 0) * 60,
    logged: flights.length, year, yearFlights: inYear.length, yearMin: sum(inYear),
    flights12: in12.length, min12: sum(in12), last: sorted[0] || null, longest, farthest, sites
  };
}

/** Werte für das Pilotenprofil aus dem Flugbuch. */
export function profileFromLog(flights = [], settings = {}, now = Date.now()) {
  if (!flights.length) return null;
  const s = logStats(flights, settings, now);
  return { flights: s.total, hours12: Math.round(s.min12 / 60), lastFlight: s.last?.date || null };
}

/**
 * Zustand eines Ausrüstungsteils: Stunden, Flüge und was als Nächstes fällig ist.
 * level: ok | warn (innert 30 Tagen oder 10 h) | due (überfällig)
 */
export function gearStatus(g, flights = [], now = Date.now()) {
  const key = { glider: 'gliderId', harness: 'harnessId', reserve: 'reserveId' }[g.type];
  const mine = key ? flights.filter(f => f[key] === g.id) : [];
  const min = mine.reduce((m, f) => m + (f.durMin || 0), 0);
  const hours = Math.round((g.hoursBefore || 0) + min / 60);
  const items = [];
  const byDate = (label, next, warnDays = 30) => {
    const d = daysUntil(next, now);
    items.push({ label, date: next, days: d, level: d < 0 ? 'due' : d <= warnDays ? 'warn' : 'ok', text: d < 0 ? `${label} seit ${-d} Tagen fällig` : d === 0 ? `${label} heute fällig` : `${label} in ${d} Tagen (${next.split('-').reverse().join('.')})` });
  };
  if (g.type === 'reserve' && g.packedLast && g.packMonths) byDate('Retter packen', addMonths(g.packedLast, g.packMonths));
  if (g.type !== 'reserve' && g.checkLast && g.checkMonths) byDate(g.type === 'glider' ? 'Schirm-Check' : 'Kontrolle', addMonths(g.checkLast, g.checkMonths));
  if (g.type === 'glider' && g.checkHours) {
    const since = Math.round(mine.filter(f => !g.checkLast || f.date >= g.checkLast).reduce((m, f) => m + (f.durMin || 0), 0) / 60 + (g.checkLast ? 0 : g.hoursBefore || 0));
    const left = g.checkHours - since;
    items.push({ label: 'Check nach Stunden', hours: left, level: left <= 0 ? 'due' : left <= 10 ? 'warn' : 'ok', text: left <= 0 ? `Check-Stunden erreicht (${since} h seit Check)` : `noch ${left} h bis zum Check (${since} von ${g.checkHours} h)` });
  }
  const order = { due: 2, warn: 1, ok: 0 };
  const level = items.reduce((m, x) => (order[x.level] > order[m] ? x.level : m), 'ok');
  return { hours, flights: mine.length + (g.flightsBefore || 0), items, level };
}

export const gearName = g => [g.brand, g.model, g.size].filter(Boolean).join(' ') || GEAR_TYPES[g.type];

if (typeof window !== 'undefined') window.AFCLog = { GEAR_TYPES, FLIGHT_KINDS, cleanFlight, cleanGear, cleanSettings, logStats, profileFromLog, gearStatus, gearName, fmtDur, newId };
