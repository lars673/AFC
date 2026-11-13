// HTTP-Hilfen mit Timeout und einem Wiederholungsversuch.
export const FETCH_TIMEOUT_MS = Number(process.env.AFC_FETCH_TIMEOUT_MS || 20000);

// Open-Meteo-Verbrauch: Open-Meteo zählt je Ort einen Aufruf, mehr als 10 Variablen oder mehr als 2 Wochen anteilig
// (15 Variablen = 1.5 Aufrufe, 4 Wochen = 2 Aufrufe). Gratis sind 10 000 pro Tag, 5000 pro Stunde und 600 pro Minute.
// Abgelehnte Abfragen (HTTP 429) zählen nicht. Lehnt Open-Meteo ab, fragt AFC bis zum Ende der Sperre nicht mehr
// nach (statt mit Wiederholungen und Ersatzabfragen weiter anzuklopfen) und zeigt so lange den letzten Stand.
const usage = { day: '', calls: 0, requests: 0, hours: new Map(), onChange: null, blockedUntil: 0, blockedReason: null, refusedAt: null };
const round1 = x => Math.round(x * 10) / 10;
export function openMeteoWeight(url) {
  let u; try { u = new URL(url); } catch { return 0; }
  const lat = u.searchParams.get('latitude'), vars = u.searchParams.get('hourly') || u.searchParams.get('daily');
  if (!lat || !vars) return 0;
  const s = u.searchParams.get('start_date'), e = u.searchParams.get('end_date');
  const days = s && e ? (Date.parse(e) - Date.parse(s)) / 86400000 + 1 : Number(u.searchParams.get('forecast_days')) || 7;
  return round1(lat.split(',').length * Math.max(1, vars.split(',').length / 10) * Math.max(1, days / 14));
}
function rollDay(now) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (usage.day !== day) { usage.day = day; usage.calls = 0; usage.requests = 0; }
}
/** Verbrauch von aussen dazuzählen (z. B. der Rückblick-Test läuft als eigener Prozess). */
export function addOpenMeteoUsage(w, now = Date.now()) {
  if (!(w > 0)) return;
  const hour = Math.floor(now / 3600000);
  rollDay(now);
  usage.calls = round1(usage.calls + w); usage.requests++;
  usage.hours.set(hour, round1((usage.hours.get(hour) || 0) + w));
  for (const h of usage.hours.keys()) if (h < hour - 24) usage.hours.delete(h);
  usage.onChange?.(openMeteoUsage(now));
}
/** Bis wann Open-Meteo gesperrt hat: Tageslimit bis Mitternacht UTC, Stundenlimit bis zur vollen Stunde, sonst 1 Minute. */
export function limitUntil(reason, now = Date.now()) {
  const r = String(reason || '').toLowerCase();
  if (/daily|day|tag/.test(r)) return Math.floor(now / 86400000) * 86400000 + 86400000;
  if (/hour|stunde/.test(r)) return Math.floor(now / 3600000) * 3600000 + 3600000;
  if (/minut/.test(r)) return now + 60000;
  return now + 15 * 60000;
}
function noteRefusal(reason, now = Date.now()) {
  usage.blockedUntil = Math.max(usage.blockedUntil, limitUntil(reason, now));
  usage.blockedReason = String(reason || 'HTTP 429').slice(0, 120);
  usage.refusedAt = now;
  usage.onChange?.(openMeteoUsage(now));
}
/** Hat Open-Meteo gerade gesperrt? -> Zeitpunkt (ms), bis wann, sonst 0. */
export function openMeteoBlocked(now = Date.now()) { return usage.blockedUntil > now ? usage.blockedUntil : 0; }
/** Verbrauch heute (UTC-Tag, wie bei Open-Meteo) und in der letzten Stunde. */
export function openMeteoUsage(now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  return { day, calls: usage.day === day ? usage.calls : 0, requests: usage.day === day ? usage.requests : 0, lastHour: usage.hours.get(Math.floor(now / 3600000)) || 0, limitDay: 10000, limitHour: 5000,
    blockedUntil: openMeteoBlocked(now) || null, blockedReason: openMeteoBlocked(now) ? usage.blockedReason : null, refusedAt: usage.refusedAt && new Date(usage.refusedAt).toISOString().slice(0, 10) === day ? usage.refusedAt : null };
}
/** Zählerstand nach einem Neustart übernehmen und Änderungen melden (zum Speichern). */
export function initOpenMeteoUsage(saved, onChange) {
  if (saved?.day === new Date().toISOString().slice(0, 10)) {
    usage.day = saved.day; usage.calls = saved.calls || 0; usage.requests = saved.requests || 0;
    usage.blockedUntil = saved.blockedUntil || 0; usage.blockedReason = saved.blockedReason || null; usage.refusedAt = saved.refusedAt || null;
  }
  usage.onChange = onChange;
}
/** Nur für Tests: Zähler und Sperre zurücksetzen. */
export function resetOpenMeteoUsage() { Object.assign(usage, { day: '', calls: 0, requests: 0, hours: new Map(), blockedUntil: 0, blockedReason: null, refusedAt: null }); }

export async function httpGet(url, { accept = 'text/plain', timeoutMs = FETCH_TIMEOUT_MS, retries = 1 } = {}) {
  const w = openMeteoWeight(url);
  if (w && openMeteoBlocked()) {
    const until = new Date(openMeteoBlocked()).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Zurich' });
    throw Object.assign(new Error(`Open-Meteo-Kontingent: wieder ab ${until} Uhr`), { limit: true });
  }
  let last;
  for (let a = 0; a <= retries; a++) {
    try {
      const r = await fetch(url, {
        headers: { Accept: accept, 'User-Agent': 'AFC (+paragliding weather assistant)' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (w && r.status === 429) {
        // Open-Meteo sperrt: nicht wiederholen, bis zum Ende der Sperre nicht mehr fragen
        let reason = 'HTTP 429';
        try { reason = (await r.json())?.reason || reason; } catch { /* kein JSON */ }
        noteRefusal(reason);
        throw Object.assign(new Error(`Open-Meteo-Kontingent erreicht (${reason})`), { limit: true, final: true, status: 429 });
      }
      if (w && r.ok) addOpenMeteoUsage(w);
      if (!r.ok) {
        const e = new Error(`HTTP ${r.status}`);
        e.status = r.status;
        // 4xx (ausser 429) lohnt keinen zweiten Versuch
        if (r.status >= 400 && r.status < 500 && r.status !== 429) throw Object.assign(e, { final: true });
        throw e;
      }
      return r;
    } catch (e) {
      last = e;
      if (e.final) break;
      if (a < retries) await new Promise(res => setTimeout(res, 600));
    }
  }
  if (last?.limit) throw last;
  throw new Error(`${new URL(url).host}: ${last?.name === 'TimeoutError' ? 'Zeitüberschreitung' : last?.message || last}`);
}
