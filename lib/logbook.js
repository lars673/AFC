// Flugbuch: Flüge und Ausrüstung prüfen, Statistik, fällige Checks (Schirm) und Packtermine (Retter).
// Läuft im Server (Prüfen vor dem Speichern) und im Browser (als /logbook.js).

export const GEAR_TYPES = { glider: 'Schirm', harness: 'Gurtzeug', reserve: 'Retter', other: 'Sonstiges' };
/** Rückmeldung nach dem Flug: Wie lag die AFC-Bewertung? */
export const VERDICTS = { richtig: 'Lag richtig', streng: 'Zu streng', mild: 'Zu mild' };
export const FLIGHT_KINDS = { thermik: 'Thermik', soaring: 'Soaring', abgleiter: 'Abgleiter', xc: 'Strecke', tandem: 'Tandem', training: 'Training' };

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const str = (v, n = 80) => String(v ?? '').trim().slice(0, n);
const num = (v, lo, hi) => { const x = Number(v); return v === '' || v === null || v === undefined || !Number.isFinite(x) ? null : Math.min(hi, Math.max(lo, x)); };
const date = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && Number.isFinite(Date.parse(v)) ? String(v) : null);
const time = v => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? String(v) : '');
const id = v => (/^[\w-]{1,40}$/.test(String(v || '')) ? String(v) : null);
/** Nur https-Adressen (eigene Webcam je Startplatz). */
export const httpsUrl = v => { try { const u = new URL(String(v || '').trim()); return u.protocol === 'https:' && !u.username && !u.password && u.href.length <= 400 ? u.href : null; } catch { return null; } };
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** Höhendifferenz Start minus Landung in m (positiv = Landeplatz tiefer), null wenn eine Höhe fehlt. */
export const altDiff = f => (isNum(f?.startAlt) && isNum(f?.landAlt) ? Math.round(f.startAlt - f.landAlt) : null);
/** Flug prüfen und bereinigen; null, wenn Datum fehlt. */
export function cleanFlight(f = {}) {
  const d = date(f.date);
  if (!d) return null;
  return {
    id: id(f.id) || newId(), date: d, start: time(f.start),
    durMin: Math.round(num(f.durMin, 0, 24 * 60) ?? 0),
    siteId: id(f.siteId), siteName: str(f.siteName), landingId: id(f.landingId), landingName: str(f.landingName),
    km: num(f.km, 0, 1000), maxAlt: num(f.maxAlt, 0, 9000), startAlt: num(f.startAlt, 0, 9000), landAlt: num(f.landAlt, 0, 9000),
    gliderId: id(f.gliderId), harnessId: id(f.harnessId), reserveId: id(f.reserveId),
    rating: num(f.rating, 1, 5), kind: FLIGHT_KINDS[f.kind] ? f.kind : '',
    note: str(f.note, 500), afcScore: num(f.afcScore, 0, 100), afcVerdict: VERDICTS[f.afcVerdict] ? f.afcVerdict : '',
    track: f.track && typeof f.track === 'object' ? cleanTrack(f.track) : null,
    afcFc: f.afcFc && typeof f.afcFc === 'object' ? cleanFc(f.afcFc) : null,
    pilot: cleanPilotSnap(f.pilot)
  };
}
/**
 * Wer den Flug gemacht hat, so wie es beim Speichern im Profil stand: Stufe, Ausweis, Flugstil,
 * Flächenbelastung. Setzt der Server, damit AFC nach Pilotentyp lernen und auswerten kann.
 */
