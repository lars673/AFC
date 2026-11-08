// Luftfahrthindernisse des BAZL (Kabel, Seilbahnen, Masten, Krane, Windräder …).
// Quelle: data.geo.admin.ch, Datensatz ch.bazl.luftfahrthindernis, Datei luftfahrthindernis_4326.kmz
// (frei nutzbar mit Quellenangabe «BAZL»). Das BAZL stellt die Daten täglich ab 04 Uhr neu bereit.
// Ohne Zusatzpakete: ZIP lesen mit node:zlib, KML mit regulären Ausdrücken.
import zlib from 'node:zlib';

/** Erste Datei im ZIP, deren Name auf das Muster passt, als Buffer (null = keine). */
export function unzipFirst(buf, re = /\.kml$/i) { return unzipAll(buf, re, 1)[0] || null; }
/** Alle passenden Dateien im ZIP als Buffer. */
export function unzipAll(buf, re = /\.kml$/i, max = 50) {
  const found = [];
  for (const ent of zipEntries(Buffer.from(buf), re)) {
    if (ent.method === 0) found.push(Buffer.from(ent.data));
    else if (ent.method === 8) found.push(zlib.inflateRawSync(ent.data));
    else throw new Error('ZIP-Verfahren ' + ent.method + ' nicht unterstützt');
    if (found.length >= max) break;
  }
  return found;
}
/** Einträge im ZIP, deren Name passt: {name, method, data (noch gepackt)}. */
function* zipEntries(buf, re) {
  // Ende des zentralen Verzeichnisses suchen (höchstens 64 KB Kommentar)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('keine ZIP-Datei');
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP-Verzeichnis beschädigt');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nl).toString('utf8');
    p += 46 + nl + el + cl;
    if (!re.test(name)) continue;
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    yield { name, method, data: buf.subarray(start, start + csize) };
  }
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const unent = s => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m));
const text = s => unent(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const normKey = k => text(k).toLowerCase().replace(/[^a-zäöü0-9]+/g, '');
const coords = s => text(s).split(/\s+/).map(c => c.split(',').map(Number)).filter(c => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])).map(([lon, lat, z]) => [lat, lon, Number.isFinite(z) ? z : null]);

/** Merkmale eines Placemarks: ExtendedData (Data/SimpleData) und Tabellen oder «Schlüssel: Wert» in der Beschreibung. */
function attrsOf(pm) {
  const a = {};
  for (const m of pm.matchAll(/<(?:\w+:)?SimpleData\s+name="([^"]+)"[^>/]*>([\s\S]*?)<\/(?:\w+:)?SimpleData>/g)) a[normKey(m[1])] = text(m[2]);
  for (const m of pm.matchAll(/<(?:\w+:)?Data\s+name="([^"]+)"[^>/]*>([\s\S]*?)<\/(?:\w+:)?Data>/g)) {
    const v = m[2].match(/<(?:\w+:)?value>([\s\S]*?)<\/(?:\w+:)?value>/);
    a[normKey(m[1])] = text(v ? v[1] : m[2]);
  }
  const d = pm.match(/<description>([\s\S]*?)<\/description>/);
  if (d) {
    const html = unent(d[1]);
    for (const r of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const c = [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x => text(x[1]));
      if (c.length >= 2 && c[0]) a[normKey(c[0])] ??= c[1];
    }
    for (const line of html.split(/<br\s*\/?>|\n/i)) {
      const m = text(line).match(/^([^:]{2,40}):\s*(.+)$/);
      if (m) a[normKey(m[1])] ??= m[2];
    }
  }
  return a;
}
const pick = (a, ...res) => { for (const re of res) for (const [k, v] of Object.entries(a)) if (re.test(k) && v !== '' && v != null) return v; return null; };
const numOf = v => { const m = String(v ?? '').replace(',', '.').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };

/** Art des Hindernisses: 'rope' Seilbahn/Skilift, 'wire' Kabel/Leitung, 'pt' Mast, Kran, Antenne usw. */
export function obstacleKind(type, isLine) {
  const t = String(type || '').toLowerCase();
  if (!isLine) return 'pt';
  if (/seilbahn|bahn|lift|ropeway|cable.?car|cableway|gondel|gondola|sessel|chair|télé|tele|funi|skilift|materialseil|transport/.test(t)) return 'rope';
  if (/kabel|seil|leitung|line|wire|cable|catenary|fahrleitung|strom|power|hochspann|freileitung|ligne/.test(t)) return 'wire';
  return 'wire';
}

