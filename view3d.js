// AFC 3D: Gelände als Relief mit WebGL, ohne Zusatzpakete.
// Baut aus dem Geländeraster (ca. 250 m, weich interpoliert) oder aus einem feinen Höhenmodell (offene Höhenkacheln,
// rund 30 m) eine runde Reliefscheibe um einen Punkt, beleuchtet sie nach dem Sonnenstand (mit Schattenwurf der Berge),
// legt wahlweise das Kartenbild und eine Ebene (Thermik, Lee …) darüber und zeichnet Wolken und Nebelmeer, Linien
// (Kabel, Flugspur, Wind), Flächen und Beschriftungen. Bedienung: ziehen dreht, zwei Finger zoomen und verschieben.
// Läuft im Browser als window.AFC3D.
(() => {
  'use strict';
  const D2R = Math.PI / 180, M_LAT = 111320;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const lerpDeg = (a, b, f) => a + ((((b - a) % 360) + 540) % 360 - 180) * f;

  /* ---- 4x4-Matrizen (spaltenweise) */
  function persp(fov, asp, n, f) {
    const t = 1 / Math.tan(fov / 2), o = new Float32Array(16);
    o[0] = t / asp; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f);
    return o;
  }
  function look(e, c, roll = 0) {
    let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2], l = Math.hypot(zx, zy, zz) || 1;
    zx /= l; zy /= l; zz /= l;
    let xx = zz, xy = 0, xz = -zx; l = Math.hypot(xx, xz) || 1; xx /= l; xz /= l;      // up = (0,1,0)
    let yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    if (roll) {                                                                        // Schräglage: um die Blickachse drehen
      const k = Math.cos(roll), q = Math.sin(roll), ax = xx * k + yx * q, ay = xy * k + yy * q, az = xz * k + yz * q;
      yx = yx * k - xx * q; yy = yy * k - xy * q; yz = yz * k - xz * q; xx = ax; xy = ay; xz = az;
    }
    return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0, -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
  }
  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  }
  function rgba(c, a = 1) {
    if (Array.isArray(c)) return c.length > 3 ? c : [c[0], c[1], c[2], a];
    const h = String(c).replace('#', ''), n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, a];
  }

  /* ---- Höhe aus dem Raster: weich (Catmull-Rom) für das Relief, schnell (bilinear) für den Schattenwurf */
  function samplers(g) {
    const { nx, ny, elev } = g;
    const at = (x, y) => elev[clamp(y, 0, ny - 1) * nx + clamp(x, 0, nx - 1)];
    const cr = (a, b, c, d, t) => b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
    const smooth = (lat, lon) => {
      const fx = (lon - g.lo0) / g.dlo, fy = (lat - g.la0) / g.dla, x = Math.floor(fx), y = Math.floor(fy), tx = fx - x, ty = fy - y;
      const r = j => cr(at(x - 1, y + j), at(x, y + j), at(x + 1, y + j), at(x + 2, y + j), tx);
      return cr(r(-1), r(0), r(1), r(2), ty);
    };
    const fast = (lat, lon) => {
      const fx = clamp((lon - g.lo0) / g.dlo, 0, nx - 1.001), fy = clamp((lat - g.la0) / g.dla, 0, ny - 1.001), x = fx | 0, y = fy | 0, tx = fx - x, ty = fy - y, k = y * nx + x;
      return (elev[k] * (1 - tx) + elev[k + 1] * tx) * (1 - ty) + (elev[k + nx] * (1 - tx) + elev[k + nx + 1] * tx) * ty;
    };
    return { smooth, fast };
  }
  /** Seen: Flächen, die im Raster völlig eben sind (z.B. Thuner- und Brienzersee). Ergebnis 0/1 je Rasterzelle. */
  function lakes(g) {
    if (g._lakes) return g._lakes;
    const { nx, ny, elev } = g, core = new Uint8Array(nx * ny), out = new Uint8Array(nx * ny);
    for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
      const k = y * nx + x, e = elev[k];
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) if (elev[k + dy * nx + dx] !== e) { ok = false; break; }
      if (ok) core[k] = 1;
    }
    for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
      const k = y * nx + x;
      if (!core[k]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out[k + dy * nx + dx] = 1;
    }
    return (g._lakes = out);
  }

  /* ---- Feines Höhenmodell aus offenen Höhenkacheln (Terrarium-Format: Höhe = R·256 + G + B/256 − 32768) */
  const demMem = new Map();
  const mercY = (lat, n) => (1 - Math.log(Math.tan(lat * D2R) + 1 / Math.cos(lat * D2R)) / Math.PI) / 2 * n;
  async function demTrim(store) { const keys = await store.keys(); if (keys.length > 160) for (const k of keys.slice(0, keys.length - 120)) await store.delete(k); }
  /** Eine Kachel als Bild: zuerst aus dem Zwischenspeicher des Geräts (spart Daten und geht ohne Empfang), sonst aus dem Netz. */
  async function demTile(url) {
    let res = null, store = null;
    try { store = await caches.open('afc-dem'); res = await store.match(url); } catch { /* kein Zwischenspeicher, z.B. im privaten Fenster */ }
    if (!res) {
      res = await fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (store) store.put(url, res.clone()).then(() => demTrim(store)).catch(() => {});
    }
    const blob = await res.blob();
    if (typeof createImageBitmap === 'function') { try { return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }); } catch { /* unten als <img> */ } }
    return new Promise((ok, bad) => { const im = new Image(), u = URL.createObjectURL(blob); im.onload = () => { URL.revokeObjectURL(u); ok(im); }; im.onerror = () => { URL.revokeObjectURL(u); bad(new Error('Kachel nicht lesbar')); }; im.src = u; });
  }
  /**
   * Feines Höhenmodell für einen Ausschnitt laden. tpl: Kachel-Adresse mit {z}/{x}/{y}. Ergebnis null, wenn es sich nicht
   * lohnt (grosser Ausschnitt), das Netz fehlt, es zu lange dauert (o.timeout) oder die Daten nicht zum groben Raster
   * passen (o.grid: das grobe Raster zum Vergleich): dann bleibt das Relief aus dem groben Raster.
   */
  async function loadDem(tpl, { lat, lon, radius }, o = {}) {
    if (!tpl || typeof document === 'undefined') return null;
    const cosL = Math.cos(lat * D2R), want = 2 * radius / 300;                 // Maschenweite des Reliefs in m
    if (want > 150) return null;
    let z = 12; while (z > 10 && 40075016 * cosL / 2 ** z / 256 < want * 0.5) z--;
    const n = 2 ** z, pad = radius + 400, mLon = M_LAT * cosL;
    const x0 = Math.floor((lon - pad / mLon + 180) / 360 * n), x1 = Math.floor((lon + pad / mLon + 180) / 360 * n), y0 = Math.floor(mercY(lat + pad / M_LAT, n)), y1 = Math.floor(mercY(lat - pad / M_LAT, n));
    const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
    if (nx * ny > 20) return null;
    const key = [z, x0, y0, x1, y1].join('/');
    if (demMem.has(key)) return demMem.get(key);
    const keep = dem => { if (!dem) return; demMem.set(key, dem); if (demMem.size > 3) demMem.delete(demMem.keys().next().value); };
    const job = (async () => {
      const jobs = [];
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) jobs.push(demTile(tpl.replace('{z}', z).replace('{x}', x0 + x).replace('{y}', y0 + y)));
      const ims = await Promise.all(jobs);
      const W = nx * 256, H = ny * 256, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ims.forEach((im, i) => { ctx.drawImage(im, (i % nx) * 256, Math.floor(i / nx) * 256, 256, 256); im.close?.(); });
      const px = ctx.getImageData(0, 0, W, H).data, data = new Float32Array(W * H);
      for (let i = 0, q = 0; i < data.length; i++, q += 4) data[i] = px[q] * 256 + px[q + 1] + px[q + 2] / 256 - 32768;
      cv.width = cv.height = 1;
      const dem = {
        z, res: 40075016 * cosL / n / 256, W, H, data,
        has(la, lo) { const fx = ((lo + 180) / 360 * n - x0) * 256, fy = (mercY(la, n) - y0) * 256; return fx >= 1 && fy >= 1 && fx <= W - 1 && fy <= H - 1; },
        at(la, lo) {
          const fx = clamp(((lo + 180) / 360 * n - x0) * 256 - 0.5, 0, W - 1.001), fy = clamp((mercY(la, n) - y0) * 256 - 0.5, 0, H - 1.001), x = fx | 0, y = fy | 0, tx = fx - x, ty = fy - y, k = y * W + x;
          return (data[k] * (1 - tx) + data[k + 1] * tx) * (1 - ty) + (data[k + W] * (1 - tx) + data[k + W + 1] * tx) * ty;
        }
      };
      // Plausibilität gegen das grobe Raster: ein falsch gelesenes Bild darf nie als Gelände erscheinen
      const chk = o.grid ? samplers(o.grid).fast : o.check;
      if (chk) {
        let sum = 0, cnt = 0;
        for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { const la = lat + j * radius * 0.4 / M_LAT, lo = lon + i * radius * 0.4 / mLon, c = chk(la, lo); if (Number.isFinite(c)) { sum += Math.abs(dem.at(la, lo) - c); cnt++; } }
        if (cnt && sum / cnt > 220) throw new Error('Höhendaten unplausibel');
      }
      return dem;
    })();
    job.then(keep).catch(() => {});      // kommt es erst nach der Wartezeit an, steht es beim nächsten Öffnen bereit
    return Promise.race([job, new Promise(r => setTimeout(() => r(null), o.timeout ?? 7000))]).catch(() => null);
  }

  /** Kachelbares Rauschen (128 × 128) für die Wolken: drei Kanäle mit grober, mittlerer und feiner Struktur, je gleichverteilt 0–255. */
  function noiseData() {
    const S = 128, out = new Uint8Array(S * S * 4);
    let seed = 20261111; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const layer = cells => {
      const g = new Float32Array(cells * cells).map(rnd);
      return (x, y) => {
        const fx = x / S * cells, fy = y / S * cells, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const a = g[(y0 % cells) * cells + x0 % cells], b = g[(y0 % cells) * cells + (x0 + 1) % cells], c = g[((y0 + 1) % cells) * cells + x0 % cells], d = g[((y0 + 1) % cells) * cells + (x0 + 1) % cells];
        return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
      };
    };
    [[[4, 0.5], [8, 0.3], [16, 0.2]], [[8, 0.55], [16, 0.45]], [[16, 0.55], [32, 0.45]]].forEach((oct, ch) => {
      const fs = oct.map(([cells, w]) => [layer(cells), w]), v = new Float32Array(S * S);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { let t = 0; for (const [fn, w] of fs) t += fn(x, y) * w; v[y * S + x] = t; }
      // Rangfolge statt Wert: so entspricht der Anteil über einer Schwelle genau der gewünschten Bedeckung
      const order = Array.from(v.keys()).sort((a, b) => v[a] - v[b]);
      order.forEach((k, r) => { out[k * 4 + ch] = Math.round(r / (S * S - 1) * 255); });
    });
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    return out;
  }

  /* ---- Shader */
  const HI = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';
  const VS_SKY = 'attribute vec2 a_p; varying float v_y; void main(){ v_y = a_p.y*.5+.5; gl_Position = vec4(a_p, 0.999, 1.); }';
  const FS_SKY = HI + 'varying float v_y; uniform vec3 u_top, u_bot; void main(){ gl_FragColor = vec4(mix(u_bot, u_top, smoothstep(.25, 1., v_y)), 1.); }';
  const VS_TER = `attribute vec3 a_pos, a_n; attribute vec2 a_uv, a_duv; attribute float a_w, a_sh, a_cv;
    uniform mat4 u_mvp; varying vec3 v_pos, v_n; varying vec2 v_uv, v_duv; varying float v_w, v_sh, v_cv;
    void main(){ v_pos = a_pos; v_n = a_n; v_uv = a_uv; v_duv = a_duv; v_w = a_w; v_sh = a_sh; v_cv = a_cv; gl_Position = u_mvp*vec4(a_pos, 1.); }`;
  const FS_TER = d => (d ? '#extension GL_OES_standard_derivatives : enable\n' : '') + HI + `
    varying vec3 v_pos, v_n; varying vec2 v_uv, v_duv; varying float v_w, v_sh, v_cv;
    uniform vec3 u_sun, u_sunCol, u_amb, u_eye, u_fog; uniform vec2 u_c; uniform vec3 u_f;   // u_f: Radius, Nebel ab, Nebel bis
    uniform sampler2D u_ov0, u_ov1, u_dr, u_noise, u_cov; uniform float u_ovMix, u_ovA, u_drape, u_ex;
    uniform vec4 u_cv, u_cl; uniform vec2 u_coff, u_sunH;   // u_cl: Wolken an, Basis, Massstab, Nebel-Obergrenze (Szenenhöhe)
    void main(){
      float r = length(v_pos.xz - u_c), edge = 1. - smoothstep(u_f.x*.94, u_f.x, r);
      if (edge < .01) discard;
      vec3 n = normalize(v_n); float h = v_pos.y/u_ex;
      vec3 c = mix(vec3(.45,.58,.34), vec3(.29,.43,.27), smoothstep(650., 1500., h));
      c = mix(c, vec3(.57,.61,.39), smoothstep(1750., 2150., h));
      c = mix(c, vec3(.60,.58,.55), smoothstep(2250., 2700., h));
      float steep = smoothstep(.82, .60, n.y);
      c = mix(c, vec3(.53,.51,.49), steep*.85);
      c = mix(c, vec3(.95,.97,1.), smoothstep(2750., 3150., h)*(1. - steep*.5));
      c *= 1. + v_cv*.3;                                        // Grate heller, Rinnen dunkler: die Form bleibt auch im Schatten lesbar
      c = mix(c, vec3(.20,.42,.58), smoothstep(.35, .65, v_w));
      ${d ? 'float f = h/100., fw = fwidth(f); float l = (1. - smoothstep(0., 1.3*fw, abs(fract(f - .5) - .5)))*clamp(1. - fw*2.5, 0., 1.); c *= 1. - l*.22*(1. - smoothstep(.35, .65, v_w))*(1. - u_drape);' : ''}
      float cs = 0., fg = 0.;
      if (u_cl.x > 0.) {
        // Schatten der Wolken wandert über das Gelände (dem Sonnenstand nach versetzt)
        vec2 sp = v_pos.xz + u_sunH*max(0., u_cl.y - v_pos.y);
        float cov = texture2D(u_cov, sp*u_cv.xy + u_cv.zw).r, th = 1.02 - cov*1.04;
        cs = smoothstep(th, th + .09, texture2D(u_noise, sp/u_cl.z + u_coff).r)*step(v_pos.y, u_cl.y)*u_cl.x;
      }
      if (u_cl.w > 0. && v_pos.y < u_cl.w) fg = smoothstep(.5, .8, texture2D(u_cov, v_pos.xz*u_cv.xy + u_cv.zw).g);
      float dif = max(dot(n, u_sun), 0.)*v_sh*(1. - .8*cs)*(1. - .85*fg);
      float hemi = .8 + .28*n.y;                               // Himmelslicht: flache Stellen heller als steile
      vec3 lit = c*(u_amb*hemi*(1. - .16*cs) + u_sunCol*dif);
      vec4 dr = texture2D(u_dr, v_duv);
      lit = mix(lit, dr.rgb*(1. + v_cv*.16)*(u_amb*1.25*hemi + u_sunCol*(.35 + .65*dif)), u_drape);
      vec4 ov = mix(texture2D(u_ov0, v_uv), texture2D(u_ov1, v_uv), u_ovMix)*u_ovA;
      lit = lit*(1. - ov.a) + ov.rgb*(.72 + .28*dif);
      float fd = length(v_pos - u_eye);
      lit = mix(lit, u_fog, clamp((fd - u_f.y)/(u_f.z - u_f.y), 0., .6));
      gl_FragColor = vec4(lit, edge);
    }`;
  const VS_LINE = `attribute vec3 a_p, a_q, a_m; attribute vec4 a_col; attribute float a_sp;
    uniform mat4 u_mvp; uniform vec2 u_vp; uniform float u_bias;
    varying vec4 v_col; varying float v_d, v_s, v_sp;
    void main(){
      vec4 cp = u_mvp*vec4(a_p, 1.), cq = u_mvp*vec4(a_q, 1.);
      // reicht ein Ende hinter die Kamera, wird der Abschnitt kurz vor ihr gekappt: so bleibt die Breite überall gleich
      if (cp.w < 2. && cq.w > 2.) cp = mix(cq, cp, (cq.w - 2.)/(cq.w - cp.w));
      else if (cq.w < 2. && cp.w > 2.) cq = mix(cp, cq, (cp.w - 2.)/(cp.w - cq.w));
      vec2 dir = (cq.xy/max(cq.w, 1e-3) - cp.xy/max(cp.w, 1e-3))*u_vp; float l = length(dir);
      dir = l > 1e-4 ? dir/l : vec2(1., 0.);
      float side = sign(a_m.x), flip = abs(a_m.x) > 1.5 ? -1. : 1.;       // Betrag 2: Ende des Abschnitts, Richtung gespiegelt
      cp.xy += vec2(-dir.y, dir.x)*side*flip*a_m.z*2./u_vp*cp.w;
      cp.z -= u_bias*cp.w;
      v_col = a_col; v_d = a_m.y; v_s = side; v_sp = a_sp; gl_Position = cp;
    }`;
  const FS_LINE = HI + `varying vec4 v_col; varying float v_d, v_s, v_sp; uniform float u_time, u_alpha, u_flow, u_dash;
    void main(){
      float a = v_col.a*u_alpha*(1. - smoothstep(.5, 1., abs(v_s)));
      if (u_flow > 0.) { float f = fract(v_d/u_flow - u_time*v_sp); a *= .1 + .9*f*f*f; }
      if (u_dash > 0.) a *= step(.45, fract(v_d/u_dash));
      gl_FragColor = vec4(v_col.rgb, a);
    }`;
  const VS_CLD = 'attribute vec3 a_pos; uniform mat4 u_mvp; uniform float u_lift; varying vec3 v_pos; void main(){ v_pos = vec3(a_pos.x, a_pos.y + u_lift, a_pos.z); gl_Position = u_mvp*vec4(v_pos, 1.); }';
  const FS_CLD = HI + `varying vec3 v_pos; uniform sampler2D u_noise, u_cov; uniform vec4 u_cv; uniform vec2 u_off; uniform vec3 u_lit, u_dim;
    uniform float u_k, u_R, u_sc, u_fog, u_a;
    void main(){
      float edge = 1. - smoothstep(u_R*.86, u_R*.985, length(v_pos.xz));
      if (edge < .01) discard;
      vec2 q = v_pos.xz/u_sc + u_off; vec4 cv = texture2D(u_cov, v_pos.xz*u_cv.xy + u_cv.zw);
      float n = texture2D(u_noise, q).r, d = texture2D(u_noise, q*3.3 + u_off*.7).g, a; vec3 c;
      if (u_fog > .5) {
        // Nebelmeer: geschlossene Decke mit sanften Wellen, nur wo die Prognose tiefe Wolken zeigt
        a = (.5 + .3*n)*smoothstep(.5, .8, cv.g);
        c = mix(u_dim, u_lit, .5 + .5*u_k)*(.9 + .1*d);
      } else {
        // Quellwolken: die Schwelle steigt nach oben, so wölben sich die Wolken; bei voller Bedeckung eine Decke
        float th = 1.02 - cv.r*1.04 + u_k*(.07 + .2*(1. - cv.r)) + (d - .5)*.1*u_k;
        a = smoothstep(th, th + .09, n)*.6;
        c = mix(u_dim, u_lit, clamp(u_k*.8 + .25*smoothstep(th, th + .35, n), 0., 1.));
      }
      gl_FragColor = vec4(c, a*edge*u_a);
    }`;
  const VS_FLAT = 'attribute vec3 a_pos; attribute vec4 a_col; uniform mat4 u_mvp; varying vec4 v_col; void main(){ v_col = a_col; gl_Position = u_mvp*vec4(a_pos, 1.); }';
  const FS_FLAT = HI + 'varying vec4 v_col; uniform float u_alpha; void main(){ gl_FragColor = vec4(v_col.rgb, v_col.a*u_alpha); }';

  class Scene {
    /**
     * host: Element, in das die Zeichenfläche und die Beschriftungen kommen. grid: Geländeraster der App.
     * o.interactive (Standard true): Bedienung mit Finger und Maus. o.size [b, h]: feste Grösse in Pixeln (für Clips).
     * o.spin: nur seitlich drehen, die Seite scrollt weiter (kleines Modell). o.bg [r, g, b]: einfarbiger Grund statt Himmel.
     */
    constructor(host, grid, o = {}) {
      this.host = host; this.g = grid; this.o = o;
      const s = samplers(grid); this.ground = s.smooth; this._fast = s.fast;
      this.ex = o.ex || 1.15;
      this.cam = { t: [0, 0, 0], az: 0, el: 32, dist: 6000 };
      this.sun = { az: 180, elev: 45 };
      this.sky = o.sky || { top: [0.36, 0.56, 0.80], bot: [0.80, 0.88, 0.94] };
      this.lines = new Map(); this.tris = new Map(); this.markers = [];
      this._ov = { mix: 1, t0: 0, ms: 1, on: false }; this._drape = { a: 0, t0: 0, ok: false };
      this._vel = [0, 0]; this.orbit = 0; this.time = 0; this.pov = null;
      const c = this.canvas = document.createElement('canvas');
      c.className = 'v3d-c'; c.setAttribute('role', 'img'); c.tabIndex = o.interactive === false ? -1 : 0;
      if (host) {
        host.appendChild(c);
        this.lab = document.createElement('div'); this.lab.className = 'v3d-labels'; host.appendChild(this.lab);
      }
      const opt = { antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: !!o.keep };
      this.gl = c.getContext('webgl', opt) || c.getContext('experimental-webgl', opt);
      if (!this.gl) throw new Error('Dieses Gerät unterstützt keine 3D-Darstellung (WebGL).');
      this._lost = e => { e.preventDefault(); this._gone = true; cancelAnimationFrame(this._raf); this._raf = 0; };
      this._back = () => { this._gone = false; this._initGL(); this._upload(); this.invalidate(); };
      c.addEventListener('webglcontextlost', this._lost); c.addEventListener('webglcontextrestored', this._back);
      this._initGL();
      if (o.interactive !== false) this._controls();
      if (host && !o.size && typeof ResizeObserver !== 'undefined') { this._ro = new ResizeObserver(() => this.invalidate()); this._ro.observe(host); }
    }

    /* ---- WebGL einrichten (auch nach einem verlorenen Kontext) */
    _prog(vs, fs) {
      const gl = this.gl, mk = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error('3D-Shader: ' + gl.getShaderInfoLog(s)); return s; };
      const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error('3D-Programm: ' + gl.getProgramInfoLog(p));
      const o = { p, a: {}, u: {} };
      for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES) | 0; i < n; i++) { const x = gl.getActiveAttrib(p, i); o.a[x.name] = gl.getAttribLocation(p, x.name); }
      for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) | 0; i < n; i++) { const x = gl.getActiveUniform(p, i); o.u[x.name] = gl.getUniformLocation(p, x.name); }
      return o;
    }
    _tex(src) {
      const gl = this.gl, t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      if (src) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      return t;
    }
    _initGL() {
      const gl = this.gl, deriv = !!gl.getExtension('OES_standard_derivatives');
      this._u32 = !!gl.getExtension('OES_element_index_uint');      // erlaubt ein Relief mit mehr als 65 000 Punkten
      this.P = { sky: this._prog(VS_SKY, FS_SKY), ter: this._prog(VS_TER, FS_TER(deriv)), line: this._prog(VS_LINE, FS_LINE), flat: this._prog(VS_FLAT, FS_FLAT), cld: this._prog(VS_CLD, FS_CLD) };
      this.B = { sky: gl.createBuffer(), ter: gl.createBuffer(), sh: gl.createBuffer(), idx: gl.createBuffer(), cld: gl.createBuffer(), cldF: gl.createBuffer(), cldI: gl.createBuffer() };
      gl.bindBuffer(gl.ARRAY_BUFFER, this.B.sky); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      this.X = { ov0: this._tex(), ov1: this._tex(), dr: this._tex(), cov: this._tex(), noise: gl.createTexture() };
      gl.bindTexture(gl.TEXTURE_2D, this.X.noise);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 128, 128, 0, gl.RGBA, gl.UNSIGNED_BYTE, Scene._noise ||= noiseData());
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.generateMipmap(gl.TEXTURE_2D);
      if (this._cl) this._cl.dirty = true;
      for (const m of [this.lines, this.tris]) for (const v of m.values()) v.buf = null;
    }
    /** Alles, was im Speicher der App liegt, (wieder) auf die Grafikkarte laden. */
    _upload() {
      const gl = this.gl;
      if (!this.V) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.B.ter); gl.bufferData(gl.ARRAY_BUFFER, this.V, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.B.sh); gl.bufferData(gl.ARRAY_BUFFER, this.SH, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.B.idx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.I, gl.STATIC_DRAW);
      if (this._ov.src) { gl.deleteTexture(this.X.ov1); this.X.ov1 = this._tex(this._ov.src); }
      if (this._drape.src) this._drapeTex(this._drape.src);
    }

    /* ---- Ausschnitt: runde Scheibe mit Radius (m) um lat/lon */
    /** dem: feines Höhenmodell aus AFC3D.loadDem (sonst das grobe Raster). n: Punkte je Seite (ohne Angabe passend zur Auflösung). */
    setArea({ lat, lon, radius, n, dem = null }) {
      const g = this.g, coarse = samplers(g).smooth, nMax = this._u32 ? 301 : 255;
      this.dem = dem;
      this.ground = dem ? (la, lo) => (dem.has(la, lo) ? dem.at(la, lo) : coarse(la, lo)) : coarse;
      n = Math.min(nMax, n || (dem ? Math.max(141, Math.ceil(2 * radius / dem.res) | 1) : 141));
      const R = this.R = radius, N = this.N = n, s = this.step = 2 * R / (N - 1), ex = this.ex;
      this.c = { lat, lon }; this.mLon = M_LAT * Math.cos(lat * D2R);
      const H = this.H = new Float32Array(N * N), V = this.V = new Float32Array(N * N * 12);
      // Kartenkacheln für das Kartenbild: Zoomstufe so, dass höchstens 8 Kacheln nebeneinander liegen
      let z = 16; while (z > 8 && 2 * R / (40075016 * Math.cos(lat * D2R) / 2 ** z) > 6.4) z--;
      const mx = lo => (lo + 180) / 360 * 2 ** z, my = la => (1 - Math.log(Math.tan(la * D2R) + 1 / Math.cos(la * D2R)) / Math.PI) / 2 * 2 ** z;
      const laN = lat + R / M_LAT, laS = lat - R / M_LAT, loW = lon - R / this.mLon, loE = lon + R / this.mLon;
      const tl = this.tiles = { z, x0: Math.floor(mx(loW)), x1: Math.floor(mx(loE)), y0: Math.floor(my(laN)), y1: Math.floor(my(laS)) };
      tl.nx = tl.x1 - tl.x0 + 1; tl.ny = tl.y1 - tl.y0 + 1;
      for (let j = 0; j < N; j++) {
        const la = lat + (R - j * s) / M_LAT;
        for (let i = 0; i < N; i++) H[j * N + i] = this.ground(la, lon + (-R + i * s) / this.mLon);
      }
      const hAt = (i, j) => H[clamp(j, 0, N - 1) * N + clamp(i, 0, N - 1)];
      const lk = lakes(g);
      let lo = Infinity, hi = -Infinity;
      for (let j = 0; j < N; j++) {
        const zc = -R + j * s, la = lat - zc / M_LAT;
        for (let i = 0; i < N; i++) {
          const k = j * N + i, o = k * 12, xc = -R + i * s, lon2 = lon + xc / this.mLon, h = H[k];
          if (h < lo) lo = h; if (h > hi) hi = h;
          let nx = (hAt(i - 1, j) - hAt(i + 1, j)) * ex, ny = 2 * s, nz = (hAt(i, j - 1) - hAt(i, j + 1)) * ex; const l = Math.hypot(nx, ny, nz);
          const gx = (lon2 - g.lo0) / g.dlo, gy = (la - g.la0) / g.dla;
          V[o] = xc; V[o + 1] = h * ex; V[o + 2] = zc; V[o + 3] = nx / l; V[o + 4] = ny / l; V[o + 5] = nz / l;
          V[o + 6] = (gx + 0.5) / g.nx; V[o + 7] = (g.ny - 0.5 - gy) / g.ny;
          V[o + 8] = (mx(lon2) - tl.x0) / tl.nx; V[o + 9] = (my(la) - tl.y0) / tl.ny;
          // Wölbung in zwei Massstäben (kleine Rippen und ganze Grate): hebt die Geländeform hervor
          V[o + 11] = clamp(1.3 * (h - (hAt(i - 1, j) + hAt(i + 1, j) + hAt(i, j - 1) + hAt(i, j + 1)) / 4) / s + 1.1 * (h - (hAt(i - 4, j) + hAt(i + 4, j) + hAt(i, j - 4) + hAt(i, j + 4)) / 4) / (4 * s), -1, 1);
          if (dem) V[o + 10] = Math.max(Math.abs(hAt(i - 1, j) - h), Math.abs(hAt(i + 1, j) - h), Math.abs(hAt(i, j - 1) - h), Math.abs(hAt(i, j + 1) - h)) < 0.05 ? 1 : 0;   // Seen sind im feinen Modell völlig eben
          else { const x0 = clamp(Math.floor(gx), 0, g.nx - 2), y0 = clamp(Math.floor(gy), 0, g.ny - 2), tx = clamp(gx - x0, 0, 1), ty = clamp(gy - y0, 0, 1), q = y0 * g.nx + x0;
            V[o + 10] = (lk[q] * (1 - tx) + lk[q + 1] * tx) * (1 - ty) + (lk[q + g.nx] * (1 - tx) + lk[q + g.nx + 1] * tx) * ty; }
        }
      }
      this.hMin = lo; this.hMax = hi;
      const I = this.I = new (N * N > 65535 ? Uint32Array : Uint16Array)((N - 1) * (N - 1) * 6);
      for (let j = 0, q = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) { const a = j * N + i, b = a + 1, c2 = a + N, d = c2 + 1; I[q++] = a; I[q++] = c2; I[q++] = b; I[q++] = b; I[q++] = c2; I[q++] = d; }
      this.SH = new Float32Array(N * N).fill(1);
      this._shadow();
      this.cam.t = [0, this.ground(lat, lon) * ex, 0];
      if (this._cl) this._cl.dirty = true;
      this._upload(); this.invalidate();
    }
    toLocal(lat, lon, alt) { return [(lon - this.c.lon) * this.mLon, (alt ?? this.ground(lat, lon)) * this.ex, -(lat - this.c.lat) * M_LAT]; }
    toGeo(x, z) { return [this.c.lat - z / M_LAT, this.c.lon + x / this.mLon]; }

    /* ---- Sonne: Richtung, Farbe und Schattenwurf der Berge (je Geländepunkt, weichgezeichnet) */
    setSun(pos) { if (!pos) return; this.sun = { az: pos.az, elev: pos.elev }; if (this.H) { this._shadow(); const gl = this.gl; gl.bindBuffer(gl.ARRAY_BUFFER, this.B.sh); gl.bufferData(gl.ARRAY_BUFFER, this.SH, gl.DYNAMIC_DRAW); } this.invalidate(); }
    _shadow() {
      const { N, H, step: s, R } = this, e = this.sun.elev, out = this.SH;
      if (e <= 0.3) { out.fill(0); return; }
      // dichtes Relief: nur jeden zweiten Punkt rechnen und dazwischen mitteln (gleich schnell wie beim groben Relief)
      const q = N > 190 ? 2 : 1, M = Math.floor((N - 1) / q) + 1;
      const tan = Math.tan(e * D2R), sx = Math.sin(this.sun.az * D2R), sz = -Math.cos(this.sun.az * D2R), d0 = Math.max(s * q, 120);
      const tmp = this._shTmp?.length === M * M ? this._shTmp : (this._shTmp = new Float32Array(M * M)), sm = this._shSm?.length === M * M ? this._shSm : (this._shSm = new Float32Array(M * M));
      const top = Math.max(this.hMax, 4300);
      for (let b = 0; b < M; b++) for (let a = 0; a < M; a++) {
        const i = Math.min(N - 1, a * q), j = Math.min(N - 1, b * q), h0 = H[j * N + i], x0 = -R + i * s, z0 = -R + j * s;
        let lit = 1;
        for (let d = d0; d < 9000; d += d0 * (1 + d / 3000)) {
          const need = h0 + d * tan + 18;
          if (need > top) break;
          const x = x0 + sx * d, z = z0 + sz * d;
          const hh = Math.abs(x) < R && Math.abs(z) < R ? this._meshH(x, z) : this._fast(this.c.lat - z / M_LAT, this.c.lon + x / this.mLon);
          if (hh > need) { lit = 0; break; }
        }
        tmp[b * M + a] = lit;
      }
      for (let b = 0; b < M; b++) for (let a = 0; a < M; a++) {
        let v = 0, n = 0;
        for (let db = -1; db <= 1; db++) for (let da = -1; da <= 1; da++) { const bb = b + db, aa = a + da; if (bb >= 0 && aa >= 0 && bb < M && aa < M) { v += tmp[bb * M + aa]; n++; } }
        sm[b * M + a] = v / n;
      }
      if (q === 1) { out.set(sm); return; }
      for (let j = 0; j < N; j++) {
        const fb = Math.min(M - 1.001, j / q), b = fb | 0, tb = fb - b;
        for (let i = 0; i < N; i++) {
          const fa = Math.min(M - 1.001, i / q), a = fa | 0, ta = fa - a, k = b * M + a;
          out[j * N + i] = (sm[k] * (1 - ta) + sm[k + 1] * ta) * (1 - tb) + (sm[k + M] * (1 - ta) + sm[k + M + 1] * ta) * tb;
        }
      }
    }
    _meshH(x, z) {
      const { N, H, step: s, R } = this, fx = clamp((x + R) / s, 0, N - 1.001), fz = clamp((z + R) / s, 0, N - 1.001), i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, k = j * N + i;
      return (H[k] * (1 - tx) + H[k + 1] * tx) * (1 - tz) + (H[k + N] * (1 - tx) + H[k + N + 1] * tx) * tz;
    }

    /* ---- Ebene über dem Gelände (Bild über das ganze Raster, Norden oben), weich überblendet */
    setOverlay(canvas, ms = 450) {
      const gl = this.gl, o = this._ov;
      if (!canvas && !o.on) return;
      const old = this.X.ov0; this.X.ov0 = this.X.ov1; gl.deleteTexture(old);
      this.X.ov1 = this._tex(canvas || null);
      o.src = canvas || null; o.on = !!canvas;
      o.mix = 0; o.t0 = performance.now(); o.ms = Math.max(1, ms);
      this.invalidate();
    }

    /* ---- Kartenbild (Kacheln, z.B. swisstopo) über das Relief legen; ohne Netz bleibt das gezeichnete Relief */
    setDrape(tpl, sub = 'abc') {
      const t = this.tiles, tok = this._drape.tok = (this._drape.tok || 0) + 1;
      if (!tpl || !t || t.nx * t.ny > 64) return Promise.resolve(false);
      const size = Math.max(t.nx, t.ny) > 4 ? 2048 : 1024, cv = document.createElement('canvas'); cv.width = cv.height = size;
      const ctx = cv.getContext('2d'), w = size / t.nx, h = size / t.ny;
      let ok = 0, bad = 0; const total = t.nx * t.ny;
      return new Promise(res => {
        const end = () => {
          if (ok + bad < total || tok !== this._drape.tok || this._dead) return;
          if (bad > total * 0.15) return res(false);
          try { this._drape.src = cv; this._drapeTex(cv); this._drape.ok = true; this._drape.t0 = performance.now(); this.invalidate(); res(true); } catch { this._drape.src = null; res(false); }
        };
        for (let y = 0; y < t.ny; y++) for (let x = 0; x < t.nx; x++) {
          const im = new Image(); im.crossOrigin = 'anonymous'; im.decoding = 'async';
          im.onload = () => { try { ctx.drawImage(im, Math.floor(x * w), Math.floor(y * h), Math.ceil(w), Math.ceil(h)); ok++; } catch { bad++; } end(); };
          im.onerror = () => { bad++; end(); };
          im.src = tpl.replace('{z}', t.z).replace('{x}', t.x0 + x).replace('{y}', t.y0 + y).replace('{s}', sub[(x + y) % sub.length]);
        }
        setTimeout(() => { if (ok + bad < total) { bad = total - ok; end(); } }, 9000);
      });
    }
    _drapeTex(cv) {
      const gl = this.gl;
      gl.deleteTexture(this.X.dr); this.X.dr = this._tex(cv);
      gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    }
    get draped() { return this._drape.ok; }

    /* ---- Wolken und Nebelmeer: Schalen aus durchscheinenden Flächen auf Höhe der Basis, vom Wind verschoben */
    /**
     * c: { cover: 0–1 oder { grid, v: [0–100 je Rasterpunkt] }, base: m ü. M. (Zahl oder Liste je Rasterpunkt), fog: Obergrenze
     * des Nebelmeers in m oder null, fogCover: wie cover (wo der Nebel liegt), wind: [u, v] km/h }. null blendet alles aus.
     */
    setClouds(c, ms = 700) {
      const cl = this._cl ||= { cur: null, from: null, to: null, t0: 0, ms: 1, off: [0.13, 0.71], wind: [0, 0], time: null, dirty: true };
      const prev = cl.cur, g = c ? (c.cover?.grid || c.fogCover?.grid || null) : (prev?.g || null), n = g ? g.nx * g.ny : 1;
      const fill = (src, def, k) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) { const v = src == null ? def : typeof src === 'number' ? src : (src.v ? src.v[i] : src[i]); a[i] = (Number.isFinite(v) ? v : def) * k; } return a; };
      let to;
      if (!c) to = prev ? { ...prev, an: 0 } : null;
      else {
        const base = fill(c.base, NaN, 1), has = base.some(Number.isFinite);
        const mean = has ? base.reduce((a, v) => a + (Number.isFinite(v) ? v : 0), 0) / base.filter(Number.isFinite).length : (prev ? prev.base[0] : 2500);
        for (let i = 0; i < n; i++) if (!Number.isFinite(base[i])) base[i] = mean;
        const cov = fill(c.cover, 0, c.cover?.v ? 0.01 : 1).map(v => clamp(v, 0, 1));
        to = { g, n, cov, fogc: fill(c.fogCover, 1, c.fogCover?.v ? 0.01 : 1).map(v => clamp(v, 0, 1)), base, fogTop: c.fog ?? prev?.fogTop ?? 1000, fogA: c.fog != null ? 1 : 0, deckA: has && cov.some(v => v > 0.02) ? 1 : 0, an: 1 };
        if (c.wind) cl.wind = [c.wind[0] || 0, c.wind[1] || 0];
      }
      if (!to) return;
      const same = prev && prev.n === to.n && (prev.g?.nx || 0) === (to.g?.nx || 0);
      // weicher Übergang: vom jetzigen Stand zum neuen; die Höhe einer Schicht, die erst erscheint, wird nicht «hergefahren»
      cl.from = same ? { ...prev, base: prev.deckA * prev.an > 0.02 ? prev.base : to.base, fogTop: prev.fogA * prev.an > 0.02 ? prev.fogTop : to.fogTop } : { ...to, an: 0 };
      cl.to = to; cl.t0 = performance.now(); cl.ms = Math.max(1, ms); cl.cur = null;
      this._cloudStep(ms <= 1);
      this.invalidate();
    }
    /** Stand der Wolken für dieses Bild (zwischen altem und neuem Zustand gemischt). true, solange der Übergang läuft. */
    _cloudStep(end) {
      const cl = this._cl;
      if (!cl?.to) return false;
      const k = end ? 1 : ease(clamp((performance.now() - cl.t0) / cl.ms, 0, 1)), a = cl.from, b = cl.to;
      if (cl.cur && cl.k === k) return k < 1;
      const mix = (x, y) => x + (y - x) * k, arr = (x, y) => (k >= 1 ? y : x.map((v, i) => v + (y[i] - v) * k));
      cl.cur = { g: b.g, n: b.n, cov: arr(a.cov, b.cov), fogc: arr(a.fogc, b.fogc), base: arr(a.base, b.base), fogTop: mix(a.fogTop, b.fogTop), fogA: mix(a.fogA, b.fogA), deckA: mix(a.deckA, b.deckA), an: mix(a.an, b.an) };
      cl.k = k; cl.dirty = true;
      return k < 1;
    }
    /** Bedeckung als kleine Textur und die Wolkenfläche (Höhe der Basis je Punkt) auf die Grafikkarte laden. */
    _cloudUpload() {
      const gl = this.gl, cl = this._cl, c = cl.cur, g = c.g, nx = g ? g.nx : 1, ny = g ? g.ny : 1, px = new Uint8Array(nx * ny * 4);
      for (let i = 0; i < nx * ny; i++) { px[i * 4] = Math.round(c.cov[i] * 255); px[i * 4 + 1] = Math.round(c.fogc[i] * 255); px[i * 4 + 3] = 255; }
      gl.bindTexture(gl.TEXTURE_2D, this.X.cov); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, nx, ny, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const M = 33, R = this.R, V = new Float32Array(M * M * 3), F = new Float32Array(M * M * 3);
      const baseAt = (la, lo) => {
        if (!g) return c.base[0];
        const fx = clamp((lo - g.lo0) / g.dlo, 0, g.nx - 1.001), fy = clamp((la - g.la0) / g.dla, 0, g.ny - 1.001), x = fx | 0, y = fy | 0, tx = fx - x, ty = fy - y, k = y * g.nx + x;
        return (c.base[k] * (1 - tx) + c.base[k + 1] * tx) * (1 - ty) + (c.base[k + g.nx] * (1 - tx) + c.base[k + g.nx + 1] * tx) * ty;
      };
      let sum = 0;
      for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
        const o = (j * M + i) * 3, x = -R + i * 2 * R / (M - 1), z = -R + j * 2 * R / (M - 1), geo = this.toGeo(x, z), b = baseAt(geo[0], geo[1]);
        V[o] = F[o] = x; V[o + 2] = F[o + 2] = z; V[o + 1] = b * this.ex; sum += b;
      }
      cl.mean = sum / (M * M);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.B.cld); gl.bufferData(gl.ARRAY_BUFFER, V, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.B.cldF); gl.bufferData(gl.ARRAY_BUFFER, F, gl.STATIC_DRAW);
      const I = new Uint16Array((M - 1) * (M - 1) * 6);
      for (let j = 0, q = 0; j < M - 1; j++) for (let i = 0; i < M - 1; i++) { const a = j * M + i, b = a + 1, c2 = a + M, d = c2 + 1; I[q++] = a; I[q++] = c2; I[q++] = b; I[q++] = b; I[q++] = c2; I[q++] = d; }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.B.cldI); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, I, gl.STATIC_DRAW);
      cl.nI = I.length;
      // Rasterpunkt aus der Lage in der Szene: u = x·a + b, v = z·c + d
      cl.cv = g ? [1 / (this.mLon * g.dlo * g.nx), -1 / (M_LAT * g.dla * g.ny), ((this.c.lon - g.lo0) / g.dlo + 0.5) / g.nx, ((this.c.lat - g.la0) / g.dla + 0.5) / g.ny] : [0, 0, 0.5, 0.5];
      cl.dirty = false;
    }
    /** Was gerade zu sehen ist: { base, cover, fog } oder null (für Anzeigen der App). */
    get clouds() { const c = this._cl?.to; return c && c.an > 0.5 && (c.deckA > 0.5 || c.fogA > 0.5) ? { base: c.base.reduce((a, v) => a + v, 0) / c.n, deck: c.deckA > 0.5, fog: c.fogA > 0.5 ? c.fogTop : null } : null; }

    /* ---- Linien: Bänder mit fester Breite am Bildschirm. lines: [{ pts: [[lat, lon, alt]], color, colors, width, speed, agl }] */
    setLines(key, lines, o = {}) {
      if (!lines || !lines.length) { const old = this.lines.get(key); if (old?.buf) this.gl.deleteBuffer(old.buf); this.lines.delete(key); return this.invalidate(); }
      let segs = 0; for (const l of lines) segs += Math.max(0, l.pts.length - 1);
      const A = new Float32Array(segs * 6 * 14); let q = 0;
      const put = (p, o2, side, d, hw, c, sp) => { A[q++] = p[0]; A[q++] = p[1]; A[q++] = p[2]; A[q++] = o2[0]; A[q++] = o2[1]; A[q++] = o2[2]; A[q++] = side; A[q++] = d; A[q++] = hw; A[q++] = c[0]; A[q++] = c[1]; A[q++] = c[2]; A[q++] = c[3]; A[q++] = sp; };
      for (const l of lines) {
        const P = l.pts.map(p => this.toLocal(p[0], p[1], p[2] == null ? this.ground(p[0], p[1]) + (l.agl ?? 6) : p[2]));
        const col = rgba(l.color || '#ffffff'), hw = (l.width || 3) / 2 + 0.75, sp = l.speed ?? 0.35;
        let d = l.phase || 0;
        for (let i = 0; i < P.length - 1; i++) {
          const a = P[i], b = P[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
          const ca = l.colors ? rgba(l.colors[i]) : col, cb = l.colors ? rgba(l.colors[i + 1]) : col;
          // zwei Dreiecke je Abschnitt; Betrag 2 markiert das zweite Ende (dort ist die Richtung gespiegelt)
          put(a, b, -1, d, hw, ca, sp); put(a, b, 1, d, hw, ca, sp); put(b, a, 2, d + len, hw, cb, sp);
          put(a, b, -1, d, hw, ca, sp); put(b, a, 2, d + len, hw, cb, sp); put(b, a, -2, d + len, hw, cb, sp);
          d += len;
        }
      }
      const old = this.lines.get(key); if (old?.buf) this.gl.deleteBuffer(old.buf);
      this.lines.set(key, { data: A, n: segs * 6, buf: null, xray: !!o.xray, flow: o.flow || 0, dash: o.dash || 0, alpha: o.alpha ?? 1, bias: o.bias ?? 0.0006 });
      this.invalidate();
    }
    /** Flächen aus Dreiecken: verts = [x, y, z, r, g, b, a, …] in Szenen-Koordinaten (toLocal). */
    setTris(key, verts, o = {}) {
      const old = this.tris.get(key); if (old?.buf) this.gl.deleteBuffer(old.buf);
      if (!verts || !verts.length) { this.tris.delete(key); return this.invalidate(); }
      this.tris.set(key, { data: verts instanceof Float32Array ? verts : new Float32Array(verts), n: verts.length / 7, buf: null, alpha: o.alpha ?? 1 });
      this.invalidate();
    }
    /** Vorhang von einer Linie in der Luft bis zum Boden (macht die Flughöhe sichtbar). */
    curtain(pts, color, aTop = 0.26, aBot = 0.03) {
      const c = rgba(color), v = [];
      const P = pts.map(p => [this.toLocal(p[0], p[1], p[2]), this.toLocal(p[0], p[1], Math.min(p[2], this.ground(p[0], p[1])))]);
      for (let i = 0; i < P.length - 1; i++) {
        const [a, a0] = P[i], [b, b0] = P[i + 1];
        v.push(...a, c[0], c[1], c[2], aTop, ...a0, c[0], c[1], c[2], aBot, ...b, c[0], c[1], c[2], aTop, ...b, c[0], c[1], c[2], aTop, ...a0, c[0], c[1], c[2], aBot, ...b0, c[0], c[1], c[2], aBot);
      }
      return v;
    }
    /** Stehende Säule (z.B. Thermik): Zylindermantel von base bis top (m ü. M.), unten durchsichtiger. */
    column(lat, lon, base, top, radius, color, a = 0.42) {
      const c = rgba(color), v = [], n = 14;
      for (let i = 0; i < n; i++) {
        const t0 = i / n * 2 * Math.PI, t1 = (i + 1) / n * 2 * Math.PI, p = this.toLocal(lat, lon, 0);
        const x0 = p[0] + Math.cos(t0) * radius, z0 = p[2] + Math.sin(t0) * radius, x1 = p[0] + Math.cos(t1) * radius, z1 = p[2] + Math.sin(t1) * radius, yb = base * this.ex, yt = top * this.ex;
        v.push(x0, yt, z0, c[0], c[1], c[2], a, x0, yb, z0, c[0], c[1], c[2], a * 0.25, x1, yt, z1, c[0], c[1], c[2], a, x1, yt, z1, c[0], c[1], c[2], a, x0, yb, z0, c[0], c[1], c[2], a * 0.25, x1, yb, z1, c[0], c[1], c[2], a * 0.25);
      }
      return v;
    }

    /* ---- Beschriftungen: HTML über der Zeichenfläche, folgt dem Punkt; hinter dem Berg blass */
    setMarkers(list) {
      if (!this.lab) return;
      this.lab.textContent = '';
      this.markers = (list || []).map(m => {
        const el = document.createElement(m.act ? 'button' : 'div');
        el.className = 'v3d-m ' + (m.cls || ''); el.innerHTML = m.html;
        if (m.act) { el.type = 'button'; el.dataset.act = m.act; if (m.id != null) el.dataset.id = m.id; }
        if (m.title) el.title = m.title;
        this.lab.appendChild(el);
        return { ...m, el, bw: 0, bh: 0, p: this.toLocal(m.lat, m.lon, m.alt == null ? this.ground(m.lat, m.lon) + (m.agl ?? 0) : m.alt) };
      });
      for (const m of this.markers) { m.bw = m.el.offsetWidth; m.bh = m.el.offsetHeight; }
      this._mk = null; this.invalidate();
    }
    moveMarker(id, lat, lon, alt, html) {
      const m = this.markers.find(x => x.id === id); if (!m) return;
      m.p = this.toLocal(lat, lon, alt); if (html != null && html !== m.html) { m.html = html; m.el.innerHTML = html; }
      this.invalidate();
    }
    /** Punkt (Szenen-Koordinaten) auf den Bildschirm: { x, y } in CSS-Pixeln, null wenn hinter der Kamera. */
    project(p) {
      const m = this._mvp; if (!m) return null;
      const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      if (w <= 0.01) return null;
      const x = (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w, y = (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w;
      return { x: (x * 0.5 + 0.5) * this.w, y: (0.5 - y * 0.5) * this.h, w };
    }
    _occluded(p) {
      const e = this._eye;
      for (let i = 1; i < 20; i++) {
        const f = i / 20, x = e[0] + (p[0] - e[0]) * f, y = e[1] + (p[1] - e[1]) * f, z = e[2] + (p[2] - e[2]) * f;
        if (Math.abs(x) < this.R && Math.abs(z) < this.R && this._meshH(x, z) * this.ex > y + 25) return true;
      }
      return false;
    }
    _avoid() {
      const f = this.o.avoid, now = performance.now();
      if (!f) return [];
      if (!this._ko || now - this._koT > 400) {
        const h = this.host.getBoundingClientRect();
        this._ko = f().map(e => { const q = e && !e.hidden ? e.getBoundingClientRect() : null; return q && q.width ? [q.left - h.left, q.top - h.top, q.right - h.left, q.bottom - h.top] : null; }).filter(Boolean);
        this._koT = now;
      }
      return this._ko;
    }
    _place() {
      const key = this._eye.join() + this.w, moved = key !== this._mk; this._mk = key;
      for (const m of this.markers) {
        const s = this.project(m.p);
        if (!s || s.x < -40 || s.y < -40 || s.x > this.w + 40 || s.y > this.h + 40) { if (!m.off) { m.el.style.display = 'none'; m.off = true; } continue; }
        if (m.off) { m.el.style.display = ''; m.off = false; }
        m.el.style.transform = `translate(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px) translate(-50%,${m.center ? '-50%' : '-100%'})`;
        if (moved || m.dirty !== false) { const oc = m.air ? false : this._occluded(m.p); if (oc !== m.oc) { m.oc = oc; m.el.classList.toggle('behind', oc); } m.dirty = false; }
        m.sx = s.x; m.sy = s.y;
      }
      // Gedränge: weiter vorn in der Liste hat Vorrang, spätere Beschriftungen weichen (Klasse «crowd»);
      // unter Anzeigen und Knöpfen über dem Bild (o.avoid) blenden Beschriftungen aus (Klasse «kout»)
      const rects = [], ko = this._avoid(), cut = (r, q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1];
      for (const m of this.markers) {
        if (m.off) continue;
        const r = [m.sx - m.bw / 2 - 3, m.center ? m.sy - m.bh / 2 : m.sy - m.bh - 2, m.sx + m.bw / 2 + 3, m.center ? m.sy + m.bh / 2 : m.sy + 2];
        const out = !m.center && ko.some(q => cut([r[0] + 9, r[1] + 8, r[2] - 9, r[3] - 4], q));
        if (out !== !!m.kout) { m.kout = out; m.el.classList.toggle('kout', out); }
        if (out) continue;
        const hit = !!m.yield && rects.some(q => cut(r, q));
        if (hit !== !!m.crowd) { m.crowd = hit; m.el.classList.toggle('crowd', hit); }
        if (!hit) rects.push(r);
      }
    }

    /* ---- Kamera */
    _eyePos() {
      const c = this.cam, a = c.az * D2R, e = c.el * D2R, h = c.dist * Math.cos(e);
      return [c.t[0] - Math.sin(a) * h, c.t[1] + c.dist * Math.sin(e), c.t[2] + Math.cos(a) * h];
    }
    _clampCam() {
      const c = this.cam, R = this.R;
      c.el = clamp(c.el, 5, 88); c.dist = clamp(c.dist, R * 0.1, R * 3.4);
      const r = Math.hypot(c.t[0], c.t[2]); if (r > R * 0.85) { c.t[0] *= R * 0.85 / r; c.t[2] *= R * 0.85 / r; }
      // nie unter das Gelände: Kamera notfalls anheben
      for (let i = 0; i < 6; i++) {
        const e = this._eyePos();
        if (Math.abs(e[0]) > this.R || Math.abs(e[2]) > this.R || e[1] > this._meshH(e[0], e[2]) * this.ex + 60) break;
        c.el = Math.min(88, c.el + 4);
      }
    }
    /** Freie Kamera (Pilotensicht): { lat, lon, alt, yaw, pitch, roll } in Grad, yaw wie ein Kompass. null: zurück zur Sicht von aussen. */
    setPov(o) {
      if (!o) { if (this.pov) { this.pov = null; this._mk = null; this.invalidate(); } return; }
      const p = this.pov || (this.pov = { look: [0, 0], held: 0, rel: 0 }), e = this.toLocal(o.lat, o.lon, o.alt);
      if (Math.abs(e[0]) < this.R && Math.abs(e[2]) < this.R) e[1] = Math.max(e[1], (this._meshH(e[0], e[2]) + 8) * this.ex);   // nie im Gelände
      p.eye = e; p.yaw = o.yaw || 0; p.pitch = o.pitch ?? -10; p.roll = o.roll || 0;
      this.invalidate();
    }
    /** Blickrichtung als Kompasskurs. */
    get heading() { return this.pov ? this.pov.yaw + this.pov.look[0] : this.cam.az; }
    /** Kamera weich an einen Ort fliegen. to: { lat, lon, alt, az, el, dist } (nur Angegebenes ändert sich). */
    flyTo(to, ms = 1200) {
      const c = this.cam, t = to.lat != null ? this.toLocal(to.lat, to.lon, to.alt) : c.t.slice();
      const goal = { t, az: to.az ?? c.az, el: to.el ?? c.el, dist: to.dist ?? c.dist };
      if (ms <= 0) { Object.assign(c, goal); this._fly = null; this._clampCam(); return this.invalidate(); }
      this._fly = { from: { t: c.t.slice(), az: c.az, el: c.el, dist: c.dist }, to: goal, t0: performance.now(), ms };
      this.invalidate();
    }
    _controls() {
      const c = this.canvas, pts = new Map();
      let last = null, moved = 0;
      const stop = () => { this._fly = null; this.orbit = 0; this.onUser?.(); };
      const spin = !!this.o.spin, held = () => { if (this.pov) { this.pov.held = pts.size; this.pov.rel = performance.now(); } };
      c.style.touchAction = spin ? 'pan-y' : 'none';
      const down = e => { c.setPointerCapture?.(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); last = null; moved = 0; this._vel = [0, 0]; stop(); held(); };
      const move = e => {
        if (!pts.has(e.pointerId)) return;
        const prev = pts.get(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]);
        const cam = this.cam, pv = this.pov;
        if (pv) {
          // Pilotensicht: ziehen heisst umschauen
          if (pts.size === 1) { const dx = e.clientX - prev[0], dy = e.clientY - prev[1]; moved += Math.abs(dx) + Math.abs(dy); pv.look[0] = clamp(pv.look[0] - dx * 0.25, -160, 160); pv.look[1] = clamp(pv.look[1] + dy * 0.2, -55, 40); }
        } else if (spin) {
          const dx = e.clientX - prev[0]; moved += Math.abs(dx) + Math.abs(e.clientY - prev[1]);
          if (pts.size === 1) { cam.az -= dx * 0.45; this._vel = [-dx * 0.45, 0]; }
        } else if (pts.size === 1) {
          const dx = e.clientX - prev[0], dy = e.clientY - prev[1]; moved += Math.abs(dx) + Math.abs(dy);
          if (e.shiftKey || e.buttons === 2) this._pan(dx, dy);
          else { cam.az -= dx * 0.35; cam.el += dy * 0.28; this._vel = [-dx * 0.35, dy * 0.28]; }
        } else if (pts.size === 2) {
          const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
          if (last) { cam.dist *= clamp(last.d / Math.max(20, d), 0.8, 1.25); this._pan(mx - last.mx, my - last.my); cam.az -= ((ang - last.ang + 3 * Math.PI) % (2 * Math.PI) - Math.PI) / D2R; }
          last = { d: Math.max(20, d), mx, my, ang };
        }
        this._clampCam(); this.invalidate();
      };
      const up = e => { const had = pts.delete(e.pointerId); last = null; held(); if (had && e.type === 'pointerup' && pts.size === 0 && moved < 6) this.onTap?.(e); this.invalidate(); };
      c.addEventListener('pointerdown', down); c.addEventListener('pointermove', move); c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
      c.addEventListener('contextmenu', e => e.preventDefault());
      if (spin) { c.addEventListener('keydown', e => { const k = { ArrowLeft: 10, ArrowRight: -10 }[e.key]; if (k) { e.preventDefault(); stop(); this.cam.az += k; this.invalidate(); } }); return; }
      c.addEventListener('wheel', e => { e.preventDefault(); if (this.pov) return; stop(); this.cam.dist *= Math.exp(clamp(e.deltaY, -120, 120) * 0.0016); this._clampCam(); this.invalidate(); }, { passive: false });
      c.addEventListener('keydown', e => {
        const k = { ArrowLeft: [8, 0, 1], ArrowRight: [-8, 0, 1], ArrowUp: [0, 5, 1], ArrowDown: [0, -5, 1], '+': [0, 0, 0.85], '=': [0, 0, 0.85], '-': [0, 0, 1.18] }[e.key];
        if (!k) return;
        if (this.pov) { e.preventDefault(); const pv = this.pov; pv.look[0] = clamp(pv.look[0] - k[0] * 1.5, -160, 160); pv.look[1] = clamp(pv.look[1] + k[1] * 1.5, -55, 40); pv.rel = performance.now(); return this.invalidate(); }
        e.preventDefault(); stop(); this.cam.az += k[0]; this.cam.el += k[1]; this.cam.dist *= k[2]; this._clampCam(); this.invalidate();
      });
    }
    _pan(dx, dy) {
      const c = this.cam, a = c.az * D2R, k = c.dist / this.h * 1.1, ky = k / Math.max(0.35, Math.sin(c.el * D2R));
      c.t[0] += (-Math.cos(a) * dx * k) + (-Math.sin(a) * -dy * ky);
      c.t[2] += (-Math.sin(a) * dx * k) + (Math.cos(a) * -dy * ky);
      const g = this.toGeo(c.t[0], c.t[2]); c.t[1] += (this.ground(g[0], g[1]) * this.ex - c.t[1]) * 0.25;
    }
    get flying() { return !!this._fly; }
    zoom(f) { this._fly = null; this.flyTo({ dist: clamp(this.cam.dist * f, this.R * 0.1, this.R * 3.4) }, 260); }

    /* ---- Zeichnen */
    invalidate() { if (!this._raf && !this._dead && !this._gone && !this.o.manual) this._raf = requestAnimationFrame(t => this._loop(t)); }
    _loop(ts) {
      this._raf = 0;
      if (this._dead || this._gone) return;
      const dt = Math.min(80, ts - (this._last || ts)); this._last = ts;
      let busy = false; const c = this.cam;
      if (this._fly) {
        const f = this._fly, k = ease(clamp((performance.now() - f.t0) / f.ms, 0, 1));
        for (let i = 0; i < 3; i++) c.t[i] = f.from.t[i] + (f.to.t[i] - f.from.t[i]) * k;
        c.az = lerpDeg(f.from.az, f.to.az, k); c.el = f.from.el + (f.to.el - f.from.el) * k; c.dist = f.from.dist * Math.pow(f.to.dist / f.from.dist, k);
        if (k >= 1) this._fly = null; else busy = true;
      } else if (Math.abs(this._vel[0]) + Math.abs(this._vel[1]) > 0.02) {
        c.az += this._vel[0]; c.el += this._vel[1]; this._vel[0] *= 0.92; this._vel[1] *= 0.86; this._clampCam(); busy = true;
      }
      if (this.orbit) { c.az += this.orbit * dt / 1000; busy = true; }
      const pv = this.pov;
      if (pv && !pv.held && (pv.look[0] || pv.look[1])) {
        if (performance.now() - pv.rel > 900) { const k = Math.pow(0.9, dt / 16); pv.look[0] *= k; pv.look[1] *= k; if (Math.abs(pv.look[0]) + Math.abs(pv.look[1]) < 0.15) pv.look = [0, 0]; }
        busy = true;
      }
      const o = this._ov;
      if (o.mix < 1) { o.mix = clamp((performance.now() - o.t0) / o.ms, 0, 1); busy = busy || o.mix < 1; }
      const d = this._drape;
      if (d.ok && d.a < 1) { d.a = clamp((performance.now() - d.t0) / 700, 0, 1); busy = true; }
      if (this._cloudStep()) busy = true;
      if (this.onFrame && this.onFrame(ts, dt)) busy = true;
      if (this.flowing) { this.time += dt / 1000; busy = true; }
      this._draw();
      if (busy) this.invalidate(); else this._last = 0;
    }
    _size() {
      const cv = this.canvas, o = this.o;
      const w = o.size ? o.size[0] : Math.max(2, this.host.clientWidth), h = o.size ? o.size[1] : Math.max(2, this.host.clientHeight);
      const dpr = o.size ? 1 : Math.min(2, window.devicePixelRatio || 1), pw = Math.round(w * dpr), ph = Math.round(h * dpr);
      if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
      this.w = w; this.h = h;
    }
    _draw() {
      const gl = this.gl;
      if (!this.V || gl.isContextLost()) return;
      this._size();
      const cv = this.canvas, c = this.cam, pv = this.pov;
      let eye, at = c.t, near, far, fov = this.o.fov || 38, fogA = c.dist * 1.1;
      if (pv) {
        const yw = (pv.yaw + pv.look[0]) * D2R, pt = clamp(pv.pitch + pv.look[1], -80, 60) * D2R;
        eye = pv.eye; at = [eye[0] + Math.sin(yw) * Math.cos(pt), eye[1] + Math.sin(pt), eye[2] - Math.cos(yw) * Math.cos(pt)];
        near = 6; far = this.R * 6; fov = 62; fogA = this.R * 0.8;
      } else { eye = this._eyePos(); near = Math.max(20, c.dist * 0.04); far = c.dist + this.R * 5; }
      this._eye = eye;
      const mvp = this._mvp = mul(persp(fov * D2R, cv.width / cv.height, near, far), look(eye, at, pv ? pv.roll * D2R : 0));
      gl.viewport(0, 0, cv.width, cv.height);
      gl.clear(gl.DEPTH_BUFFER_BIT | gl.COLOR_BUFFER_BIT);
      const e = this.sun.elev, day = clamp(e / 12, 0, 1), low = clamp(e / 30, 0, 1);
      const night = [0.07, 0.10, 0.17], bg = this.o.bg;
      const top = bg ? bg.slice() : this.sky.top.map((v, i) => night[i] + (v - night[i]) * day), bot = bg ? bg.slice() : this.sky.bot.map((v, i) => night[i] * 1.6 + (v - night[i] * 1.6) * day);
      if (!bg && e > -4 && e < 12) { const w = 1 - Math.abs(e - 3) / 9; bot[0] += 0.22 * Math.max(0, w); bot[1] += 0.06 * Math.max(0, w); }
      // Himmel
      let P = this.P.sky; gl.useProgram(P.p); gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.B.sky); gl.enableVertexAttribArray(P.a.a_p); gl.vertexAttribPointer(P.a.a_p, 2, gl.FLOAT, false, 0, 0);
      gl.uniform3fv(P.u.u_top, top); gl.uniform3fv(P.u.u_bot, bot); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.disableVertexAttribArray(P.a.a_p);
      // Gelände
      P = this.P.ter; gl.useProgram(P.p); gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.B.ter);
      const st = 48, att = (loc, n, off) => { if (loc >= 0) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, st, off); } };
      att(P.a.a_pos, 3, 0); att(P.a.a_n, 3, 12); att(P.a.a_uv, 2, 24); att(P.a.a_duv, 2, 32); att(P.a.a_w, 1, 40); att(P.a.a_cv, 1, 44);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.B.sh); gl.enableVertexAttribArray(P.a.a_sh); gl.vertexAttribPointer(P.a.a_sh, 1, gl.FLOAT, false, 0, 0);
      const er = Math.max(e, 0) * D2R, sa = this.sun.az * D2R, sv = [Math.sin(sa) * Math.cos(er), Math.sin(er) * 1.0, -Math.cos(sa) * Math.cos(er)];
      const warm = 1 - low;
      gl.uniformMatrix4fv(P.u.u_mvp, false, mvp);
      gl.uniform3fv(P.u.u_sun, sv);
      gl.uniform3f(P.u.u_sunCol, (0.78 + 0.16 * warm) * day, (0.74 - 0.06 * warm) * day, (0.66 - 0.2 * warm) * day);
      gl.uniform3f(P.u.u_amb, 0.24 + 0.30 * day, 0.27 + 0.30 * day, 0.34 + 0.28 * day);
      gl.uniform3fv(P.u.u_eye, eye); gl.uniform3fv(P.u.u_fog, bot); gl.uniform2f(P.u.u_c, 0, 0);
      gl.uniform3f(P.u.u_f, this.R, fogA, fogA + this.R * 2.6);
      // Wolken: Stand für dieses Bild, Verschiebung mit dem Wind (zur Anschauung beschleunigt)
      const cl = this._cl, cc = cl?.cur && cl.cur.an > 0.004 && this.cloudsOn !== false ? cl.cur : null;
      let flow = false;
      if (cc) {
        if (cl.dirty || cl.R !== this.R) { this._cloudUpload(); cl.R = this.R; }
        cl.sc = clamp(this.R * 1.3, 6000, 36000);
        const dtc = this.time - (cl.time ?? this.time); cl.time = this.time;
        cl.off[0] -= cl.wind[0] / 3.6 * dtc * 14 / cl.sc; cl.off[1] += cl.wind[1] / 3.6 * dtc * 14 / cl.sc;
        if (!this.still && Math.hypot(cl.wind[0], cl.wind[1]) > 0.5) flow = true;
        const sh = e > 2 ? 1 / Math.max(Math.tan(e * D2R), 0.35) : 0;
        gl.uniform4f(P.u.u_cl, e > 2 ? cc.an * cc.deckA : 0, cl.mean * this.ex, cl.sc, cc.fogA * cc.an > 0.5 ? cc.fogTop * this.ex : 0);
        gl.uniform4fv(P.u.u_cv, cl.cv); gl.uniform2fv(P.u.u_coff, cl.off); gl.uniform2f(P.u.u_sunH, Math.sin(sa) * sh, -Math.cos(sa) * sh);
      } else gl.uniform4f(P.u.u_cl, 0, 0, 1, 0);
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.X.noise); gl.uniform1i(P.u.u_noise, 3);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.X.cov); gl.uniform1i(P.u.u_cov, 4);
      gl.uniform1f(P.u.u_ex, this.ex); gl.uniform1f(P.u.u_ovMix, this._ov.mix); gl.uniform1f(P.u.u_ovA, 1); gl.uniform1f(P.u.u_drape, this._drape.a * (this.drapeOn === false ? 0 : 1));
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.X.ov0); gl.uniform1i(P.u.u_ov0, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.X.ov1); gl.uniform1i(P.u.u_ov1, 1);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.X.dr); gl.uniform1i(P.u.u_dr, 2);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.B.idx); gl.drawElements(gl.TRIANGLES, this.I.length, this.I instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT, 0);
      for (const k in P.a) if (P.a[k] >= 0) gl.disableVertexAttribArray(P.a[k]);
      // Flächen (durchsichtig, schreiben keine Tiefe)
      gl.depthMask(false);
      if (cc) {
        // Wolken und Nebelmeer: je einige Schalen übereinander, die fernere Schicht zuerst, Berge ragen heraus
        P = this.P.cld; gl.useProgram(P.p); gl.uniformMatrix4fv(P.u.u_mvp, false, mvp);
        gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.X.noise); gl.uniform1i(P.u.u_noise, 3);
        gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, this.X.cov); gl.uniform1i(P.u.u_cov, 4);
        gl.uniform4fv(P.u.u_cv, cl.cv); gl.uniform2fv(P.u.u_off, cl.off); gl.uniform1f(P.u.u_R, this.R); gl.uniform1f(P.u.u_sc, cl.sc);
        const amb = [0.24 + 0.30 * day, 0.27 + 0.30 * day, 0.34 + 0.28 * day], sun = [(0.78 + 0.16 * warm) * day, (0.74 - 0.06 * warm) * day, (0.66 - 0.2 * warm) * day];
        gl.uniform3f(P.u.u_lit, Math.min(1, amb[0] * 0.78 + sun[0] * 0.75), Math.min(1, amb[1] * 0.78 + sun[1] * 0.75), Math.min(1, amb[2] * 0.78 + sun[2] * 0.75));
        gl.uniform3f(P.u.u_dim, amb[0] * 1.02 + 0.06 * day, amb[1] * 1.02 + 0.07 * day, amb[2] * 1.02 + 0.09 * day);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.B.cldI); gl.enableVertexAttribArray(P.a.a_pos);
        const thick = clamp(this.R * 0.045, 220, 900) * this.ex, fogT = 90 * this.ex;
        const layers = [];
        if (cc.deckA > 0.01) layers.push({ y: cl.mean * this.ex, n: 6, buf: this.B.cld, fog: 0, a: cc.an * cc.deckA, lift: k => k * thick });
        if (cc.fogA > 0.01) layers.push({ y: cc.fogTop * this.ex, n: 4, buf: this.B.cldF, fog: 1, a: cc.an * cc.fogA, lift: k => cc.fogTop * this.ex - (1 - k) * fogT });
        layers.sort((p, q2) => Math.abs(q2.y - eye[1]) - Math.abs(p.y - eye[1]));
        for (const L of layers) {
          gl.bindBuffer(gl.ARRAY_BUFFER, L.buf); gl.vertexAttribPointer(P.a.a_pos, 3, gl.FLOAT, false, 12, 0);
          gl.uniform1f(P.u.u_fog, L.fog); gl.uniform1f(P.u.u_a, L.a);
          const up = eye[1] > L.y;
          for (let i = 0; i < L.n; i++) { const k = (up ? i : L.n - 1 - i) / (L.n - 1); gl.uniform1f(P.u.u_k, k); gl.uniform1f(P.u.u_lift, L.lift(k)); gl.drawElements(gl.TRIANGLES, cl.nI, gl.UNSIGNED_SHORT, 0); }
        }
        gl.disableVertexAttribArray(P.a.a_pos);
      }
      if (this.tris.size) {
        P = this.P.flat; gl.useProgram(P.p); gl.uniformMatrix4fv(P.u.u_mvp, false, mvp);
        gl.enableVertexAttribArray(P.a.a_pos); gl.enableVertexAttribArray(P.a.a_col);
        for (const t of this.tris.values()) {
          if (!t.buf) { t.buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, t.buf); gl.bufferData(gl.ARRAY_BUFFER, t.data, gl.STATIC_DRAW); } else gl.bindBuffer(gl.ARRAY_BUFFER, t.buf);
          gl.vertexAttribPointer(P.a.a_pos, 3, gl.FLOAT, false, 28, 0); gl.vertexAttribPointer(P.a.a_col, 4, gl.FLOAT, false, 28, 12);
          gl.uniform1f(P.u.u_alpha, t.alpha); gl.drawArrays(gl.TRIANGLES, 0, t.n);
        }
        gl.disableVertexAttribArray(P.a.a_pos); gl.disableVertexAttribArray(P.a.a_col);
      }
      // Linien
      if (this.lines.size) {
        P = this.P.line; gl.useProgram(P.p); gl.uniformMatrix4fv(P.u.u_mvp, false, mvp); gl.uniform2f(P.u.u_vp, this.w, this.h); gl.uniform1f(P.u.u_time, this.time);
        const A = P.a, on = ['a_p', 'a_q', 'a_m', 'a_col', 'a_sp'].filter(k => A[k] >= 0);
        for (const k of on) gl.enableVertexAttribArray(A[k]);
        for (const l of this.lines.values()) {
          if (!l.buf) { l.buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, l.buf); gl.bufferData(gl.ARRAY_BUFFER, l.data, gl.STATIC_DRAW); } else gl.bindBuffer(gl.ARRAY_BUFFER, l.buf);
          gl.vertexAttribPointer(A.a_p, 3, gl.FLOAT, false, 56, 0); gl.vertexAttribPointer(A.a_q, 3, gl.FLOAT, false, 56, 12); gl.vertexAttribPointer(A.a_m, 3, gl.FLOAT, false, 56, 24); gl.vertexAttribPointer(A.a_col, 4, gl.FLOAT, false, 56, 36);
          if (A.a_sp >= 0) gl.vertexAttribPointer(A.a_sp, 1, gl.FLOAT, false, 56, 52);
          const fl = l.flow && !this.still ? l.flow : 0;
          gl.uniform1f(P.u.u_flow, fl); gl.uniform1f(P.u.u_dash, l.dash); gl.uniform1f(P.u.u_bias, l.bias);
          if (fl) flow = true;
          if (l.xray) { gl.disable(gl.DEPTH_TEST); gl.uniform1f(P.u.u_alpha, l.alpha * 0.22); gl.drawArrays(gl.TRIANGLES, 0, l.n); gl.enable(gl.DEPTH_TEST); }
          gl.uniform1f(P.u.u_alpha, l.alpha); gl.drawArrays(gl.TRIANGLES, 0, l.n);
        }
        for (const k of on) gl.disableVertexAttribArray(A[k]);
      }
      gl.depthMask(true);
      this.flowing = flow;
      if (this.lab) this._place();
      this.onDraw?.();
    }
    /** Sofort zeichnen (für Clips, die das Bild gleich weiterverwenden). */
    renderNow(dt = 0) { if (this._dead || this._gone) return; this.time += dt; if (this.orbit) this.cam.az += this.orbit * dt; this._ov.mix = 1; if (this._drape.ok) this._drape.a = 1; this._cloudStep(true); this._draw(); }

    destroy() {
      this._dead = true; cancelAnimationFrame(this._raf); this._ro?.disconnect();
      this.canvas.removeEventListener('webglcontextlost', this._lost); this.canvas.removeEventListener('webglcontextrestored', this._back);
      try { this.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* schon weg */ }
      this.canvas.remove(); this.lab?.remove();
    }
  }

  /** Sonnenstand (NOAA-Näherung, wie lib/util.js): { elev, az } in Grad. */
  function sunAt(ms, latDeg, lonDeg) {
    const jd = ms / 86400000 + 2440587.5, T = (jd - 2451545) / 36525, Mr = ((357.52911 + 35999.05029 * T) % 360) * D2R;
    const C = (1.914602 - 0.004817 * T) * Math.sin(Mr) + 0.019993 * Math.sin(2 * Mr) + 0.000289 * Math.sin(3 * Mr);
    const lam = (((280.46 + 36000.77 * T) % 360) + C) * D2R, eps = (23.439291 - 0.0130042 * T) * D2R, dec = Math.asin(Math.sin(eps) * Math.sin(lam));
    const gmst = (280.46061837 + 360.98564736629 * (jd - 2451545)) % 360, ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
    const H = (gmst + lonDeg) * D2R - ra, la = latDeg * D2R;
    const elev = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H));
    const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(la) - Math.tan(dec) * Math.cos(la));
    return { elev: elev / D2R, az: (az / D2R + 540) % 360 };
  }

  window.AFC3D = { Scene, sunAt, loadDem, supported() { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl') || c.getContext('experimental-webgl')); } catch { return false; } } };
})();
