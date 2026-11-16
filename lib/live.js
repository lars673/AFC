// Live-Piloten: wer jetzt in der Luft ist und wie es dort steigt.
// Quelle ist das Open Glider Network (OGN, glidernet.org): Gleitschirme und Deltas mit FLARM, FANET oder OGN-Tracker.
// OGN liefert nur Geräte, die sich zeigen wollen; AFC gibt weder Kennzeichen noch Gerätenummern an die App weiter.
// Das Steigen rechnet AFC selbst aus dem Höhenverlauf der letzten 90 Sekunden (ruhiger als der gemeldete Momentanwert).
// Wo jemand deutlich gestiegen ist, bleibt ein «Steigpunkt» 40 Minuten stehen: so sieht man, wo es heute trägt.
import crypto from 'node:crypto';
import { haversineKm } from './util.js';

export const LIVE = {
  types: { 6: 'hg', 7: 'pg' },   // OGN-Luftfahrzeugart: 6 Delta, 7 Gleitschirm
  maxAge: 180,                   // ältere Meldungen in Sekunden zählen nicht mehr als «jetzt»
  keepMs: 12 * 60000,            // Höhenverlauf je Pilot
  winS: 90, minS: 25,            // Fenster für das Steigen, Mindestspanne
  minClimb: 0.7,                 // ab hier wird ein Steigpunkt gemerkt (m/s)
  spotMs: 40 * 60000, spotM: 300,
  nearKm: 5,                     // «am Startplatz»: Umkreis
  minAgl: 40, minGs: 12          // darunter gilt ein Gerät als am Boden
};

/** Antwort von live.glidernet.org lesen: je Gerät eine Zeile <m a="lat,lon,kurz,kennung,höhe,zeit,alter,kurs,tempo,steigen,art,empfänger,gerät,id"/>. */
export function parseLive(xml) {
  const out = [];
  for (const m of String(xml || '').matchAll(/<m a="([^"]{10,300})"/g)) {
    const f = m[1].split(',');
    if (f.length < 14) continue;
    const kind = LIVE.types[f[10]];
    if (!kind) continue;
    const n = i => { const v = Number(f[i]); return Number.isFinite(v) ? v : null; };
    const lat = n(0), lon = n(1), alt = n(4), age = n(6);
    if (lat == null || lon == null || alt == null || age == null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || alt < -200 || alt > 9000 || age < 0) continue;
    out.push({ id: String(f[13] || f[12] || f[3]).slice(0, 40), kind, lat, lon, alt, age, track: n(7), gs: n(8), vario: n(9) });
  }
  return out;
}

/** Merkt den Höhenverlauf je Pilot und die Steigpunkte. elev(lat, lon) gibt die Geländehöhe oder null. */
export function makeTracker(elev = () => null) {
  const pilots = new Map(), salt = crypto.randomBytes(8).toString('hex');
  let spots = [];
  const key = id => crypto.createHash('sha256').update(salt + id).digest('hex').slice(0, 8);

  function climbOf(p, now) {
    const pts = p.pts, last = pts.at(-1);
    let first = null;
    for (const q of pts) if (last.t - q.t <= LIVE.winS * 1000) { first = q; break; }
    const dt = first ? (last.t - first.t) / 1000 : 0;
    if (dt >= LIVE.minS) return (last.alt - first.alt) / dt;
    return p.vario != null && Math.abs(p.vario) <= 12 ? p.vario : null;
  }

  function update(rows, now = Date.now()) {
    for (const r of rows) {
      const t = now - r.age * 1000;
      let p = pilots.get(r.id);
      if (!p) pilots.set(r.id, p = { k: key(r.id), kind: r.kind, pts: [] });
      const last = p.pts.at(-1);
      if (last && t <= last.t + 900) continue;   // dieselbe Meldung nochmals
      p.pts.push({ t, lat: r.lat, lon: r.lon, alt: r.alt });
      p.track = r.track; p.gs = r.gs; p.vario = r.vario;
      const g = elev(r.lat, r.lon);
      p.agl = g == null ? null : Math.round(r.alt - g);
      p.fly = p.agl == null ? (r.gs ?? 0) >= LIVE.minGs : p.agl >= LIVE.minAgl || (r.gs ?? 0) >= LIVE.minGs && p.agl >= 15;
      p.climb = climbOf(p, now);
      if (p.fly && p.climb != null && p.climb >= LIVE.minClimb && r.age <= LIVE.maxAge) {
        const s = spots.find(q => haversineKm(q.lat, q.lon, r.lat, r.lon) * 1000 <= LIVE.spotM);
        if (s) { if (p.climb >= s.climb || now - s.at > 5 * 60000) { s.climb = p.climb; s.lat = r.lat; s.lon = r.lon; } s.at = t; s.top = Math.max(s.top, r.alt); s.ks.add(p.k); }
        else spots.push({ lat: r.lat, lon: r.lon, climb: p.climb, top: r.alt, at: t, ks: new Set([p.k]) });
      }
    }
    for (const [id, p] of pilots) {
      p.pts = p.pts.filter(q => now - q.t <= LIVE.keepMs);
      if (!p.pts.length) pilots.delete(id);
    }
    spots = spots.filter(s => now - s.at <= LIVE.spotMs);
  }

  /** Stand für die App: Piloten in der Luft, Steigpunkte und eine Zeile je Startplatz. */
  function snapshot(sites = [], now = Date.now()) {
    const r1 = v => Math.round(v * 10) / 10, r4 = v => Math.round(v * 1e4) / 1e4;
    const air = [];
    for (const p of pilots.values()) {
      const l = p.pts.at(-1), age = Math.round((now - l.t) / 1000);
      if (!p.fly || age > LIVE.maxAge) continue;
      air.push({ k: p.k, kind: p.kind, lat: r4(l.lat), lon: r4(l.lon), alt: Math.round(l.alt), agl: p.agl, climb: p.climb == null ? null : r1(p.climb), track: p.track, gs: p.gs == null ? null : Math.round(p.gs), age });
    }
    const sp = spots.map(s => ({ lat: r4(s.lat), lon: r4(s.lon), climb: r1(s.climb), top: Math.round(s.top), min: Math.max(0, Math.round((now - s.at) / 60000)), n: s.ks.size }));
    const bySite = {};
    for (const s of sites) {
      const near = air.filter(p => haversineKm(s.lat, s.lon, p.lat, p.lon) <= LIVE.nearKm);
      const ns = sp.filter(q => haversineKm(s.lat, s.lon, q.lat, q.lon) <= LIVE.nearKm);
      if (!near.length && !ns.length) continue;
      const best = ns.reduce((a, q) => (!a || q.climb > a.climb ? q : a), null);
      bySite[s.id] = { n: near.length, top: near.length ? Math.max(...near.map(p => p.alt)) : null, climb: best ? best.climb : null, climbMin: best ? best.min : null, climbTop: best ? best.top : null };
    }
    return { pilots: air, spots: sp, sites: bySite };
  }
  return { update, snapshot, size: () => pilots.size };
}
