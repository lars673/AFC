// XC-Routenplaner: kürzeste Flugzeit von A nach B über ein Raster (ca. 1 km), gewichtet nach Thermik,
// Arbeitshöhe über dem Gelände, Wind auf Flughöhe und erreichbaren Landeplätzen.
// Läuft im Browser (als /route.js) und in den Tests.

const D2R = Math.PI / 180;
const isNum = v => typeof v === 'number' && Number.isFinite(v);

export const ROUTE_MODES = {
  safe: { label: 'Sicher', weak: 2.5, noLanding: 1.5, lowClear: 1.0, minClear: 400 },
  fast: { label: 'Schnell', weak: 1.0, noLanding: 0.3, lowClear: 0.3, minClear: 250 }
};

/**
 * field: { la0, lo0, dla, dlo, nx, ny, q, top, ground, u, v, wstar, land } – Arrays je Zelle (Zeile von Süden):
 *   q Thermikgüte 0–1, top Thermikobergrenze m, ground höchstes Gelände m, u/v Wind km/h (wohin), wstar m/s,
 *   land 1 = Landeplatz im Gleitbereich, 0 = keiner
 * -> { ok, path:[[lat,lon]...], cells:[k...], distKm, hours, avgKmh, issues:[{ kind, text, at:[lat,lon] }] }
 */
export function planRoute(field, from, to, { mode = 'safe', airspeed = 36 } = {}) {
  const M = ROUTE_MODES[mode] || ROUTE_MODES.safe, F = field;
  const cellOf = p => {
    const x = Math.round((p[1] - F.lo0) / F.dlo), y = Math.round((p[0] - F.la0) / F.dla);
    return x < 0 || y < 0 || x >= F.nx || y >= F.ny ? -1 : y * F.nx + x;
  };
  const start = cellOf(from), goal = cellOf(to);
  if (start < 0 || goal < 0) return { ok: false, reason: 'Punkt ausserhalb des Gebiets' };
  const N = F.nx * F.ny;
  const kmY = F.dla * 111.32, kmX = lat => F.dlo * 111.32 * Math.cos(lat * D2R);
  const latOf = k => F.la0 + Math.floor(k / F.nx) * F.dla, lonOf = k => F.lo0 + (k % F.nx) * F.dlo;
  const clear = k => (isNum(F.top[k]) && isNum(F.ground[k]) ? F.top[k] - F.ground[k] : -Infinity);
  // Start- und Zielzelle dürfen knapp sein (Startplatz, Landeplatz)
  const passable = k => k === start || k === goal || clear(k) >= M.minClear;

  function edge(a, b) {
    const ya = Math.floor(a / F.nx), yb = Math.floor(b / F.nx), lat = (latOf(a) + latOf(b)) / 2;
    const dx = ((b % F.nx) - (a % F.nx)) * kmX(lat), dy = (yb - ya) * kmY, dist = Math.hypot(dx, dy);
    const ux = dx / dist, uy = dy / dist;
    const wu = ((F.u[a] || 0) + (F.u[b] || 0)) / 2, wv = ((F.v[a] || 0) + (F.v[b] || 0)) / 2;
    const along = wu * ux + wv * uy, cross = wu * -uy + wv * ux;
    if (Math.abs(cross) >= airspeed * 0.9) return null;
    const gs = Math.sqrt(airspeed * airspeed - cross * cross) + along;
    if (gs < 8) return null;                                   // Gegenwind zu stark
    const q = Math.min(F.q[a] || 0, F.q[b] || 0), c = Math.min(clear(a), clear(b));
    const pen = 1 + M.weak * (1 - q) + (F.land[b] ? 0 : M.noLanding) + (c < 700 ? M.lowClear : 0);
    return { dist, gs, cost: dist / gs * pen };
  }

  // Dijkstra mit binärem Heap, 16 Nachbarn für weichere Linien
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]];
  const cost = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const heap = [];
  const push = (k, c) => { heap.push([c, k]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  cost[start] = 0; push(start, 0);
  while (heap.length) {
    const [c, k] = pop();
    if (done[k]) continue;
    done[k] = 1;
    if (k === goal) break;
    const x = k % F.nx, y = Math.floor(k / F.nx);
    for (const [dx, dy] of NB) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= F.nx || ny >= F.ny) continue;
      const j = ny * F.nx + nx;
      if (done[j] || !passable(j)) continue;
      // Sprünge über zwei Zellen: die überflogene Zelle muss auch passierbar sein
      if (Math.abs(dx) === 2 || Math.abs(dy) === 2) { const m = (y + Math.round(dy / 2)) * F.nx + x + Math.round(dx / 2); if (!passable(m)) continue; }
      const e = edge(k, j);
      if (!e) continue;
      if (c + e.cost < cost[j]) { cost[j] = c + e.cost; prev[j] = k; push(j, cost[j]); }
    }
  }
  if (!done[goal]) return { ok: false, reason: 'Keine fliegbare Route: Thermik zu tief über dem Gelände oder Gegenwind zu stark' };

  const cells = [];
  for (let k = goal; k !== -1; k = prev[k]) cells.unshift(k);
  let distKm = 0, hours = 0;
  const segs = [];
  for (let i = 1; i < cells.length; i++) {
    const e = edge(cells[i - 1], cells[i]);
    distKm += e.dist;
    // Reisegeschwindigkeit inkl. Kurbeln: bei 1 m/s etwa 40 %, bei 3 m/s etwa 65 % der Gleitgeschwindigkeit
    const ws = Math.max(0.5, (F.wstar[cells[i]] || 0));
    const xc = e.gs * Math.min(0.7, 0.3 + 0.12 * ws);
    hours += e.dist / xc;
    segs.push({ k: cells[i], dist: e.dist, gs: e.gs });
  }

  // Kritische Stellen zusammenfassen
  const issues = [];
  const run = (test, minKm, make) => {
    let len = 0, first = null;
    const flush = () => { if (len >= minKm) issues.push(make(len, first)); len = 0; first = null; };
    for (const s of segs) { if (test(s)) { len += s.dist; first ??= s.k; } else flush(); }
    flush();
  };
  const at = k => [latOf(k), lonOf(k)];
  run(s => (F.q[s.k] || 0) < 0.2, 3, (len, k) => ({ kind: 'weak', at: at(k), text: `${Math.round(len)} km ohne gute Thermik: mit voller Höhe einsteigen` }));
  run(s => clear(s.k) < 700, 1.5, (len, k) => ({ kind: 'low', at: at(k), text: `Gelände nur ${Math.round(clear(k) / 100) * 100} m unter der Thermikobergrenze: knapp, Krete mit Reserve anfliegen` }));
  run(s => s.gs < 22, 3, (len, k) => ({ kind: 'head', at: at(k), text: `${Math.round(len)} km mit Gegenwind (über Grund ca. ${Math.round(segs.find(s => s.k === k).gs)} km/h)` }));
  run(s => !F.land[s.k], 2, (len, k) => ({ kind: 'land', at: at(k), text: `${Math.round(len)} km ohne bekannten Landeplatz im Gleitbereich` }));

  return {
    ok: true, mode, cells, path: cells.map(at), distKm: Math.round(distKm * 10) / 10,
    hours: Math.round(hours * 10) / 10, avgKmh: hours > 0 ? Math.round(distKm / hours) : null, issues
  };
}

if (typeof window !== 'undefined') window.AFCRoute = { planRoute, ROUTE_MODES };
