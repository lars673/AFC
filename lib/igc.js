// IGC-Dateien (Flugaufzeichnung von Vario oder Handy) lesen und zu einem Flugbuch-Eintrag zusammenfassen:
// Start, Landung, Dauer, max. Höhe, Strecke, Thermiken (Ort, Basis, Obergrenze, Steigen) und eine vereinfachte Spur.
// Läuft im Browser (als /igc.js) und in den Tests.

const R = 6371000, D2R = Math.PI / 180;
export const distM = (a, b) => {
  const dLa = (b.lat - a.lat) * D2R, dLo = (b.lon - a.lon) * D2R;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/** IGC-Text -> { date: 'YYYY-MM-DD' (UTC), fixes: [{ t (ms UTC), lat, lon, alt }], pilot, glider } */
export function parseIgc(text) {
  let day = null, pilot = '', glider = '';
  const fixes = [];
  let dayOffset = 0, lastSec = -1;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('HFDTE')) {
      const m = line.match(/^HFDTE(?:DATE:)?(\d{2})(\d{2})(\d{2})/);
      if (m) day = `20${m[3]}-${m[2]}-${m[1]}`;
    } else if (/^HFPLT/.test(line)) pilot = line.split(':').slice(1).join(':').trim();
    else if (/^HFGTY/.test(line)) glider = line.split(':').slice(1).join(':').trim();
    else if (line[0] === 'B' && line.length >= 35) {
      const m = line.match(/^B(\d{2})(\d{2})(\d{2})(\d{2})(\d{5})([NS])(\d{3})(\d{5})([EW])([AV])([-\d]{5})([-\d]{5})/);
      if (!m) continue;
      const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      if (lastSec >= 0 && sec < lastSec - 3600) dayOffset += 86400;   // über Mitternacht (UTC)
      lastSec = sec;
      const lat = (Number(m[4]) + Number(m[5]) / 60000) * (m[6] === 'S' ? -1 : 1);
      const lon = (Number(m[7]) + Number(m[8]) / 60000) * (m[9] === 'W' ? -1 : 1);
      const pAlt = Number(m[11]), gAlt = Number(m[12]);
      if (!lat && !lon) continue;
      fixes.push({ s: sec + dayOffset, lat, lon, alt: gAlt > 0 ? gAlt : pAlt, valid: m[10] === 'A' });
    }
  }
  if (!day || fixes.length < 2) return { date: day, fixes: [], pilot, glider };
  const t0 = Date.parse(day + 'T00:00:00Z');
  return { date: day, fixes: fixes.map(f => ({ t: t0 + f.s * 1000, lat: f.lat, lon: f.lon, alt: f.alt })), pilot, glider };
}

// Index des ersten Punkts, der mindestens sec Sekunden nach i liegt
function ahead(fx, i, sec) {
  let j = i;
  while (j < fx.length - 1 && fx[j].t - fx[i].t < sec * 1000) j++;
  return j;
}

/** Ortszeit (Schweiz) eines Zeitpunkts -> { date: 'YYYY-MM-DD', time: 'HH:MM' } */
export function localCH(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/**
 * Flug aus der Spur: Start = erste Bewegung schneller als 15 km/h über 20 s, Landung = letzte solche Bewegung.
 * Thermik = Abschnitt mit mehr als 0.5 m/s Steigen (20-s-Mittel), mindestens 40 s und 50 m Höhengewinn.
 */
export function analyzeIgc(text, file = '') {
  const igc = parseIgc(text);
  const fx = igc.fixes;
  if (fx.length < 10) return null;
  const moving = i => { const j = ahead(fx, i, 20); return j > i && distM(fx[i], fx[j]) / ((fx[j].t - fx[i].t) / 1000) > 4.2; };
  let a = 0, b = fx.length - 1;
  while (a < fx.length - 1 && !moving(a)) a++;
  while (b > a && !moving(b)) b--;
  b = ahead(fx, b, 20);
  // genau auf den ersten bzw. letzten Schritt mit Bewegung (mehr als 2 m/s) schieben
  const speed = k => distM(fx[k], fx[k + 1]) / Math.max(1, (fx[k + 1].t - fx[k].t) / 1000);
  while (a < b - 1 && speed(a) < 2) a++;
  while (b > a + 1 && speed(b - 1) < 2) b--;
  if (b - a < 5) { a = 0; b = fx.length - 1; }
  const fl = fx.slice(a, b + 1);
  const start = fl[0], land = fl[fl.length - 1];
  const maxAlt = Math.max(...fl.map(f => f.alt));
  const farthest = Math.max(...fl.map(f => distM(start, f)));

  // Steigen im 20-s-Mittel
  const vario = fl.map((f, i) => { const j = ahead(fl, i, 20); return j > i ? (fl[j].alt - f.alt) / ((fl[j].t - f.t) / 1000) : 0; });
  const climbMax = Math.max(0, ...vario);
  const thermals = [];
  let i = 0;
  while (i < fl.length) {
    if (vario[i] <= 0.5) { i++; continue; }
    let k = i, lastUp = i;
    while (k < fl.length && (vario[k] > 0.5 || fl[k].t - fl[lastUp].t < 30000)) { if (vario[k] > 0.5) lastUp = k; k++; }
    const end = ahead(fl, lastUp, 20);
    const seg = fl.slice(i, end + 1);
    const lo = seg.reduce((m, f) => (f.alt < m.alt ? f : m)), hi = seg.reduce((m, f) => (f.alt > m.alt ? f : m));
    const dt = (hi.t - lo.t) / 1000, gain = hi.alt - lo.alt;
    if (dt >= 40 && gain >= 50) {
      thermals.push({ lat: +(seg.reduce((s, f) => s + f.lat, 0) / seg.length).toFixed(5), lon: +(seg.reduce((s, f) => s + f.lon, 0) / seg.length).toFixed(5), base: Math.round(lo.alt), alt: Math.round(hi.alt), gain: Math.round(gain), rate: Math.round(gain / dt * 10) / 10, at: localCH(lo.t).time });
    }
    i = Math.max(end, i + 1) + 1;
  }

  // vereinfachte Spur (höchstens 300 Punkte) für die Anzeige
  const step = Math.max(1, Math.ceil(fl.length / 300));
  const line = fl.filter((_, n) => n % step === 0 || n === fl.length - 1).map(f => [+f.lat.toFixed(5), +f.lon.toFixed(5), Math.round(f.alt)]);
  const l0 = localCH(start.t);
  return {
    date: l0.date, start: l0.time, durMin: Math.round((land.t - start.t) / 60000),
    maxAlt: Math.round(maxAlt), km: Math.round(distM(start, land) / 100) / 10,
    takeoff: { lat: start.lat, lon: start.lon, alt: Math.round(start.alt) }, landing: { lat: land.lat, lon: land.lon, alt: Math.round(land.alt) },
    track: { file: String(file).slice(0, 80), points: fx.length, climbMax: Math.round(climbMax * 10) / 10, maxDistKm: Math.round(farthest / 100) / 10, thermals: thermals.slice(0, 60), line },
    pilot: igc.pilot, glider: igc.glider
  };
}

/** Nächster Platz innerhalb von maxM Metern (Startplätze bzw. Landeplätze aus dem Plan). */
export function nearestPlace(list, p, maxM) {
  let best = null, bd = Infinity;
  for (const s of list || []) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const d = distM(p, s);
    if (d < bd) { bd = d; best = s; }
  }
  return bd <= maxM ? best : null;
}

if (typeof window !== 'undefined') window.AFCIgc = { parseIgc, analyzeIgc, nearestPlace, distM, localCH };
