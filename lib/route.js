// XC-Routenplaner: kürzeste Flugzeit von A nach B über ein Raster (ca. 500 m) mit der Flughöhe als Zustand:
// Gleiten kostet Höhe, Thermik bringt sie zurück. Gewichtet nach Thermik, Abstand zum Gelände, Wind auf
// Flughöhe und erreichbaren Landeplätzen.
// Läuft im Browser (als /route.js) und in den Tests.

const D2R = Math.PI / 180;
const isNum = v => typeof v === 'number' && Number.isFinite(v);

export const ROUTE_MODES = {
  safe: { label: 'Sicher', weak: 2.5, noLanding: 1.5, lowClear: 1.0 },
  fast: { label: 'Schnell', weak: 1.0, noLanding: 0.3, lowClear: 0.3 }
};

/**
 * field: { la0, lo0, dla, dlo, nx, ny, q, top, ground, u, v, wstar, needH } – Arrays je Zelle (Zeile von Süden):
 *   q Thermikgüte 0–1, top Thermikobergrenze m, ground höchstes Gelände m, u/v Wind km/h (wohin), wstar m/s,
 *   needH Mindesthöhe m, um von hier einen Landeplatz zu erreichen (Infinity = keiner)
 * opts.startAlt: Höhe beim Start (Startplatz); ohne Angabe das Gelände bei A.
 * Gerechnet wird mit der Flughöhe: im Gleitflug sinkt man (Gleitzahl), in brauchbarer Thermik steigt man bis zur
 * Obergrenze. Damit geht auch ein reiner Gleitflug ohne Thermik, solange die Höhe reicht.
 * -> { ok, path:[[lat,lon]...], cells, heights, distKm, hours, avgKmh, climbs, issues:[{ kind, text, at }] }
 */
