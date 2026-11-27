// Satellitenbild «Wolken jetzt» (EUMETSAT, Meteosat-12 FCI und Meteosat-11 SEVIRI, «Quelle: EUMETSAT»).
// Bei Tag alle 10 Minuten ein sichtbares Bild mit 500 m Auflösung (vis06_hrfi) und dazu das «Snow RGB» (1 km), das Wolken
// von Schnee unterscheidet (die Wolkenmaske clm, 3 km, hält im Winter verschneite Alpen oft für Wolken und bleibt nur Ersatz).
// Die App legt beides zusammen: nur wo Wolken sind, zeigt sie das Bild.
// Ausschnitt = Geländeraster (lib/terrain-grid.bin), damit Karte und 3D das Bild ohne Umrechnung über das Gelände legen.
import { httpGet } from './http.js';
import { solarPosition } from './util.js';

const BASE = () => process.env.AFC_SAT_URL || 'https://view.eumetsat.int/geoserver';
export const SAT_SOURCE = 'EUMETSAT (Meteosat, Wolkenmaske)';
// snow: «Snow RGB» von Meteosat-12 (1,6 µm): Schnee rot, Wolken weiss bis hellblau. Unterscheidet im Winter viel besser als die Maske.
export const LAYERS = { vis: { name: 'mtg_fd:vis06_hrfi', step: 10 }, clm: { name: 'msg_fes:clm', step: 15 }, snow: { name: 'mtg_fd:rgb_snow', step: 10 } };
const SUN_MIN = 12;                   // darunter ist das sichtbare Bild zu dunkel und die Wolkenmaske hält Schnee und Schatten für Wolken

/** Letzte verfügbare Zeit einer Ebene aus deren GetCapabilities (Standardwert der Zeitdimension). */
export function parseDefaultTime(xml) {
  const m = /<Dimension[^>]*name="time"[^>]*default="([^"]+)"/.exec(String(xml || ''));
  const t = m ? Date.parse(m[1]) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** Jüngster Zeitpunkt (Raster step Minuten, nicht nach latest), an dem die Sonne über der Gegend genug hoch steht. */
export function lastDaylight(latest, grid, step = 10, now = latest) {
  const lat = grid.la0 + (grid.ny - 1) * grid.dla / 2, lon = grid.lo0 + (grid.nx - 1) * grid.dlo / 2;
  let t = Math.floor(Math.min(latest, now) / (step * 60000)) * step * 60000;
  for (let i = 0; i < 24 * 6 * 2; i++, t -= step * 60000) if (solarPosition(t, lat, lon).elevationDeg >= SUN_MIN) return t;
  return null;
}

/** Zeit der Wolkenmaske, die zum sichtbaren Bild passt (gleich oder kurz davor). */
export const clmFor = (tVis, latestClm) => Math.min(latestClm, Math.floor(tVis / (15 * 60000)) * 15 * 60000);

/** GetMap-Adresse für den ganzen Ausschnitt des Geländerasters (Pixel = Rastermitte, daher halber Schritt Rand). */
export function mapUrl(layer, t, grid, scale = 2) {
  const s = grid.la0 - grid.dla / 2, w = grid.lo0 - grid.dlo / 2, n = grid.la0 + (grid.ny - 0.5) * grid.dla, e = grid.lo0 + (grid.nx - 0.5) * grid.dlo;
  const q = new URLSearchParams({ service: 'WMS', version: '1.3.0', request: 'GetMap', layers: LAYERS[layer].name, styles: '', crs: 'EPSG:4326', bbox: [s, w, n, e].map(v => v.toFixed(5)).join(','), width: String(grid.nx * scale), height: String(grid.ny * scale), format: 'image/png', time: new Date(t).toISOString().replace('.000Z', 'Z') });
  return `${BASE()}/wms?${q}`;
}

export function createSat(grid) {
  const st = { at: 0, info: null, err: null, imgs: new Map(), busy: null };
  const caps = async layer => {
    const [ns, name] = LAYERS[layer].name.split(':');
    const r = await httpGet(`${BASE()}/${ns}/${name}/ows?service=WMS&version=1.3.0&request=GetCapabilities`, { accept: 'application/xml', timeoutMs: 30000 });
    const t = parseDefaultTime(await r.text());
    if (!t) throw new Error('EUMETSAT: keine Zeit für ' + layer);
    return t;
  };
  /** { vis, clm, latest, day } (ms); höchstens alle 5 Minuten neu gefragt. */
  async function info(now = Date.now()) {
    if (st.info && now - st.at < 5 * 60000) return st.info;
    st.busy ??= (async () => {
      try {
        const [lv, lc] = await Promise.all([caps('vis'), caps('clm')]);
        const vis = lastDaylight(lv, grid, 10, now);
        if (!vis) throw new Error('kein Tageslichtbild in den letzten zwei Tagen');
        st.info = { vis, clm: clmFor(vis, lc), latest: lv, day: vis === Math.floor(lv / 600000) * 600000 };
        st.at = Date.now(); st.err = null;
        return st.info;
      } catch (e) { st.err = e.message; if (st.info) return st.info; throw e; }
      finally { st.busy = null; }
    })();
    return st.busy;
  }
  /** PNG einer Ebene zur Zeit t (Buffer), im Speicher gehalten (höchstens 24 Bilder). */
  async function image(layer, t) {
    if (!LAYERS[layer]) throw Object.assign(new Error('unbekannte Ebene'), { code: 400 });
    const k = layer + t, hit = st.imgs.get(k);
    if (hit) return hit;
    const p = (async () => {
      const r = await httpGet(mapUrl(layer, t, grid), { accept: 'image/png', timeoutMs: 45000 });
      const ct = r.headers.get('content-type') || '';
      if (!ct.startsWith('image/png')) throw new Error('EUMETSAT lieferte kein Bild');
      return Buffer.from(await r.arrayBuffer());
    })();
    st.imgs.set(k, p);
    p.catch(() => st.imgs.delete(k));
    while (st.imgs.size > 24) st.imgs.delete(st.imgs.keys().next().value);
    return p;
  }
  return { info, image, status: () => ({ at: st.at || null, error: st.err, vis: st.info?.vis ?? null }) };
}
