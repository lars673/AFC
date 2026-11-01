// HTTP-Hilfen mit Timeout und einem Wiederholungsversuch.
export const FETCH_TIMEOUT_MS = Number(process.env.AFC_FETCH_TIMEOUT_MS || 20000);

// Open-Meteo-Verbrauch: Open-Meteo zählt je Ort einen Aufruf, je angefangene 10 Variablen und 2 Wochen mehr.
// Gratis sind 10 000 pro Tag, 5000 pro Stunde und 600 pro Minute.
const usage = { day: '', calls: 0, requests: 0, hours: new Map(), onChange: null };
export function openMeteoWeight(url) {
  let u; try { u = new URL(url); } catch { return 0; }
  const lat = u.searchParams.get('latitude'), vars = u.searchParams.get('hourly');
  if (!lat || !vars) return 0;
  const days = Number(u.searchParams.get('forecast_days')) || 7;
  return lat.split(',').length * Math.ceil(vars.split(',').length / 10) * Math.ceil(days / 14);
}
function countUsage(url, now = Date.now()) {
  const w = openMeteoWeight(url);
  if (!w) return;
  const day = new Date(now).toISOString().slice(0, 10), hour = Math.floor(now / 3600000);
  if (usage.day !== day) { usage.day = day; usage.calls = 0; usage.requests = 0; }
  usage.calls += w; usage.requests++;
  usage.hours.set(hour, (usage.hours.get(hour) || 0) + w);
  for (const h of usage.hours.keys()) if (h < hour - 24) usage.hours.delete(h);
  usage.onChange?.(openMeteoUsage(now));
}
/** Verbrauch heute (UTC-Tag, wie bei Open-Meteo) und in der letzten Stunde. */
export function openMeteoUsage(now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  return { day, calls: usage.day === day ? usage.calls : 0, requests: usage.day === day ? usage.requests : 0, lastHour: usage.hours.get(Math.floor(now / 3600000)) || 0, limitDay: 10000, limitHour: 5000 };
}
/** Zählerstand nach einem Neustart übernehmen und Änderungen melden (zum Speichern). */
export function initOpenMeteoUsage(saved, onChange) {
  if (saved?.day === new Date().toISOString().slice(0, 10)) { usage.day = saved.day; usage.calls = saved.calls || 0; usage.requests = saved.requests || 0; }
  usage.onChange = onChange;
}

export async function httpGet(url, { accept = 'text/plain', timeoutMs = FETCH_TIMEOUT_MS, retries = 1 } = {}) {
  let last;
  for (let a = 0; a <= retries; a++) {
    try {
      countUsage(url);
      const r = await fetch(url, {
        headers: { Accept: accept, 'User-Agent': 'AFC/8.0 (+paragliding weather assistant)' },
        signal: AbortSignal.timeout(timeoutMs)
      });
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
  throw new Error(`${new URL(url).host}: ${last?.name === 'TimeoutError' ? 'Zeitüberschreitung' : last?.message || last}`);
}
