// Nutzungsmessung für die Testphase: welche Reiter und Funktionen wie oft und wie lange genutzt werden.
// Datensparsam: nur Zähler pro Pilot und Tag (keine Klickspur, keine Inhalte, keine Fremdanbieter).
// Die App schickt kleine Pakete { ev: [{ k: 'tab'|'feat'|'sess'|'exit'|'flow', key, n, s }] }.

export const USAGE_KINDS = new Set(['tab', 'feat', 'sess', 'exit', 'flow']);
export const USAGE_KEEP_DAYS = 120;
const KEY_RE = /^[a-z0-9:_-]{1,40}$/;

/** Prüft ein Paket aus der App und fasst gleiche Einträge zusammen. Ungültiges fällt still weg. */
export function cleanUsage(body) {
  const ev = Array.isArray(body?.ev) ? body.ev.slice(0, 120) : [];
  const out = new Map();
  for (const e of ev) {
    if (!e || !USAGE_KINDS.has(e.k) || typeof e.key !== 'string' || !KEY_RE.test(e.key)) continue;
    const n = Math.max(0, Math.min(500, Math.round(Number(e.n) || 0)));
    const s = Math.max(0, Math.min(6 * 3600, Math.round(Number(e.s) || 0)));
    if (!n && !s) continue;
    const id = e.k + '|' + e.key, o = out.get(id) || { kind: e.k, key: e.key, n: 0, secs: 0 };
    o.n = Math.min(500, o.n + n); o.secs = Math.min(6 * 3600, o.secs + s);
    out.set(id, o);
  }
  return [...out.values()];
}

/**
 * Überblick für die Admin-Ansicht.
 * rows: [{ uid, day, kind, key, n, secs }] aus der Datenbank (schon auf den Zeitraum begrenzt)
 * users: [{ id, name, role }], activeDays: Map uid -> [Tage mit Öffnen der App] (alle, für «abgesprungen»)
 */
export function usageSummary(rows, { users = [], activeDays = new Map(), today, from, withAdmin = false } = {}) {
  const admins = new Set(users.filter(u => u.role === 'admin').map(u => u.id));
  const names = Object.fromEntries(users.map(u => [u.id, u.name]));
  const use = rows.filter(r => names[r.uid] != null && (withAdmin || !admins.has(r.uid)));
  const agg = (kind) => {
    const m = new Map();
    for (const r of use) {
      if (r.kind !== kind) continue;
      const o = m.get(r.key) || { key: r.key, n: 0, secs: 0, pilots: new Set() };
      o.n += r.n; o.secs += r.secs; o.pilots.add(r.uid); m.set(r.key, o);
    }
    return [...m.values()].map(o => ({ key: o.key, n: o.n, secs: o.secs, pilots: o.pilots.size }));
  };
  const tabs = agg('tab').sort((a, b) => b.secs - a.secs || b.n - a.n);
  const feats = agg('feat').sort((a, b) => b.pilots - a.pilots || b.n - a.n);
  const exits = agg('exit').sort((a, b) => b.n - a.n);
  const flow = Object.fromEntries(agg('flow').map(o => [o.key, { n: o.n, pilots: o.pilots }]));
  const sess = use.filter(r => r.kind === 'sess');
  const sessions = sess.reduce((t, r) => t + r.n, 0), secs = sess.reduce((t, r) => t + r.secs, 0);

  // Verlauf pro Tag: wie viele Piloten, wie viele Minuten
  const dayMap = new Map();
  for (const r of sess) {
    const d = dayMap.get(r.day) || { day: r.day, pilots: new Set(), secs: 0 };
    d.pilots.add(r.uid); d.secs += r.secs; dayMap.set(r.day, d);
  }
  const daily = [];
  if (from && today) {
    for (let t = Date.parse(from + 'T12:00:00Z'); t <= Date.parse(today + 'T12:00:00Z'); t += 86400000) {
      const k = new Date(t).toISOString().slice(0, 10), d = dayMap.get(k);
      daily.push({ day: k, pilots: d ? d.pilots.size : 0, mins: d ? Math.round(d.secs / 60) : 0 });
    }
  }

  // Pro Pilot: Tage, Besuche, Zeit, Lieblingsreiter und -funktionen
  const per = new Map();
  for (const r of use) {
    const p = per.get(r.uid) || { uid: r.uid, name: names[r.uid], days: new Set(), sessions: 0, secs: 0, tabs: {}, feats: {}, last: '' };
    p.days.add(r.day); if (r.day > p.last) p.last = r.day;
    if (r.kind === 'sess') { p.sessions += r.n; p.secs += r.secs; }
    if (r.kind === 'tab') p.tabs[r.key] = (p.tabs[r.key] || 0) + r.secs;
    if (r.kind === 'feat') p.feats[r.key] = (p.feats[r.key] || 0) + r.n;
    per.set(r.uid, p);
  }
  const top = (o, k) => Object.entries(o).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, k).map(([key, v]) => ({ key, v }));
  const pilots = [...per.values()].map(p => ({ uid: p.uid, name: p.name, days: p.days.size, sessions: p.sessions, mins: Math.round(p.secs / 60), last: p.last, tabs: top(p.tabs, 3), feats: top(p.feats, 4) }))
    .sort((a, b) => b.days - a.days || b.mins - a.mins);

  // Abgesprungen: hat AFC schon genutzt, aber seit mindestens 7 Tagen nicht mehr
  const dropped = [];
  if (today) {
    const lim = new Date(Date.parse(today + 'T12:00:00Z') - 7 * 86400000).toISOString().slice(0, 10);
    for (const u of users) {
      if (!withAdmin && admins.has(u.id)) continue;
      const ds = (activeDays.get(u.id) || []).slice().sort();
      if (!ds.length) { dropped.push({ uid: u.id, name: u.name, last: null, days: 0 }); continue; }
      const last = ds.at(-1);
      if (last < lim) dropped.push({ uid: u.id, name: u.name, last, days: ds.length });
    }
    dropped.sort((a, b) => String(b.last || '').localeCompare(String(a.last || '')));
  }

  return { pilots: per.size, sessions, mins: Math.round(secs / 60), avgMin: sessions ? Math.round(secs / sessions / 6) / 10 : 0, tabs, feats, exits, flow, daily, perPilot: pilots, dropped };
}
