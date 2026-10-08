// Gemeinsame, reine Hilfsfunktionen (keine Seiteneffekte, keine Netzwerkzugriffe).

export const TZ = 'Europe/Zurich';

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const isNum = v => typeof v === 'number' && Number.isFinite(v);
export const num = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

export function mean(a) {
  const x = a.filter(isNum);
  return x.length ? x.reduce((s, v) => s + v, 0) / x.length : null;
}
export function robustMean(a) {
  const x = a.filter(isNum).sort((p, q) => p - q);
  if (x.length < 5) return mean(x);
  const c = Math.floor(x.length * 0.1);
  return mean(x.slice(c, x.length - c));
}
export function circularMean(a) {
  const x = a.filter(isNum);
  if (!x.length) return null;
  let s = 0, c = 0;
  for (const d of x) { const r = d * Math.PI / 180; s += Math.sin(r); c += Math.cos(r); }
  return (Math.atan2(s, c) * 180 / Math.PI + 360) % 360;
}

/** Kleinster Winkelunterschied zweier Richtungen in Grad (0..180). */
export function windDiff(a, b) { return Math.abs(((a - b + 540) % 360) - 180); }
/** Vorzeichenbehafteter Richtungsfehler b - a in (-180, 180]. */
export function dirError(actual, forecast) { return ((actual - forecast + 540) % 360) - 180; }
/** Anteil des Windes aus Richtung `target` (0..1). */
export function windComponent(dir, target) {
  if (!isNum(dir)) return 0;
  return Math.max(0, Math.cos((dir - target) * Math.PI / 180));
}

/** Wind (Geschwindigkeit, meteorologische Richtung "woher") -> u/v-Komponenten. */
export function toVector(speed, dir) {
  const r = (dir || 0) * Math.PI / 180;
  return { u: -speed * Math.sin(r), v: -speed * Math.cos(r) };
}
export function fromVector(u, v) {
  return { speed: Math.hypot(u, v), dir: (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360 };
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, d2r = Math.PI / 180;
  const dLat = (lat2 - lat1) * d2r, dLon = (lon2 - lon1) * d2r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Beliebiges MeteoSchweiz-/ISO-Zeitformat -> ISO-UTC-String (oder null). */
export function toIsoTime(raw) {
  if (raw == null) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
  const s = String(raw).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])).toISOString();
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5])).toISOString();
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) {
    const hasZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
    const d = hasZone ? new Date(s) : new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Open-Meteo liefert bei timezone=UTC "2026-10-08T13:00" ohne Zone. */
export function omTimeToMs(t) { return Date.parse(String(t).length === 16 ? t + ':00Z' : t); }

const zurichFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
});
/** { date:'YYYY-MM-DD', hour:0..23 } in Schweizer Ortszeit. */
export function zurichParts(ms) {
  const o = {};
  for (const p of zurichFmt.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { date: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24 };
}

/** Sonnenstand (NOAA-Näherung). */
export function solarPosition(ms, latDeg, lonDeg) {
  const jd = ms / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525;
  const L = (280.46 + 36000.77 * T) % 360;
  const M = (357.52911 + 35999.05029 * T) % 360;
  const Mr = M * Math.PI / 180;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(Mr) + (0.019993 - 0.000101 * T) * Math.sin(2 * Mr) + 0.000289 * Math.sin(3 * Mr);
  const lam = ((L + C + 180 + 102.9372) % 360) * Math.PI / 180;
  const eps = (23.439291 - 0.0130042 * T) * Math.PI / 180;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const gmst = (280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - (T * T * T) / 38710000) % 360;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const H = (gmst + lonDeg) * Math.PI / 180 - ra;
  const lat = latDeg * Math.PI / 180;
  const elev = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H));
  let az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat));
  az = (az * 180 / Math.PI + 180 + 360) % 360;
  return { elevationDeg: elev * 180 / Math.PI, azimuthDeg: az };
}

export const DIR16 = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const dirLabel = deg => (isNum(deg) ? DIR16[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16] : '–');
