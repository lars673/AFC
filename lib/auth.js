// Konten für die Testphase: Anmeldung mit E-Mail und Passwort, Einladungslinks, Pilotenprofil.
// Nur Hilfsfunktionen ohne Datenbank, damit sie sich einzeln testen lassen. Läuft nur im Server.
import crypto from 'node:crypto';

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const text = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/* ---------------------------------------------------------------- Passwörter */
// scrypt mit eigenem Salz je Passwort; gespeichert als «scrypt$N$salz$hash» (base64url)
const N = 16384;
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 32, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString('base64url')}$${h.toString('base64url')}`;
}
export function verifyPassword(pw, stored) {
  const [kind, n, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64url');
  const got = crypto.scryptSync(String(pw ?? ''), Buffer.from(salt, 'base64url'), want.length, { N: Number(n) || N, r: 8, p: 1 });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
/** Fehlertext für ein zu schwaches Passwort, sonst null. */
export function passwordProblem(pw) {
  const s = String(pw ?? '');
  if (s.length < 8) return 'Das Passwort braucht mindestens 8 Zeichen';
  if (s.length > 200) return 'Das Passwort ist zu lang';
  if (/^(.)\1+$/.test(s) || /^(12345678|password|passwort|qwertzui|gleitschirm)/i.test(s)) return 'Dieses Passwort ist zu einfach';
  return null;
}

/* ---------------------------------------------------------------- Sitzungen und Codes */
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const tokenHash = t => crypto.createHash('sha256').update(String(t)).digest('base64url');
/** Gut lesbarer Einladungscode ohne verwechselbare Zeichen (kein 0/O, 1/l/I). */
export function newCode(len = 10) {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(len);
  return [...b].map(x => abc[x % abc.length]).join('');
}
export const newId = () => crypto.randomBytes(9).toString('base64url');
export function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/* ---------------------------------------------------------------- Eingaben prüfen */
export function cleanEmail(s) {
  const e = String(s ?? '').trim().toLowerCase();
  return e.length <= 120 && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e) ? e : null;
}
export function cleanName(s) {
  const n = text(s, 60);
  return n.length >= 2 ? n : null;
}

// Pilotenprofil (Runde 3): nur bekannte Felder, Zahlen in sinnvollen Grenzen
export const LICENSES = { student: 'In Ausbildung (Schülerausweis)', brevet: 'Brevet', brevetXc: 'Brevet mit Streckenflug-Erfahrung', tandem: 'Tandem-Brevet', instructor: 'Fluglehrer/in' };
export const STYLES = { thermal: 'Thermik', soaring: 'Soaring', xc: 'Strecke', glide: 'Abgleiter und Genussflüge', hike: 'Hike & Fly', acro: 'Akro', tandem: 'Tandem', skiing: 'Speedflying' };
const num = (v, lo, hi, step = 1) => { const x = Number(v); return v === '' || v == null || !Number.isFinite(x) ? null : Math.min(hi, Math.max(lo, Math.round(x / step) * step)); };
export function cleanProfile(p, areaIds = null) {
  p = p && typeof p === 'object' ? p : {};
  const y = new Date().getFullYear();
  const out = {
    license: LICENSES[p.license] ? p.license : null,
    since: num(p.since, 1970, y),
    shv: p.shv === true || p.shv === 'on' || p.shv === 'true',
    shvNr: text(p.shvNr, 20).replace(/[^\w-]/g, '') || null,
    club: text(p.club, 60) || null,
    wing: text(p.wing, 60) || null,
    wingSize: text(p.wingSize, 12) || null,
    wingArea: num(p.wingArea, 10, 45, 0.1),           // ausgelegte Fläche in m²
    weight: num(p.weight, 30, 250),                   // Startgewicht (Pilot + Ausrüstung) in kg
    wingMin: num(p.wingMin, 30, 250), wingMax: num(p.wingMax, 30, 250),   // Gewichtsbereich des Schirms
    harness: text(p.harness, 60) || null,
    reserve: text(p.reserve, 60) || null,
    styles: Array.isArray(p.styles) ? [...new Set(p.styles.filter(s => STYLES[s]))] : [],
    homes: Array.isArray(p.homes) ? [...new Set(p.homes.map(String).filter(a => /^[\w-]{1,40}$/.test(a) && (!areaIds || areaIds.has(a))))].slice(0, 6) : [],
    maxWind: num(p.maxWind, 5, 60), maxGust: num(p.maxGust, 5, 70),
    emergName: text(p.emergName, 60) || null,
    emergPhone: text(p.emergPhone, 30).replace(/[^\d+ ()/-]/g, '') || null,
    phone: text(p.phone, 30).replace(/[^\d+ ()/-]/g, '') || null,
    bio: text(p.bio, 300) || null,
    birthYear: num(p.birthYear, 1920, y - 10)
  };
  if (isNum(out.wingMin) && isNum(out.wingMax) && out.wingMin > out.wingMax) [out.wingMin, out.wingMax] = [out.wingMax, out.wingMin];
  return out;
}
/** Flächenbelastung in kg/m² und Lage im Gewichtsbereich (0 = unten, 1 = oben), wenn die Angaben reichen. */
export function wingLoading(p) {
  const r = {};
  if (isNum(p?.weight) && isNum(p?.wingArea)) r.load = Math.round(p.weight / p.wingArea * 100) / 100;
  if (isNum(p?.weight) && isNum(p?.wingMin) && isNum(p?.wingMax) && p.wingMax > p.wingMin) r.pos = Math.round((p.weight - p.wingMin) / (p.wingMax - p.wingMin) * 100) / 100;
  return r;
}

// Was früher nur im Browser lag: Favoriten, Erfahrungsstufe, Pilotenangaben für die Grenzen
const LEVEL_IDS = ['careful', 'normal', 'expert'];
export function cleanUserPrefs(p) {
  p = p && typeof p === 'object' ? p : {};
  const pi = p.pilot && typeof p.pilot === 'object' ? p.pilot : null;
  const out = {
    fav: Array.isArray(p.fav) ? [...new Set(p.fav.map(String).filter(x => /^[a-z0-9-]{1,60}$/.test(x)))].slice(0, 60) : [],
    level: LEVEL_IDS.includes(p.level) ? p.level : null,
    levelManual: p.levelManual === true,
    shareName: p.shareName === true,
    pilot: pi ? {
      flights: num(pi.flights, 0, 20000), hours12: num(pi.hours12, 0, 2000),
      glider: ['A', 'B', 'C', 'D'].includes(pi.glider) ? pi.glider : null,
      lastFlight: /^\d{4}-\d{2}-\d{2}$/.test(pi.lastFlight || '') ? pi.lastFlight : null,
      student: pi.student === true
    } : null
  };
  return out;
}
/** Profilbild: nur JPEG/PNG/WebP als data-URL, höchstens 400 KB (die App verkleinert vorher auf 320 px). */
export function cleanPhoto(s) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  if (!m || m[2].length > 400 * 1024 * 4 / 3) return null;
  const buf = Buffer.from(m[2], 'base64');
  const ok = m[1] === 'jpeg' ? buf[0] === 0xff && buf[1] === 0xd8 : m[1] === 'png' ? buf[0] === 0x89 && buf[1] === 0x50 : buf.slice(0, 4).toString() === 'RIFF';
  return ok ? { type: 'image/' + m[1], buf } : null;
}

/* ---------------------------------------------------------------- Rückmeldungen der Testpiloten */
export const FEEDBACK_KINDS = { idea: 'Idee', bug: 'Fehler', praise: 'Lob', forecast: 'Prognose', nofly: 'Nicht gestartet', survey: 'Umfrage' };
export const NOFLY_REASONS = { wind: 'Zu viel Wind oder Böen', thermal: 'Thermik zu stark', weak: 'Zu schwach, nicht lohnend', cloud: 'Wolken oder Nebel am Start', rain: 'Regen oder Gewitter', foehn: 'Föhn oder Bise', time: 'Keine Zeit', feeling: 'Bauchgefühl', other: 'Anderes' };
export function cleanFeedback(b) {
  b = b && typeof b === 'object' ? b : {};
  const kind = FEEDBACK_KINDS[b.kind] ? b.kind : 'idea';
  const out = {
    kind,
    text: String(b.text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 2000),
    page: text(b.page, 60) || null,
    site: /^[a-z0-9-]{1,60}$/.test(b.site || '') ? b.site : null,
    reason: kind === 'nofly' && NOFLY_REASONS[b.reason] ? b.reason : null,
    score: num(b.score, 0, 100),
    ver: text(b.ver, 20) || null,
    device: text(b.device, 160) || null,
    answers: kind === 'survey' && b.answers && typeof b.answers === 'object'
      ? Object.fromEntries(Object.entries(b.answers).slice(0, 20).map(([k, v]) => [text(k, 30), typeof v === 'number' ? num(v, 0, 10) : text(v, 600)]))
      : null
  };
  if (!out.text && kind !== 'nofly' && kind !== 'survey') return null;
  return out;
}
export function cleanClientError(b) {
  b = b && typeof b === 'object' ? b : {};
  const msg = text(b.msg, 300);
  if (!msg) return null;
  return { msg, src: text(b.src, 200) || null, line: num(b.line, 0, 1e7), stack: String(b.stack ?? '').slice(0, 1500), page: text(b.page, 60) || null, ver: text(b.ver, 20) || null, device: text(b.device, 160) || null };
}