export const PILOT_LEVELS = { careful: 0, normal: 1, expert: 2 };
const LICENSE_IDS = ['student', 'brevet', 'brevetXc', 'tandem', 'instructor'];
const STYLE_IDS = ['thermal', 'soaring', 'xc', 'glide', 'hike', 'acro', 'tandem', 'skiing'];
export function cleanPilotSnap(p) {
  if (!p || typeof p !== 'object') return null;
  const o = {
    level: p.level in PILOT_LEVELS ? p.level : null,
    license: LICENSE_IDS.includes(p.license) ? p.license : null,
    styles: Array.isArray(p.styles) ? [...new Set(p.styles.filter(x => STYLE_IDS.includes(x)))] : [],
    load: num(p.load, 1, 10)
  };
  return o.level || o.license || o.styles.length || o.load != null ? o : null;
}
/** Stufe, für die eine Rückmeldung steht: Schüler zählen immer als «Vorsichtig», ohne Angabe «Normal». */
export const voterLevel = p => (p?.license === 'student' ? 'careful' : p?.level in PILOT_LEVELS ? p.level : 'normal');
// Was AFC zur Startzeit prognostiziert hat (für den Rückblick)
function cleanFc(x) {
  const o = { h: num(x.h, 0, 23), score: num(x.score, 0, 100), speed: num(x.speed, 0, 200), gust: num(x.gust, 0, 250), dir: num(x.dir, 0, 360), top: num(x.top, 0, 9000), base: num(x.base, 0, 9000), wstar: num(x.wstar, 0, 10), valley: num(x.valley, 0, 200), from: num(x.from, 0, 24), to: num(x.to, 0, 24) };
  return Object.values(o).some(v => v != null) ? o : null;
}

/**
 * Rückblick: Prognose (afcFc) gegen den Flug (IGC-Spur oder Angaben). Ergebnis: Liste von
 * { k, fc, real, note, lvl } mit lvl 'ok' (passte), 'more' (besser als erwartet), 'less' (schwächer).
 */
export function flightReview(f) {
  const fc = f?.afcFc, t = f?.track, out = [];
  if (!fc) return out;
  const th = (t?.thermals || []).filter(x => isNum(x.alt));
  const top = th.length ? Math.max(...th.map(x => x.alt)) : null;
  if (isNum(fc.top) && isNum(top)) {
    const d = Math.round((top - fc.top) / 50) * 50;
    out.push({ k: 'Thermik-Obergrenze', fc: `${Math.round(fc.top)} m`, real: `${Math.round(top)} m`, lvl: Math.abs(d) <= 200 ? 'ok' : d > 0 ? 'more' : 'less', note: Math.abs(d) <= 200 ? 'passte' : d > 0 ? `${d} m höher als erwartet` : `${-d} m tiefer als erwartet` });
  }
  const rates = th.map(x => x.rate).filter(isNum);
  if (isNum(fc.wstar) && rates.length) {
    const r = rates.reduce((a, b) => a + b, 0) / rates.length, d = r - fc.wstar;
    out.push({ k: 'Steigen im Mittel', fc: `${fc.wstar.toFixed(1)} m/s`, real: `${r.toFixed(1)} m/s`, lvl: Math.abs(d) <= 0.5 ? 'ok' : d > 0 ? 'more' : 'less', note: Math.abs(d) <= 0.5 ? 'passte' : d > 0 ? 'stärker als erwartet' : 'schwächer als erwartet' });
  }
  if (isNum(fc.base) && isNum(top) && top > fc.base + 100) out.push({ k: 'Wolkenbasis', fc: `${Math.round(fc.base)} m`, real: `über ${Math.round(top)} m geflogen`, lvl: 'more', note: 'Basis lag höher als vorhergesagt' });
  if (isNum(fc.from) && isNum(fc.to) && f.start) {
    const h0 = Number(f.start.slice(0, 2)) + Number(f.start.slice(3, 5)) / 60, h1 = h0 + (f.durMin || 0) / 60;
    const inWin = h0 >= fc.from - 0.01 && h1 <= fc.to + 1.01;
    out.push({ k: 'Zeitfenster', fc: `${fc.from}–${fc.to} Uhr`, real: `${f.start} Uhr, ${Math.round(f.durMin || 0)} min`, lvl: inWin ? 'ok' : 'less', note: inWin ? 'im Fenster geflogen' : 'ausserhalb des besten Fensters' });
  }
  return out;
}
// Zusammenfassung einer IGC-Spur (die Spur selbst bleibt als Datei)
const pt = p => (p && typeof p === 'object' ? { lat: num(p.lat, -90, 90), lon: num(p.lon, -180, 180), alt: num(p.alt, -500, 9000) } : null);
function cleanTrack(t) {
  return {
    file: str(t.file, 80), points: num(t.points, 0, 1e6), climbMax: num(t.climbMax, -20, 20), maxDistKm: num(t.maxDistKm, 0, 1000),
    takeoff: pt(t.takeoff), landing: pt(t.landing),
    thermals: Array.isArray(t.thermals) ? t.thermals.slice(0, 60).map(x => ({ lat: num(x.lat, -90, 90), lon: num(x.lon, -180, 180), base: num(x.base, -500, 9000), alt: num(x.alt, 0, 9000), rate: num(x.rate, -10, 15), gain: num(x.gain, 0, 6000), at: time(x.at) })) : [],
    line: Array.isArray(t.line) ? t.line.slice(0, 400).filter(p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)).map(p => [num(p[0], -90, 90), num(p[1], -180, 180), num(p[2], -500, 9000)]) : []
  };
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
  const cams = {};
  for (const [k, v] of Object.entries(s.cams && typeof s.cams === 'object' ? s.cams : {}).slice(0, 80)) {
    const u = httpsUrl(v);
    if (id(k) && u) cams[k] = u;
  }
  // Landevolte je Landeplatz: Richtung des Endanflugs (Grad, wohin man fliegt) und Seite der Volte
  const lands = {};
  for (const [k, v] of Object.entries(s.lands && typeof s.lands === 'object' ? s.lands : {}).slice(0, 80)) {
    const dir = num(v?.dir, 0, 359);
    if (id(k) && dir !== null) lands[k] = { dir: Math.round(dir), side: v.side === 'R' ? 'R' : 'L' };
  }
  return { flightsBefore: num(s.flightsBefore, 0, 100000) ?? 0, hoursBefore: num(s.hoursBefore, 0, 100000) ?? 0, defaults: { glider: id(s.defaults?.glider), harness: id(s.defaults?.harness), reserve: id(s.defaults?.reserve) }, cams, lands };
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

