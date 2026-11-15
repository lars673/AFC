// Bergpanorama für das Startbild: die Silhouette, die man vom Startplatz aus in Startrichtung sieht.
// Aus dem Geländeraster (lib/terrain-grid.bin, ca. 250 m) je Blickrichtung der höchste Sichtwinkel,
// getrennt nach nah (bis 3 km), mittel (bis 12 km) und weit (bis 45 km). Reine Zierde, zählt nicht zum Score.
// Erzeugt mit tools/build-pano.js nach lib/pano.json (die App lädt nur diese kleine Datei, nicht das Raster).

export const PANO = { fov: 120, step: 3, near: 3000, mid: 12000, far: 45000 };

/** Geländeraster aus dem Dateiinhalt lesen (gleiches Format wie in der App). */
export function readGrid(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), hl = dv.getUint32(0, true);
  const g = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + hl)));
  const o = 4 + hl + ((4 + hl) % 2), N = g.ny * g.nx;
  const elev = new Uint16Array(N);
  for (let i = 0; i < N; i++) elev[i] = dv.getUint16(o + 2 * i, true);
  return { ...g, elev };
}

/** Höhe bilinear, null ausserhalb des Rasters. */
export function elevAt(g, lat, lon) {
  const fx = (lon - g.lo0) / g.dlo, fy = (lat - g.la0) / g.dla;
  if (!(fx >= 0 && fy >= 0 && fx <= g.nx - 1 && fy <= g.ny - 1)) return null;
  const x0 = Math.min(Math.floor(fx), g.nx - 2), y0 = Math.min(Math.floor(fy), g.ny - 2), tx = fx - x0, ty = fy - y0, k = y0 * g.nx + x0, e = g.elev;
  return (e[k] * (1 - tx) + e[k + 1] * tx) * (1 - ty) + (e[k + g.nx] * (1 - tx) + e[k + g.nx + 1] * tx) * ty;
}

/** Silhouette von einem Startplatz: Winkel in Grad (0 = Augenhöhe) je Blickrichtung, drei Ebenen. */
export function panorama(g, site, o = PANO) {
  const eye0 = elevAt(g, site.lat, site.lon);
  if (eye0 == null) return null;
  const eye = Math.max(eye0, site.alt || 0) + 2, az0 = site.aspects?.[0] ?? site.terrain?.terrainAspect ?? 180;
  const n = Math.round(o.fov / o.step) + 1, mLat = 111320, mLon = 111320 * Math.cos(site.lat * Math.PI / 180), R = 6371000 / 0.87;   // 0.87: Lichtbrechung
  const out = { az: az0, n: [], m: [], f: [], h: 0 };
  for (let i = 0; i < n; i++) {
    const az = (az0 - o.fov / 2 + i * o.step) * Math.PI / 180, sx = Math.sin(az), sy = Math.cos(az);
    let near = -90, mid = -90, far = -90, hTop = 0;
    for (let d = 120; d <= o.far; d += Math.max(80, d * 0.025)) {
      const h = elevAt(g, site.lat + sy * d / mLat, site.lon + sx * d / mLon);
      if (h == null) break;
      const a = Math.atan2(h - eye - d * d / (2 * R), d) * 180 / Math.PI;
      if (d <= o.near && a > near) near = a;
      if (d <= o.mid && a > mid) mid = a;
      if (a > far) { far = a; hTop = h; }
    }
    mid = Math.max(mid, near); far = Math.max(far, mid);
    const r = v => +v.toFixed(1) || 0;   // ohne -0
    out.n.push(r(near)); out.m.push(r(mid)); out.f.push(r(far));
    out.h = Math.max(out.h, Math.round(hTop));
  }
  return out;
}

/** Alle Startplätze im Raster. */
export function buildPanos(g, sites) {
  const out = {};
  for (const s of sites) if (s.type === 'start') { const p = panorama(g, s); if (p) out[s.id] = p; }
  return { v: 1, fov: PANO.fov, step: PANO.step, sites: out };
}
