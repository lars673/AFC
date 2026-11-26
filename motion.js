// AFC Motion: Wind als leuchtender Partikelstrom und Thermik als aufsteigende Glow-Säulen für die 3D-Ansicht (view3d.js).
// Die Bewegung kommt aus den Wetterdaten: Tempo und Farbe aus dem Wind, um steile Hänge gelenkt, über Graten schneller,
// hinter Graten (Lee) verwirbelt; die Thermik steigt so schnell und hell, wie sie laut Schätzung trägt, und neigt sich im Höhenwind.
// Ruhig-Modus: weniger Teilchen, kein Schein, langsamer. Läuft im Browser als window.AFCMotion.
(() => {
  'use strict';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  /* Gradientenrauschen für die Lee-Wirbel */
  const PERM = new Uint8Array(512);
  { const p = [...Array(256).keys()]; let s = 7; for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) PERM[i] = p[i & 255]; }
  const G3 = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]];
  function noise3(x, y, z) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
    x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
    const u = x * x * (3 - 2 * x), v = y * y * (3 - 2 * y), w = z * z * (3 - 2 * z);
    const g = (i, j, k, dx, dy, dz) => { const h = G3[PERM[i + PERM[j + PERM[k]]] % 12]; return h[0] * dx + h[1] * dy + h[2] * dz; };
    const a = mix(g(X, Y, Z, x, y, z), g(X + 1, Y, Z, x - 1, y, z), u), b = mix(g(X, Y + 1, Z, x, y - 1, z), g(X + 1, Y + 1, Z, x - 1, y - 1, z), u);
    const c = mix(g(X, Y, Z + 1, x, y, z - 1), g(X + 1, Y, Z + 1, x - 1, y, z - 1), u), d = mix(g(X, Y + 1, Z + 1, x, y - 1, z - 1), g(X + 1, Y + 1, Z + 1, x - 1, y - 1, z - 1), u);
    return mix(mix(a, b, v), mix(c, d, v), w);
  }

  /* Farben. Glow: cyan ruhig -> hell -> violett stark -> magenta Böen. Tag: kräftigere Töne, die auf hellem Gelände lesbar bleiben. */
  const GLOW = [[0, [0.10, 0.35, 0.95]], [8, [0.17, 0.85, 1.0]], [18, [0.55, 0.95, 1.0]], [28, [0.62, 0.45, 1.0]], [40, [0.55, 0.22, 1.0]], [55, [1.0, 0.25, 0.80]]];
  const DAY = [[0, [0.15, 0.45, 0.85]], [10, [0.10, 0.62, 0.95]], [20, [0.16, 0.70, 0.40]], [30, [0.90, 0.70, 0.05]], [40, [0.95, 0.45, 0.10]], [55, [0.88, 0.18, 0.20]]];
  // 2D-Karte: dieselben Stufen wie die Legende der Windkarte (<10 blau, 10-20 grün, 20-30 gelb, 30-40 orange, 40+ rot), weich ineinander
  const MAP = [[0, [0.16, 0.50, 0.83]], [8, [0.16, 0.50, 0.83]], [13, [0.18, 0.66, 0.31]], [18, [0.18, 0.66, 0.31]], [23, [0.85, 0.70, 0.0]], [28, [0.85, 0.70, 0.0]], [33, [0.94, 0.54, 0.12]], [38, [0.94, 0.54, 0.12]], [43, [0.85, 0.23, 0.20]]];
  function ramp(stops, v, out) {
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) if (v <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
    const t = clamp((v - a[0]) / ((b[0] - a[0]) || 1), 0, 1);
    out[0] = mix(a[1][0], b[1][0], t); out[1] = mix(a[1][1], b[1][1], t); out[2] = mix(a[1][2], b[1][2], t);
    return out;
  }
  const css = (stops, v) => { const c = ramp(stops, v, [0, 0, 0]); return `rgb(${c.map(x => Math.round(x * 255)).join(',')})`; };

  let seed = 20261126;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  /**
   * Windteilchen über der Szene.
   * sample(lat, lon) -> { g: [u, v] Bodenwind dem Gelände entlang, a: [u, v] Wind auf ca. 2000 m } in km/h (wohin die Luft strömt).
   * o.n: Anzahl, o.calm: Ruhig-Modus, o.glow: Farben für den Glow-Look. Rückgabe für Scene.setStreaks, dazu setField(sample).
   */
  function wind(sc, sample, o = {}) {
    const R = sc.R, M = 44, cell = 2 * R / (M - 1), NN = M * M;
    const F = { u0: new Float32Array(NN), v0: new Float32Array(NN), u8: new Float32Array(NN), v8: new Float32Array(NN), lee: new Float32Array(NN), expo: new Float32Array(NN), ok: new Uint8Array(NN) };
    const H = new Float32Array(NN);
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) H[j * M + i] = sc._meshH(-R + i * cell, -R + j * cell);
    const hAt = (x, z) => sc._meshH(x, z);
    // Hangneigung (Steigung in m pro m) für den 3D-Fluss: am Luv-Hang wird die Luft gehoben (Soaring), im Lee sinkt sie
    const GX = new Float32Array(NN), GZ = new Float32Array(NN);
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
      const k = j * M + i, i0 = Math.max(0, i - 1), i1 = Math.min(M - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(M - 1, j + 1);
      GX[k] = (H[j * M + i1] - H[j * M + i0]) / ((i1 - i0) * cell || 1); GZ[k] = (H[j1 * M + i] - H[j0 * M + i]) / ((j1 - j0) * cell || 1);
    }
    // Exposition: höher als die Umgebung (2 km) -> Wind schneller
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
      const x = -R + i * cell, z = -R + j * cell, h0 = H[j * M + i], rr = Math.min(2000, R * 0.25);
      let a = 0; for (let k = 0; k < 8; k++) a += hAt(x + Math.cos(k * Math.PI / 4) * rr, z + Math.sin(k * Math.PI / 4) * rr);
      F.expo[j * M + i] = sstep(0, 450, h0 - a / 8);
    }
    const field = smp => {
      let su = 0, sv = 0, n = 0;
      for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
        const k = j * M + i, [lat, lon] = sc.toGeo(-R + i * cell, -R + j * cell), w = smp(lat, lon);
        const g = w?.g, a = w?.a || g;
        F.ok[k] = g ? 1 : 0;
        F.u0[k] = g ? g[0] : 0; F.v0[k] = g ? g[1] : 0; F.u8[k] = a ? a[0] : 0; F.v8[k] = a ? a[1] : 0;
        if (a) { su += a[0]; sv += a[1]; n++; }
      }
      // Lee: hinter (gegen den Wind gesehen) höherem Gelände; je stärker der Wind, desto kräftiger
      su /= n || 1; sv /= n || 1;
      const sp = Math.hypot(su, sv) || 1, ex = su / sp, ez = -sv / sp, strong = sstep(8, 35, sp);
      for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
        const x = -R + i * cell, z = -R + j * cell, h0 = H[j * M + i];
        let rise = 0; for (let d = 400; d <= 3000; d += 325) rise = Math.max(rise, hAt(x - ex * d, z - ez * d) - h0);
        F.lee[j * M + i] = sstep(120, 750, rise) * (0.25 + 0.75 * strong);
      }
      F.mean = { u: su, v: sv, kmh: sp };
    };
    field(sample);
    const bil = (arr, x, z) => {
      const fx = clamp((x + R) / cell, 0, M - 1.001), fz = clamp((z + R) / cell, 0, M - 1.001), i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, k = j * M + i;
      return (arr[k] * (1 - tx) + arr[k + 1] * tx) * (1 - tz) + (arr[k + M] * (1 - tx) + arr[k + M + 1] * tx) * tz;
    };
    const box = o.box || null;                                   // 2D-Karte: Rechteck [halbe Breite, halbe Höhe] statt Kreis
    const f3 = !box;                                             // 3D: Fluss am Gelände mit echter Spur (zwei Abschnitte je Teilchen)
    const N = Math.min(f3 ? 8000 : 16000, o.n || 8000), X = new Float32Array(N), Z = new Float32Array(N), AGL = new Float32Array(N), AGE = new Float32Array(N), LIFE = new Float32Array(N);
    const A0 = new Float32Array(N), HX = new Float32Array(N * 3), HY = new Float32Array(N * 3), HZ = new Float32Array(N * 3), HT = new Float32Array(N), HN = new Uint8Array(N);
    const R2 = R * 0.95, INT = clamp(0.2 * R / 2400, 0.15, 0.55);   // Abstand der Spurpunkte: grössere Szene, längere Spur
    const out = (x, z) => (box ? Math.abs(x) > box[0] || Math.abs(z) > box[1] : x * x + z * z > R2 * R2);
    const spawn = (i, randomAge) => {
      let x, z; if (box) { x = (rnd() * 2 - 1) * box[0]; z = (rnd() * 2 - 1) * box[1]; } else do { x = (rnd() * 2 - 1) * R2; z = (rnd() * 2 - 1) * R2; } while (x * x + z * z > R2 * R2);
      X[i] = x; Z[i] = z;
      // 3D: dicht am Boden wie Wasser, ein paar Fäden etwas höher; 2D wie bisher
      AGL[i] = A0[i] = f3 ? 12 + Math.pow(rnd(), 2.2) * Math.min(420, R * 0.05) : 30 + Math.pow(rnd(), 1.7) * Math.min(750, R * 0.09);
      LIFE[i] = f3 ? 3.5 + rnd() * 5 : 2.5 + rnd() * 3.5; AGE[i] = randomAge ? rnd() * LIFE[i] : 0; HN[i] = 0; HT[i] = 0;
    };
    for (let i = 0; i < N; i++) spawn(i, true);
    const col = [0, 0, 0], head = [0, 0, 0], tail = [0, 0, 0], mid = [0, 0, 0], ex = sc.ex;
    let t = 0;
    const sim = {
      max: f3 ? N * 2 : N, mean: () => F.mean,
      setField(smp) { field(smp); },
      step(dt, put) {
        const calm = !!sim.calm, glow = !!sim.glow, ts = (calm ? 50 : 90) * (sim.speed || 1), n = calm ? Math.round(N * 0.38) : N;
        t += dt;
        const kmToM = ts / 3.6, tailK = R * (calm ? 0.0022 : 0.0026) * (glow ? 1 : 0.8), wpx = (calm ? 1.05 : 1.45) * (glow ? 1 : 0.95);   // bei Tag kürzer und feiner: die Karte bleibt sichtbar
        let c = 0;
        for (let i = 0; i < n; i++) {
          AGE[i] += dt;
          if (AGE[i] > LIFE[i] || out(X[i], Z[i])) spawn(i, false);
          const x = X[i], z = Z[i], agl = AGL[i];
          if (!bil(F.ok, x, z)) { AGE[i] = LIFE[i] + 1; continue; }
          const m = sstep(20, 500, agl);
          let u = mix(bil(F.u0, x, z), bil(F.u8, x, z), m), v = mix(bil(F.v0, x, z), bil(F.v8, x, z), m);
          const sp0 = 1 + 0.45 * bil(F.expo, x, z); u *= sp0; v *= sp0;
          const lee = bil(F.lee, x, z), s = Math.hypot(u, v);
          let gust = 0;
          if (lee > 0.02) {
            const kk = 1 / 1000, e = 80, q = t * 0.3, n0 = noise3(x * kk, -z * kk + e * kk, q), n1 = noise3(x * kk, -z * kk - e * kk, q), n2 = noise3(x * kk + e * kk, -z * kk, q), n3 = noise3(x * kk - e * kk, -z * kk, q);
            const cx = (n0 - n1) / (2 * e * kk), cy = -(n2 - n3) / (2 * e * kk), amp = lee * (s + 6) * 0.95;
            u = u * (1 - lee * 0.55) + cx * amp; v = v * (1 - lee * 0.55) + cy * amp;
            gust = lee * s * (0.5 + 0.5 * noise3(x * 0.003, z * 0.003, t * 1.3));
          }
          let soar = 0;
          if (f3) {
            // Spur merken (alle 60 ms ein Punkt): der Schweif folgt dem echten Weg, auch über Kuppen und in Wirbeln
            HT[i] += dt;
            if (HN[i] === 0 || HT[i] >= INT) {
              const o3 = i * 3; HX[o3 + 2] = HX[o3 + 1]; HY[o3 + 2] = HY[o3 + 1]; HZ[o3 + 2] = HZ[o3 + 1]; HX[o3 + 1] = HX[o3]; HY[o3 + 1] = HY[o3]; HZ[o3 + 1] = HZ[o3];
              HX[o3] = x; HY[o3] = (hAt(x, z) + agl) * ex; HZ[o3] = z; HT[i] = HN[i] === 0 ? 0 : HT[i] - INT; HN[i] = Math.min(3, HN[i] + 1);
            }
            // senkrecht: Wind gegen den Hang hebt die Luft (Hangaufwind, Soaring), im Lee drückt sie nach unten, im Rotor wirbelt sie auf und ab
            const up = (u * bil(GX, x, z) - v * bil(GZ, x, z)) / 3.6;   // m/s, aus Wind und Hangneigung
            soar = sstep(0.4, 2.2, up) * (1 - lee);
            let dz = (up > 0 ? up * 0.45 : up * 0.15) * ts;
            if (lee > 0.05) dz += noise3(x * 0.004, z * 0.004, t * 0.9) * lee * (s + 5) * 0.35 * ts / 3.6;
            AGL[i] = clamp(agl + (dz + (A0[i] - agl) * 0.7) * dt, 6, A0[i] + 600);
          }
          X[i] = x + u * kmToM * dt; Z[i] = z - v * kmToM * dt;
          const sp = Math.hypot(u, v), eff = sp + gust;
          if (sp < 1) continue;
          const y = (hAt(X[i], Z[i]) + AGL[i]) * ex;
          const edge = box ? 1 : 1 - sstep(0.78, 0.95, Math.hypot(X[i], Z[i]) / R);
          const life = Math.max(0, Math.min(1, AGE[i] / 0.6, (LIFE[i] - AGE[i]) / 0.8));
          ramp(glow ? GLOW : sim.map ? MAP : DAY, eff, col);
          if (lee > 0.06) { const mm = Math.min(0.92, (lee - 0.06) * 2.6); col[0] = mix(col[0], glow ? 1 : 0.85, mm); col[1] = mix(col[1], glow ? 0.22 : 0.15, mm); col[2] = mix(col[2], glow ? 0.72 : 0.65, mm); }
          if (soar > 0.05) { const mm = Math.min(0.85, soar); col[0] = mix(col[0], glow ? 0.55 : 0.15, mm); col[1] = mix(col[1], glow ? 1.0 : 0.72, mm); col[2] = mix(col[2], glow ? 0.42 : 0.2, mm); }   // Hangaufwind: grün
          const a = (glow ? (calm ? 0.3 : 0.46) : (calm ? 0.6 : 0.85)) * (0.55 + 0.5 * Math.min(1, eff / 30)) * edge * life * (1 + 0.6 * clamp(lee * 2, 0, 1));
          if (a < 0.01) continue;
          head[0] = X[i]; head[1] = y; head[2] = Z[i];
          const wd = wpx * (0.9 + Math.min(1, eff / 40)) * (1 + 0.35 * soar);
          if (f3 && HN[i] >= 3) {
            // zwei Abschnitte entlang der gemerkten Spur, gleichmässig nachgezogen (kein Flackern)
            const o3 = i * 3, f = clamp(HT[i] / INT, 0, 1);
            mid[0] = mix(HX[o3], HX[o3 + 1], f); mid[1] = mix(HY[o3], HY[o3 + 1], f); mid[2] = mix(HZ[o3], HZ[o3 + 1], f);
            tail[0] = mix(HX[o3 + 1], HX[o3 + 2], f); tail[1] = mix(HY[o3 + 1], HY[o3 + 2], f); tail[2] = mix(HZ[o3 + 1], HZ[o3 + 2], f);
            put(c++, head, mid, col[0], col[1], col[2], a, wd);
            put(c++, mid, tail, col[0], col[1], col[2], a * 0.42, wd * 0.8);
          } else {
            const tl = tailK * clamp(sp, 4, 20) * (1 - 0.7 * clamp(lee * 1.4, 0, 1));
            tail[0] = X[i] - u / sp * tl; tail[1] = y; tail[2] = Z[i] + v / sp * tl;
            put(c++, head, tail, col[0], col[1], col[2], a * (f3 ? 0.6 : 1), wd);
          }
        }
        return c;
      }
    };
    sim.calm = !!o.calm; sim.glow = !!o.glow; sim.map = !!o.map; sim.speed = o.speed || 1;
    return sim;
  }

  /**
   * Thermik-Säulen: spots = [{ A: [x, y, z] Fuss in Szenen-Koordinaten, lean: [x, z] Neigung oben (m), H: Höhe (m),
   * climb: Steigen m/s, v: Stärke 0-1 }]. Teilchen kreisen nach oben, je stärker, desto schneller und heller.
   */
  function thermals(sc, spots, o = {}) {
    const per = clamp(Math.round((o.n || 6000) / Math.max(1, spots.length)), 120, 700), N = per * spots.length;
    const F = new Float32Array(N), ANG = new Float32Array(N), RR = new Float32Array(N), SS = new Float32Array(N);
    for (let i = 0; i < N; i++) { F[i] = rnd(); ANG[i] = rnd() * Math.PI * 2; RR[i] = 0.5 + rnd() * 0.7; SS[i] = 0.7 + rnd() * 0.6; }
    const head = [0, 0, 0], tail = [0, 0, 0], ex = sc.ex, rBase = clamp(sc.R * 0.009, 45, 160);
    const sim = {
      max: N,
      step(dt, put) {
        const calm = !!sim.calm, glow = !!sim.glow, ts = calm ? 50 : 90, use = calm ? Math.round(per * 0.4) : per;
        let c = 0;
        spots.forEach((p, si) => {
          const climb = Math.max(0.3, p.climb || 1.5), Hh = Math.max(150, p.H), heat = clamp(climb / 3, 0, 1);
          const rate = climb / Hh * ts * 0.55, omega = (0.9 + climb * 0.35) * (calm ? 0.6 : 1);
          for (let k = 0; k < use; k++) {
            const i = si * per + k;
            F[i] += rate * dt * SS[i]; if (F[i] > 1) { F[i] -= 1; ANG[i] = rnd() * Math.PI * 2; }
            ANG[i] += omega * dt * (1.2 - F[i] * 0.5);
            const f = F[i], rad = rBase * (0.7 + 0.6 * (p.v ?? 0.6)) * (0.6 + 2.4 * Math.pow(f, 0.7) + (f > 0.85 ? (f - 0.85) * 22 : 0)) * RR[i];
            const cx = p.A[0] + p.lean[0] * f * f, cz = p.A[2] + p.lean[1] * f * f, y = p.A[1] + f * Hh * ex;
            const ang = ANG[i], a2 = ang - 0.75;
            head[0] = cx + Math.cos(ang) * rad; head[1] = y; head[2] = cz + Math.sin(ang) * rad;
            tail[0] = cx + Math.cos(a2) * rad * 0.97; tail[1] = y - Hh * rate * 0.6 * ex; tail[2] = cz + Math.sin(a2) * rad * 0.97;
            const fade = sstep(0, 0.08, f) * (1 - sstep(0.86, 1, f)), core = 1 - clamp(rad / (rBase * 2.2), 0, 1);
            const a = fade * (glow ? mix(0.28, 0.55, heat) : mix(0.55, 0.9, heat)) * (calm ? 0.6 : 1);
            if (a < 0.01) continue;
            if (glow) put(c++, head, tail, 1, mix(0.42, 0.72, core), mix(0.10, 0.35, core * heat), a, calm ? 0.8 : 1.05);
            else put(c++, head, tail, 1, mix(0.50, 0.62, core), mix(0.05, 0.12, core), a, calm ? 0.9 : 1.2);
          }
        });
        return c;
      }
    };
    sim.calm = !!o.calm; sim.glow = !!o.glow;
    return sim;
  }

  window.AFCMotion = { wind, thermals, noise3, color: (kmh, glow) => css(glow ? GLOW : DAY, kmh), legend: glow => (glow ? GLOW : DAY).map(([k, c]) => [k, `rgb(${c.map(x => Math.round(x * 255)).join(',')})`]) };
})();
