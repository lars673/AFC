// Austausch unter den Piloten: Beiträge (Bericht, Treffen, Frage, Warnung) und «Heute in der Gruppe»
// aus den Flügen und «nicht gestartet»-Meldungen aller Konten. Läuft im Browser und auf dem Server.

export const POST_KINDS = {
  report: 'Bericht vom Flug',
  plan: 'Ich gehe fliegen',
  ask: 'Frage oder Tipp',
  warn: 'Achtung'
};
export const POST_MAX = 600;
const ID = /^[a-z0-9-]{1,60}$/;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);
const dateOk = d => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') && Number.isFinite(Date.parse(d)) ? d : null);

/** Beitrag prüfen. Antwort (parent) braucht nur Text. Treffen braucht ein Datum, höchstens 14 Tage voraus. */
export function cleanPost(b = {}, today = new Date().toISOString().slice(0, 10)) {
  const text = clean(b.text, POST_MAX);
  if (!text) return null;
  const parent = Number.isInteger(b.parent) && b.parent > 0 ? b.parent : null;
  if (parent) return { text, parent };
  const kind = POST_KINDS[b.kind] ? b.kind : 'report';
  let date = dateOk(b.date);
  if (kind === 'plan') {
    const max = new Date(Date.parse(today) + 14 * 86400000).toISOString().slice(0, 10);
    if (!date || date < today || date > max) date = today;
  } else if (date && date > today) date = today;
  return { text, kind, date: date || today, siteId: ID.test(b.siteId || '') ? b.siteId : null, siteName: clean(b.siteName, 80) || null, parent: null };
}

const round1 = v => Math.round(v * 10) / 10;
/**
 * Was an einem Tag an den Startplätzen los war: Flüge (Anzahl, Piloten, Sterne, weiteste Strecke, Urteile über AFC)
 * und Meldungen «nicht gestartet» mit Grund. Namen nur von Piloten, die das im Profil erlaubt haben.
 * flights: [{uid, siteId, siteName, date, rating, km, durMin, afcVerdict}], nofly: [{uid, siteId, date, reason}],
 * names: { uid: Name } nur für Piloten mit Freigabe.
 */
export function siteDay(flights = [], nofly = [], date, names = {}, siteName = id => id) {
  const by = new Map();
  const get = (id, name) => {
    if (!by.has(id)) by.set(id, { siteId: id, siteName: name || siteName(id) || id, flights: 0, pilots: new Set(), named: new Set(), ratings: [], km: 0, durMin: 0, verdicts: {}, nofly: {} });
    return by.get(id);
  };
  for (const f of flights) {
    if (f.date !== date || !f.siteId) continue;
    const x = get(f.siteId, f.siteName);
    x.flights++; x.pilots.add(f.uid);
    if (names[f.uid]) x.named.add(names[f.uid]);
    if (f.rating) x.ratings.push(f.rating);
    if (f.km > x.km) x.km = f.km;
    if (f.durMin > x.durMin) x.durMin = f.durMin;
    if (f.afcVerdict) x.verdicts[f.afcVerdict] = (x.verdicts[f.afcVerdict] || 0) + 1;
  }
  for (const r of nofly) {
    if (r.date !== date || !r.siteId) continue;
    const x = get(r.siteId);
    x.pilots.add(r.uid);
    x.nofly[r.reason || 'other'] = (x.nofly[r.reason || 'other'] || 0) + 1;
  }
  return [...by.values()].map(x => ({
    siteId: x.siteId, siteName: x.siteName, flights: x.flights, pilots: x.pilots.size, names: [...x.named].sort(),
    rating: x.ratings.length ? round1(x.ratings.reduce((a, b) => a + b, 0) / x.ratings.length) : null,
    km: x.km || null, durMin: x.durMin || null, verdicts: x.verdicts, nofly: x.nofly,
    noflyN: Object.values(x.nofly).reduce((a, b) => a + b, 0)
  })).sort((a, b) => b.flights - a.flights || (b.rating ?? 0) - (a.rating ?? 0) || b.pilots - a.pilots);
}
