// Regenradar (RainViewer, gratis für persönliche Nutzung) und Webcam-Bilder über den eigenen Mac.
// Der Mac holt die Bilder und gibt sie an die App weiter: so bleibt die App auf der eigenen Adresse
// (keine fremden Verbindungen aus dem Browser) und das Radarbild lässt sich für «Regen in der Nähe» auswerten.
import net from 'node:net';

export const RADAR_MAX_Z = 7;

/** Radar-Übersicht: die letzten Bilder (alle 10 Minuten, 2 Stunden zurück). */
export function radarFrames(json, { allowLocal = false } = {}) {
  const host = typeof json?.host === 'string' && (/^https:\/\/[\w.-]+$/.test(json.host) || (allowLocal && /^http:\/\/127\.0\.0\.1:\d+$/.test(json.host))) ? json.host : null;
  const past = Array.isArray(json?.radar?.past) ? json.radar.past : [];
  if (!host) return { host: null, frames: [] };
  const frames = past.filter(f => Number.isInteger(f?.time) && typeof f.path === 'string' && /^\/[\w/.-]{1,80}$/.test(f.path))
    .map(f => ({ time: f.time, path: f.path })).slice(-13);
  return { host, frames };
}

/** Kachel-Koordinaten prüfen (nur Zahlen, Zoom 0–7, im Raster). */
export function tileOk(z, x, y) {
  return [z, x, y].every(Number.isInteger) && z >= 0 && z <= RADAR_MAX_Z && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;
}

const PRIVATE = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^f[cd]/i, /^fe80/i];
/** Webcam-Adresse: nur https, keine Zugangsdaten, kein Port, kein lokales Netz. */
export function camUrlOk(v) {
  let u; try { u = new URL(String(v || '')); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || u.href.length > 400) return null;
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.local$|\.internal$|\.ts\.net$/i.test(h) || !h.includes('.') && !net.isIP(h)) return null;
  if (net.isIP(h) && PRIVATE.some(r => r.test(h))) return null;
  return u.href;
}

/** Kleiner Zwischenspeicher mit Ablaufzeit und Höchstzahl. */
export function makeCache(max = 200) {
  const m = new Map();
  return {
    get(k) { const v = m.get(k); if (!v) return null; if (v.until < Date.now()) { m.delete(k); return null; } return v.val; },
    set(k, val, ms) { m.delete(k); m.set(k, { val, until: Date.now() + ms }); while (m.size > max) m.delete(m.keys().next().value); }
  };
}