const r5 = v => Math.round(v * 1e5) / 1e5;
/** Deutsche Namen für die Codes des BAZL-Datensatzes (Typ, Markierung, Befeuerung). */
const TYPE_DE = { TRANSMISSION_LINE: 'Stromleitung', CABLE_CAR: 'Seilbahn', CATENARY: 'Kabel oder Fahrleitung', POLE: 'Mast', BUILDING: 'Gebäude', CRANE: 'Kran',
  VEGETATION: 'Baum oder Wald', STACK: 'Kamin', BRIDGE: 'Brücke', WINDMILL: 'Windrad', ANTENNA: 'Antenne', TOWER: 'Turm', MAST: 'Mast', CHIMNEY: 'Kamin', WIND_TURBINE: 'Windrad', OTHER: 'Hindernis' };
const MARK_DE = { NONE: 'keine', MARKED: 'markiert', ORANGE_MARKS: 'orange Markierungen', RED_WHITE: 'rot-weiss', BALLS: 'Kugeln', FLAGS: 'Fahnen' };
const LIGHT_DE = { NONE: 'keine', LIGHTED: 'befeuert', LIT: 'befeuert', DAY: 'tags befeuert', NIGHT: 'nachts befeuert', DAY_NIGHT: 'Tag und Nacht befeuert' };
const deCode = (map, v) => { if (v == null || v === '') return null; const o = String(v).trim(), k = o.toUpperCase(); return map[k] ?? (/^[A-Z_]+$/.test(o) ? o.toLowerCase().replace(/_/g, ' ') : o); };
// Masten von Leitungen und Seilbahnen sind als eigene Punkte erfasst; die Leitung selbst ist schon da, die Masten
// würden nur die Karte füllen (fast 110 000 Stück). Deshalb bleiben bei diesen Typen nur die Linien.
// Eigene Kopie eines kurzen Textes: Teilstücke würden sonst den ganzen grossen KML-Block im Speicher halten.
const own = v => (v == null ? v : Buffer.from(String(v), 'utf8').toString('utf8'));
const LINE_TYPES = /^(TRANSMISSION_LINE|CABLE_CAR|CATENARY)$/i;