/** Flüge als Tabelle (CSV mit Semikolon, wie Excel in der Schweiz es erwartet), älteste zuerst. */
export function flightsCsv(flights = [], gear = []) {
  const gn = Object.fromEntries(gear.map(g => [g.id, gearName(g)]));
  const cell = v => {
    if (v === null || v === undefined) return '';
    let x = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(x)) x = "'" + x;   // keine Formeln in Excel
    return /[;"\r\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x;
  };
  const head = ['Nr.', 'Datum', 'Start', 'Dauer (h:mm)', 'Minuten', 'Startplatz', 'Landeplatz', 'Art', 'Schirm', 'Gurtzeug', 'Retter', 'Strecke km', 'Max. Höhe m', 'Höhe Start m', 'Höhe Landung m', 'Höhendifferenz m', 'Max. Steigen m/s', 'Thermiken', 'Bewertung', 'AFC-Wert', 'AFC lag', 'Notiz'];
  const rows = flights.slice().sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).map((f, i) => [
    i + 1, f.date.split('-').reverse().join('.'), f.start, f.durMin ? fmtDur(f.durMin) : '', f.durMin || 0, f.siteName, f.landingName, FLIGHT_KINDS[f.kind] || '',
    gn[f.gliderId] || '', gn[f.harnessId] || '', gn[f.reserveId] || '', isNum(f.km) ? String(f.km).replace('.', ',') : '', f.maxAlt ?? '', f.startAlt ?? '', f.landAlt ?? '', altDiff(f) ?? '',
    isNum(f.track?.climbMax) ? String(f.track.climbMax).replace('.', ',') : '', f.track ? f.track.thermals?.length || 0 : '', f.rating ?? '', f.afcScore ?? '', VERDICTS[f.afcVerdict] || '', f.note
  ]);
  return '\uFEFF' + [head, ...rows].map(r => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

/** Gesicherte Flugbuch-Datei prüfen: { flights, gear, settings } oder null, wenn es keine AFC-Sicherung ist. */
export function cleanBackup(b) {
  if (!b || typeof b !== 'object' || !Array.isArray(b.flights) || !Array.isArray(b.gear)) return null;
  return {
    flights: b.flights.slice(0, 20000).map(cleanFlight).filter(Boolean),
    gear: b.gear.slice(0, 500).map(cleanGear).filter(Boolean),
    settings: b.settings && typeof b.settings === 'object' ? cleanSettings(b.settings) : null
  };
}

/**
 * Was die Rückmeldungen nach den Flügen je Startplatz sagen (letzte 2 Jahre), und wie stark AFC die Bewertung dort anpasst.
 * Ab 3 Rückmeldungen. «Zu mild» zählt doppelt, weil es um Sicherheit geht. Höchstens 4 Punkte grosszügiger,
 * höchstens 8 Punkte vorsichtiger; K.-o.-Deckel bleiben immer.
 */
export const FEEDBACK_MIN_N = 3;
// Ohne ausdrückliches Urteil zählt ein Flug halb: mit «nicht starten» (unter 55) trotzdem gut geflogen = eher zu streng,
// mit «Start» (ab 70) und ordentlich bewertet = lag richtig. «Nicht gestartet» wegen Wind, Thermik, Föhn usw.,
// obwohl AFC 70 oder mehr zeigte, zählt als «zu mild» (Einträge mit kind 'nofly', siehe Server).
export const NOFLY_SAFETY = ['wind', 'thermal', 'foehn', 'cloud', 'rain'];
function verdictOf(f) {
  if (f.kind === 'nofly') return NOFLY_SAFETY.includes(f.reason) && f.afcScore >= 70 ? ['mild', 0.75] : null;
  if (VERDICTS[f.afcVerdict]) return [f.afcVerdict, 1];
  if (!isNum(f.afcScore) || !isNum(f.rating)) return null;
  if (f.afcScore < 55 && f.rating >= 4) return ['streng', 0.5];
  if (f.afcScore >= 70 && f.rating >= 3) return ['richtig', 0.5];
  return null;
}
export function siteFeedback(flights = [], now = Date.now(), level = null) {
  const from = new Date(now - 730 * DAY).toISOString().slice(0, 10), out = {};
  const target = level in PILOT_LEVELS ? PILOT_LEVELS[level] : null;
  for (const f of flights) {
    const v = f.siteId && f.date >= from ? verdictOf(f) : null;
    if (!v) continue;
    const [verdict, w0] = v;
    // Nach Pilotentyp getrennt: «zu streng» und «lag richtig» gelten nur für die eigene Stufe und erfahrenere.
    // So macht ein Streckenpilot AFC nicht für Schüler lockerer. «Zu mild» ist eine Warnung und gilt für alle.
    let other = false;
    if (target != null) {
      const vl = PILOT_LEVELS[voterLevel(f.pilot)];
      if (verdict !== 'mild' && vl > target) continue;
      other = vl !== target;
    }
    // Jüngere Rückmeldungen zählen mehr (Halbwertszeit ein Jahr)
    const w = w0 * 0.5 ** (Math.max(0, now - Date.parse(f.date)) / (365 * DAY));
    const x = out[f.siteId] ||= { n: 0, richtig: 0, streng: 0, mild: 0, adj: 0, other: 0, w: 0, wr: 0, ws: 0, wm: 0, implicit: 0 };
    x.n++; x[verdict]++; x.w += w; x['w' + verdict[0]] += w;
    if (other) x.other++;
    if (w0 < 1) x.implicit++;
  }
  for (const x of Object.values(out)) {
    if (x.n < FEEDBACK_MIN_N || x.w < FEEDBACK_MIN_N * 0.5) continue;
    const net = (x.ws - 2 * x.wm) / x.w;
    x.adj = Math.round(Math.min(4, Math.max(-8, net * 8)));
  }
  return out;
}
/** Rückmeldungen für jede Stufe einzeln (der Server rechnet die Bewertung je Stufe). */
export const siteFeedbackByLevel = (flights = [], now = Date.now()) =>
  Object.fromEntries(Object.keys(PILOT_LEVELS).map(l => [l, siteFeedback(flights, now, l)]));

if (typeof window !== 'undefined') window.AFCLog = { altDiff, GEAR_TYPES, FLIGHT_KINDS, cleanFlight, cleanGear, cleanSettings, logStats, profileFromLog, gearStatus, gearName, fmtDur, newId, flightsCsv, cleanBackup, httpsUrl, VERDICTS, siteFeedback, siteFeedbackByLevel, voterLevel, FEEDBACK_MIN_N, flightReview };