export function planRoute(field, from, to, { mode = 'safe', airspeed = 36, startAlt = null, glide = 7, later = [] } = {}) {
  // later: Felder für die folgenden Stunden (gleiches Raster); das Wetter ändert sich während des Flugs mit
  const M = ROUTE_MODES[mode] || ROUTE_MODES.safe, hourly = [field, ...later];
  let F = field;
  const use = t => (F = hourly[Math.min(hourly.length - 1, Math.max(0, Math.floor(t)))]);
  const cellOf = p => {
    const x = Math.round((p[1] - F.lo0) / F.dlo), y = Math.round((p[0] - F.la0) / F.dla);
    return x < 0 || y < 0 || x >= F.nx || y >= F.ny ? -1 : y * F.nx + x;
  };
  const start = cellOf(from), goal = cellOf(to);
  if (start < 0 || goal < 0) return { ok: false, reason: 'Punkt ausserhalb des Gebiets' };
  const N = F.nx * F.ny;
  const kmY = F.dla * 111.32, kmX = lat => F.dlo * 111.32 * Math.cos(lat * D2R);
  const latOf = k => F.la0 + Math.floor(k / F.nx) * F.dla, lonOf = k => F.lo0 + (k % F.nx) * F.dlo;
  const top = k => (isNum(F.top[k]) ? F.top[k] : -Infinity);
  const lift = k => (F.q[k] || 0) >= 0.3 && (F.wstar[k] || 0) >= 0.8;   // hier kann man kurbeln
  const climbRate = k => Math.max(0.5, (F.wstar[k] || 0) * 0.6);          // m/s im Schnitt
  const MIN_AGL = mode === 'safe' ? 200 : 120;                             // Mindestabstand zum Gelände im Gleitflug
  const h0 = isNum(startAlt) ? startAlt : F.ground[start];

  function step(a, b, h, t) {
    use(t);
    const ya = Math.floor(a / F.nx), yb = Math.floor(b / F.nx), lat = (latOf(a) + latOf(b)) / 2;
    const dx = ((b % F.nx) - (a % F.nx)) * kmX(lat), dy = (yb - ya) * kmY, dist = Math.hypot(dx, dy);
    const ux = dx / dist, uy = dy / dist;
    const wu = ((F.u[a] || 0) + (F.u[b] || 0)) / 2, wv = ((F.v[a] || 0) + (F.v[b] || 0)) / 2;
    const along = wu * ux + wv * uy, cross = wu * -uy + wv * ux;
    if (Math.abs(cross) >= airspeed * 0.9) return null;
    const gs = Math.sqrt(airspeed * airspeed - cross * cross) + along;
    if (gs < 8) return null;                                    // Gegenwind zu stark
    // Sinken im Gleitflug: Gleitzahl gegenüber Luft, Wind verlängert oder verkürzt den Weg über Grund
    let h2 = h - dist * 1000 / (glide * gs / airspeed);
    // Am Startplatz selbst (erster Kilometer) liegt man noch nah am Hang, das ist normal
    const nearStart = Math.hypot(((b % F.nx) - (start % F.nx)) * kmX(lat), (yb - Math.floor(start / F.nx)) * kmY) <= 1;
    if (b !== goal && h2 - F.ground[b] < (nearStart ? -50 : MIN_AGL)) return null;
    if (b === goal && h2 < F.ground[b]) return null;
    const q = Math.min(F.q[a] || 0, F.q[b] || 0);
    const variant = (h, climb) => {
      const landOk = h >= (F.needH?.[b] ?? Infinity);
      // Tief über Grund ist nur heikel, wenn kein Landeplatz mehr erreichbar ist (der Endanflug ist immer tief)
      const pen = 1 + M.weak * (1 - q) * 0.5 + (landOk ? 0 : M.noLanding + (h - F.ground[b] < 500 ? M.lowClear : 0));
      return { dist, gs, h, climb, cost: dist / gs * pen + climb };
    };
    // Durchgleiten oder in der Thermik aufdrehen: beide Möglichkeiten weiterverfolgen
    const out = [variant(h2, 0)];
    if (lift(b) && top(b) > h2 + 100) out.push(variant(top(b), (top(b) - h2) / climbRate(b) / 3600));
    return out;
  }

  // Dijkstra über (Zelle, Höhe): je Zelle zählt die schnellste Ankunft, eine deutlich höhere Ankunft bleibt zusätzlich im Rennen
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]];
  const bestC = new Float64Array(N).fill(Infinity), bestH = new Float64Array(N).fill(-Infinity);
  const labels = [];          // [cost, cell, height, parentLabel, dist, time, climb]
  const heap = [];
  const push = (l) => { heap.push(l); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (labels[heap[p]][0] <= labels[heap[i]][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const t = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && labels[heap[l]][0] < labels[heap[m]][0]) m = l; if (r < heap.length && labels[heap[r]][0] < labels[heap[m]][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return t; };
  const add = (c, k, h, parent, e) => {
    if (!(c < bestC[k] || h > bestH[k] + 150)) return;
    if (c < bestC[k]) bestC[k] = c;
    if (h > bestH[k]) bestH[k] = h;
    const t = (parent >= 0 ? labels[parent][8] : 0) + (e ? e.dist / e.gs + (e.climb || 0) : 0);   // Flugzeit seit Start in h
    labels.push([c, k, h, parent, e?.dist || 0, e ? e.dist / e.gs : 0, e?.climb || 0, e?.gs || null, t]);
    push(labels.length - 1);
  };
  // Direkt losgleiten oder zuerst am Start aufdrehen: beide Varianten bleiben im Rennen
  add(0, start, h0, -1, null);
  if (lift(start) && top(start) > h0 + 100) add((top(start) - h0) / climbRate(start) / 3600, start, top(start), -1, { dist: 0, gs: 1, climb: (top(start) - h0) / climbRate(start) / 3600 });
  let found = -1, budget = 400000;
  while (heap.length && budget-- > 0) {
    const li = pop(), [c, k, h, , , , , , t] = labels[li];
    if (k === goal) { found = li; break; }
    if (c > bestC[k] && h <= bestH[k] - 150) continue;
    const x = k % F.nx, y = Math.floor(k / F.nx);
    for (const [dx, dy] of NB) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= F.nx || ny >= F.ny) continue;
      const j = ny * F.nx + nx;
      // Sprünge über zwei Zellen: auch die überflogene Zelle muss unter der Flughöhe liegen
      if (Math.abs(dx) === 2 || Math.abs(dy) === 2) { const m = (y + Math.round(dy / 2)) * F.nx + x + Math.round(dx / 2); if (F.ground[m] > h - 100) continue; }
      const es = step(k, j, h, t);
      if (es) for (const e of es) add(c + e.cost, j, e.h, li, e);
    }
  }
  if (found < 0) return { ok: false, reason: 'Keine fliegbare Route: Die Höhe reicht nicht, die Thermik ist zu schwach oder zu tief, oder der Gegenwind ist zu stark' };

  const chain = [];
  for (let l = found; l !== -1; l = labels[l][3]) chain.unshift(labels[l]);
  const cells = chain.map(l => l[1]), heights = chain.map(l => Math.round(l[2]));
  let distKm = 0, hours = chain[0][6] || 0, climbs = chain[0][6] > 0 ? 1 : 0;
  const segs = [];
  for (let i = 1; i < chain.length; i++) {
    const [, k, h, , dist, time, climb, gs, t] = chain[i];
    distKm += dist; hours += time + climb;
    if (climb > 0) climbs++;
    segs.push({ k, dist, gs, h, glide: climb === 0, F: hourly[Math.min(hourly.length - 1, Math.floor(t - time - climb))] });
  }

  const issues = [];
  const at = k => [latOf(k), lonOf(k)];
  const run = (test, minKm, make) => {
    let len = 0, first = null, worst = null;
    const flush = () => { if (len >= minKm) issues.push(make(len, first, worst)); len = 0; first = null; worst = null; };
    for (const s of segs) { if (test(s)) { len += s.dist; first ??= s; worst = !worst || s.h - F.ground[s.k] < worst.h - F.ground[worst.k] ? s : worst; } else flush(); }
    flush();
  };
  const lifts = (s2) => (s2.F.q[s2.k] || 0) >= 0.3 && (s2.F.wstar[s2.k] || 0) >= 0.8;
  const pureGlide = climbs === 0;   // reiner Gleitflug: dann ist «ohne Thermik» kein Warnsignal
  run(s => !pureGlide && s.glide && !lifts(s), 3, (len, s) => ({ kind: 'weak', at: at(s.k), text: `${Math.round(len)} km Gleitflug ohne brauchbare Thermik: mit voller Höhe einsteigen` }));
  run(s => s.k !== goal && s.h - F.ground[s.k] < 500 && s.h < (s.F.needH?.[s.k] ?? Infinity), 1, (len, s, w) => ({ kind: 'low', at: at(w.k), text: `nur ca. ${Math.round((w.h - F.ground[w.k]) / 50) * 50} m über dem Gelände: knapp, mit Reserve anfliegen` }));
  run(s => s.gs < 22, 3, (len, s) => ({ kind: 'head', at: at(s.k), text: `${Math.round(len)} km mit Gegenwind (über Grund ca. ${Math.round(s.gs)} km/h)` }));
  run(s => s.k !== goal && s.h < (s.F.needH?.[s.k] ?? Infinity), 2, (len, s) => ({ kind: 'land', at: at(s.k), text: `${Math.round(len)} km ohne bekannten Landeplatz im Gleitbereich` }));
  const arrive = heights[heights.length - 1] - F.ground[goal];

  return {
    ok: true, mode, cells, heights, path: cells.map(at), distKm: Math.round(distKm * 10) / 10, climbs,
    arriveAgl: Math.round(arrive), hours: Math.round(hours * 10) / 10, avgKmh: hours > 0 ? Math.round(distKm / hours) : null, issues
  };
}

if (typeof window !== 'undefined') window.AFCRoute = { planRoute, ROUTE_MODES };