/** Ein Placemark (Namensraum-Präfixe wie «kml:» schon entfernt) in einen Eintrag umwandeln, null = auslassen. */
function parsePlacemark(pm, box) {
  const lines = [...pm.matchAll(/<(?:LineString|LinearRing)\b[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g)].map(m => coords(m[1])).filter(c => c.length >= 2);
  const a = attrsOf(pm);
  const name = text(pm.match(/<name>([\s\S]*?)<\/name>/)?.[1] || '');
  const type = pick(a, /^obstacletype$/, /hindernistyp|obstacletyp|typ|type|art/) || '';
  if (!lines.length && LINE_TYPES.test(type)) return null;
  const pts = lines.length ? [] : [...pm.matchAll(/<Point\b[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g)].map(m => coords(m[1])[0]).filter(Boolean);
  if (!lines.length && !pts.length) return null;
  const h = numOf(pick(a, /^maxheightagl$/, /heightagl|höheübergrund|hoeheuebergrund|überboden|agl|^height$|^höhe$/));
  const top = numOf(pick(a, /^topelevationamsl$/, /elevationamsl|amsl|elevation|ümeer|uem|meereshöhe|gesamthöhe/));
  const it = {
    id: own(pick(a, /^registrationnumber$/, /registr|regnr|nummer|^id$/) || name || null),
    t: own(deCode(TYPE_DE, type)),
    k: obstacleKind(type || name, lines.length > 0),
    h: h != null ? Math.round(h) : null,
    top: top != null ? Math.round(top) : null,
    m: own(deCode(MARK_DE, pick(a, /^marking$/, /markier/))),
    l: own(deCode(LIGHT_DE, pick(a, /^lighting$/, /befeuer|beleucht|light/))),
    grp: own(pick(a, /^group$/, /gruppe/) || null),
    g: (lines.length ? lines : pts.map(p => [p])).map(seg => seg.map(([la, lo]) => [r5(la), r5(lo)]))
  };
  let s = 90, w = 180, n = -90, e = -180;
  for (const seg of it.g) for (const [la, lo] of seg) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
  it.b = [s, w, n, e];
  if (box && (n < box[0] || s > box[2] || e < box[1] || w > box[3])) return null;
  // Länge der Leitung (m) für die Anzeige
  if (lines.length) { let L = 0; for (const seg of it.g) for (let i = 1; i < seg.length; i++) L += distM(seg[i - 1], seg[i]); it.len = Math.round(L); }
  return it;
}
/** Das BAZL erfasst jede Spannweite einer Leitung einzeln (Nummer «…_0001», «…_0002»). Spannweiten mit derselben
 *  Grundnummer und Art werden zu einem Hindernis zusammengelegt: höchster Punkt über Grund, Länge zusammengezählt,
 *  aneinanderstossende Stücke als eine Linie. Das spart viel Speicher und die Karte zeigt eine Leitung als Ganzes. */
function mergeSpans(items) {
  const out = [], by = new Map();
  for (const it of items) {
    const base = it.k !== 'pt' && it.id && /_\d+$/.test(it.id) ? it.id.replace(/_\d+$/, '') : null;
    const key = base && base + '|' + it.k + '|' + (it.t || '');
    const m = key && by.get(key);
    if (!m) { if (key) { it.id = base; by.set(key, it); } out.push(it); continue; }
    for (const seg of it.g) {
      const last = m.g[m.g.length - 1], end = last[last.length - 1];
      if (end[0] === seg[0][0] && end[1] === seg[0][1]) last.push(...seg.slice(1)); else m.g.push(seg);
    }
    if (it.h != null && (m.h == null || it.h > m.h)) m.h = it.h;
    if (it.top != null && (m.top == null || it.top > m.top)) m.top = it.top;
    m.len = (m.len || 0) + (it.len || 0);
    m.b = [Math.min(m.b[0], it.b[0]), Math.min(m.b[1], it.b[1]), Math.max(m.b[2], it.b[2]), Math.max(m.b[3], it.b[3])];
  }
  return out;
}
const PM_RE = /<(?:[\w-]+:)?Placemark\b[\s\S]*?<\/(?:[\w-]+:)?Placemark>/g;
const stripNs = s => s.replace(/<(\/?)[\w-]+:/g, '<$1');

/** KML-Text in eine kompakte Liste: {id, t (Typ), k (Art), h (m über Grund), top (m ü. M.), m (Markierung), l (Befeuerung), g ([[lat,lon],…] oder [[lat,lon]]), b (Ausdehnung)}.
 *  Versteht KML mit und ohne Namensraum-Präfix (das BAZL schreibt <kml:Placemark>). */
export function parseObstacleKml(kml, box = null) {
  const out = [];
  for (const m of String(kml).matchAll(PM_RE)) { const it = parsePlacemark(stripNs(m[0]), box); if (it) out.push(it); }
  return mergeSpans(out);
}

/** Hindernisse direkt aus der KMZ-Datei, Stück für Stück entpackt. Die BAZL-Datei ist entpackt über 400 MB gross;
 *  so muss sie nie ganz im Speicher liegen. */
/** Ende (Index nach «>») des letzten schliessenden Placemark-Tags im Text, -1 = keiner. */
function lastClose(t) {
  for (let i = t.lastIndexOf('Placemark>'); i > 0; i = t.lastIndexOf('Placemark>', i - 1)) {
    if (/<\/(?:[\w-]+:)?$/.test(t.slice(Math.max(0, i - 40), i))) return i + 10;
  }
  return -1;
}
/** Enthält das ZIP eine passende Datei? (ohne sie zu entpacken) */
export function zipHas(buf, re = /\.kml$/i) { for (const _ of zipEntries(Buffer.from(buf), re)) return true; return false; }

export async function parseObstacleKmz(buf, box = null) {
  buf = Buffer.from(buf);
  const out = [];
  for (const ent of zipEntries(buf, /\.kml$/i)) {
    const parseText = t => { for (const m of t.matchAll(PM_RE)) { const it = parsePlacemark(stripNs(m[0]), box); if (it) out.push(it); } };
    if (ent.method === 0) { parseText(ent.data.toString('utf8')); continue; }
    if (ent.method !== 8) throw new Error('ZIP-Verfahren ' + ent.method + ' nicht unterstützt');
    await new Promise((resolve, reject) => {
      const z = zlib.createInflateRaw(), dec = new TextDecoder('utf-8');
      let rest = '';
      z.on('data', chunk => {
        rest += dec.decode(chunk, { stream: true });
        const end = lastClose(rest);
        if (end < 0) { if (rest.length > 50e6) { z.destroy(); reject(new Error('KML-Eintrag zu gross')); } return; }
        parseText(rest.slice(0, end)); rest = rest.slice(end);
      });
      z.on('end', () => { parseText(rest + dec.decode()); resolve(); });
      z.on('error', reject);
      z.end(ent.data);
    });
  }
  return mergeSpans(out);
}

export function distM(a, b) {
  const R = 6371000, f1 = a[0] * Math.PI / 180, f2 = b[0] * Math.PI / 180, df = f2 - f1, dl = (b[1] - a[1]) * Math.PI / 180;
  const x = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
/** Kürzester Abstand (m) eines Punktes zu einem Hindernis (Linie oder Punkt), lokal eben gerechnet. */
export function distToObstacle(lat, lon, it) {
  const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
  const xy = p => [(p[1] - lon) * kx, (p[0] - lat) * ky];
  let best = Infinity;
  for (const seg of it.g) {
    if (seg.length === 1) { const [x, y] = xy(seg[0]); best = Math.min(best, Math.hypot(x, y)); continue; }
    for (let i = 1; i < seg.length; i++) {
      const [x1, y1] = xy(seg[i - 1]), [x2, y2] = xy(seg[i]), dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(x1 + t * dx, y1 + t * dy));
    }
  }
  return best;
}

/** Einfacher Rasterindex (0,05°) für schnelle Abfragen nach Kartenausschnitt. */
export function indexObstacles(items) {
  const cell = 0.05, idx = new Map();
  items.forEach((it, i) => {
    for (let a = Math.floor(it.b[0] / cell); a <= Math.floor(it.b[2] / cell); a++) for (let o = Math.floor(it.b[1] / cell); o <= Math.floor(it.b[3] / cell); o++) {
      const k = a + ':' + o; let l = idx.get(k); if (!l) idx.set(k, (l = [])); l.push(i);
    }
  });
  return { items, idx, cell };
}
export function obstaclesInBox(I, s, w, n, e, limit = 4000) {
  const seen = new Set(), out = [];
  for (let a = Math.floor(s / I.cell); a <= Math.floor(n / I.cell); a++) for (let o = Math.floor(w / I.cell); o <= Math.floor(e / I.cell); o++) {
    for (const i of I.idx.get(a + ':' + o) || []) {
      if (seen.has(i)) continue; seen.add(i);
      const it = I.items[i];
      if (it.b[2] < s || it.b[0] > n || it.b[3] < w || it.b[1] > e) continue;
      out.push(it);
    }
  }
  // Kabel und Seilbahnen zuerst (für Gleitschirme am gefährlichsten), dann hohe Punkte
  out.sort((x, y) => (x.k === 'pt') - (y.k === 'pt') || (y.h ?? 0) - (x.h ?? 0));
  return { items: out.slice(0, limit), more: out.length > limit };
}
/** Hindernisse im Umkreis (m) eines Punktes, nächste zuerst, mit Abstand und Richtung. */
export function obstaclesNear(I, lat, lon, radiusM = 1500, limit = 8) {
  const dLat = radiusM / 110540, dLon = radiusM / (111320 * Math.cos(lat * Math.PI / 180));
  const { items } = obstaclesInBox(I, lat - dLat, lon - dLon, lat + dLat, lon + dLon, 1e9);
  return items.map(it => ({ it, d: distToObstacle(lat, lon, it) })).filter(x => x.d <= radiusM).sort((a, b) => a.d - b.d).slice(0, limit)
    .map(({ it, d }) => {
      const all = it.g.flat(), c = all.reduce((m, p) => (distM([lat, lon], p) < distM([lat, lon], m) ? p : m), all[0]);
      const deg = (Math.atan2((c[1] - lon) * Math.cos(lat * Math.PI / 180), c[0] - lat) * 180 / Math.PI + 360) % 360;
      return { ...it, d: Math.round(d), deg: Math.round(deg) };
    });
}
