// Nebelmeer gemessen (Lars, 12.11.2026): Die Stationen der MeteoSchweiz liegen auf allen Höhen von 550 bis über
// 2000 m. Feuchte und Sonne zeigen, welche im Nebel stecken, welche darunter im Grauen liegen und welche darüber
// in der Sonne. Daraus folgt die Nebelschicht (Untergrenze, Obergrenze) und ob Start oder Landeplatz drin liegen.
// Die Prognose (lib/clouds.js) sagt, wann sie sich auflöst; sieht sie den gemessenen Nebel gar nicht, bleibt AFC vorsichtig.
import { isNum, solarPosition } from './util.js';

export const FOGM = { inRh: 97, inSpread: 0.6, sunIn: 0.3, sunAbove: 0.55, rhAbove: 88, rhUnder: 75, nightAbove: 75, maxFloor: 1100, maxTop: 2400, ageMin: 40 };

/** Einstrahlung bei klarem Himmel (W/m²), grob aus dem Sonnenstand. */
export const clearSky = elev => (elev <= 0 ? 0 : 1000 * Math.pow(Math.sin(elev * Math.PI / 180), 1.15));

/** Eine Station einordnen: 'in' (im Nebel), 'under' (grau darunter), 'above' (Sonne darüber) oder null. */
export function fogClass(o, m) {
  if (!o || !m || !isNum(m.alt) || !isNum(o.rh)) return null;
  const cs = clearSky(solarPosition(Date.parse(o.time), m.lat, m.lon).elevationDeg);
  const day = cs >= 150, sunR = day && isNum(o.sun) ? o.sun / cs : null;
  const spread = isNum(o.temp) && isNum(o.dew) ? o.temp - o.dew : null;
  const wet = o.rh >= FOGM.inRh || (spread != null && spread <= FOGM.inSpread);
  if (wet && (sunR == null || sunR <= FOGM.sunIn)) return { k: 'in', sunR };
  if (day && sunR != null) {
    if (sunR >= FOGM.sunAbove && o.rh <= FOGM.rhAbove) return { k: 'above', sunR };
    if (sunR <= FOGM.sunIn && o.rh >= FOGM.rhUnder) return { k: 'under', sunR };
    return null;
  }
  if (!day && o.rh <= FOGM.nightAbove) return { k: 'above', sunR: null, night: true };
  return null;
}

/**
 * obs: { CODE: { time, rh, temp, dew, sun } }, meta: { CODE: { name, lat, lon, alt } }
 * -> { at, base, top, ground, range:[hoch im Nebel/grau, tief in der Sonne], inn, under, above } wenn eine Schicht
 *    mit Sonne darüber gemessen ist; { at, none: true } wenn genug Stationen frei sind; sonst null.
 */
export function fogFromObs(obs, meta, now = Date.now()) {
  const st = [];
  let newest = 0;
  for (const [code, o] of Object.entries(obs || {})) {
    const m = meta?.[code];
    if (!m || !isNum(m.alt)) continue;
    const t = Date.parse(o.time);
    if (!(now - t <= FOGM.ageMin * 60000)) continue;
    const c = fogClass(o, m);
    if (!c) continue;
    newest = Math.max(newest, t);
    st.push({ code, name: m.name || code, alt: m.alt, k: c.k, night: !!c.night, temp: o.temp });
  }
  if (st.length < 3) return null;
  const at = new Date(newest).toISOString();
  const In = st.filter(s => s.k === 'in'), Un = st.filter(s => s.k === 'under');
  const low = [...In, ...Un];
  if (!In.length && Un.length < 2) return st.filter(s => s.k === 'above').length >= 3 ? { at, none: true } : null;
  const floor = Math.min(...low.map(s => s.alt));
  if (floor > FOGM.maxFloor) return null;
  const ref = In.length ? Math.min(...In.map(s => s.alt)) : floor;
  // Nachts gilt eine trockene Station nur als «darüber», wenn sie wärmer ist, als es die Höhe allein erwarten liesse (Inversion)
  const lowT = low.filter(s => isNum(s.temp)).sort((a, b) => a.alt - b.alt)[0];
  const Ab = st.filter(s => s.k === 'above' && s.alt > ref + 100 && (!s.night || (lowT && isNum(s.temp) && s.temp > lowT.temp - (s.alt - lowT.alt) * 0.0045)));
  if (!Ab.length) return null;
  const loAbove = Math.min(...Ab.map(s => s.alt));
  const inB = In.filter(s => s.alt < loAbove), unB = Un.filter(s => s.alt < loAbove);
  if (!inB.length && unB.length < 2) return null;
  let top, base, ground = false;
  if (inB.length) {
    const hiIn = Math.max(...inB.map(s => s.alt)), loIn = Math.min(...inB.map(s => s.alt));
    top = Math.min(hiIn + 350, Math.max(hiIn + 60, (hiIn + loAbove) / 2));
    const below = unB.filter(s => s.alt < loIn);
    if (below.length) base = (Math.max(...below.map(s => s.alt)) + loIn) / 2;
    else { base = loIn - 50; ground = true; }
  } else {
    // nur graue Stationen darunter: die Decke liegt irgendwo zwischen der höchsten grauen und der tiefsten sonnigen
    const hiUn = Math.max(...unB.map(s => s.alt));
    top = (hiUn + loAbove) / 2; base = hiUn + 50;
  }
  top = Math.round(top / 50) * 50; base = Math.round(base / 50) * 50;
  if (top > FOGM.maxTop || top <= base) return null;
  const names = a => a.sort((x, y) => x.alt - y.alt).map(s => ({ name: s.name, alt: s.alt }));
  return { at, base, top, ground, range: [Math.max(...[...inB, ...unB].map(s => s.alt)), loAbove], inn: names(inB), under: names(unB), above: names(Ab).slice(0, 3) };
}

/**
 * Wie lange gilt die gemessene Schicht? fc: { [ms]: Obergrenze laut Prognose | null } für heute.
 * Sieht die Prognose den Nebel jetzt auch: so lange sie ihn hat, plus 1 Stunde Reserve (im November löst er sich oft
 * später auf als gerechnet). Sieht sie ihn nicht: 3 Stunden sicher, danach bis 6 Stunden als «unsicher».
 * -> { lift: ms | null (null = Prognose sieht ihn nicht), seen: bool }
 */
export function fogTimeline(f, fc, now = Date.now()) {
  if (!f?.top) return null;
  const at = Date.parse(f.at), keys = Object.keys(fc || {}).map(Number).sort((a, b) => a - b);
  const near = keys.filter(k => Math.abs(k - at) <= 90 * 60000);
  const seen = near.some(k => isNum(fc[k]));
  if (!seen) return { seen: false, lift: null, at };
  const after = keys.filter(k => k > at);
  const gone = after.find(k => !isNum(fc[k]));
  return { seen: true, lift: gone ? gone + 3600000 : null, at, until: gone ? null : after.at(-1) ?? null };
}

/** Gilt die Schicht zur Stunde ms? -> 'measured' (wie gemessen), 'unsure' (Auflösung offen) oder null. */
export function fogStateAt(tl, ms) {
  if (!tl) return null;
  const ha = (ms - tl.at) / 3600000;
  if (ha < -1.5) return null;
  if (tl.seen) return tl.lift == null || ms < tl.lift ? 'measured' : null;
  return ha <= 3 ? 'measured' : ha <= 6 ? 'unsure' : null;
}

/**
 * Liegt der Flug in der Schicht? Start in der Schicht, Landeplatz in der Schicht, oder Start darüber und Landung
 * darunter (man müsste durch den Nebel hinunter). -> { kind: 'launch'|'land'|'through'|'under', ... } oder null.
 */
export function fogConflict(f, launchAlt, landAlt) {
  if (!f?.top || !isNum(launchAlt)) return null;
  const inL = x => isNum(x) && x >= f.base - 50 && x <= f.top + 50;
  if (inL(launchAlt)) return { kind: 'launch' };
  if (isNum(landAlt) && (inL(landAlt) || (f.ground && landAlt <= f.top))) return { kind: launchAlt > f.top ? 'land' : 'launch' };
  if (isNum(landAlt) && launchAlt > f.top && landAlt < f.base) return { kind: 'through' };
  if (launchAlt < f.base) return { kind: 'under' };
  return null;
}
