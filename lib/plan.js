// Plan-Berechnung: aus Rohdaten (Prognose, Messwerte, Regionallage) werden Stundenbewertungen,
// Startfenster je Tag, Gebietskarten und Lage-Raster. Läuft komplett auf dem Server.
import {
  clamp, isNum, haversineKm, zurichParts, solarPosition
} from './util.js';
import {
  LEVELS, levelOf, DEFAULT_LEVEL, assessHour, pickWindow, decisionFor, interpolateWind, windProfile,
  gustAtLaunch, cloudBaseMsl, frontRiskSeries, foehnFromAloft, foehnFromGradient, worstLevel, regionVerdict, thermalPotential, thermalProfile, explainHour,
  stormLevel, biseLevel, skyOf, skyHour
} from './scoring.js';
import { levelsAt } from './openmeteo.js';
import { stationCorrection, windCorrection, BLOCK_NAMES } from './learn.js';
import { localForHour } from './regional.js';
import { ENS_MIN, ensIdx, membersAt, quantile, share, pairDiff } from './ensemble.js';
import { fogStateAt, fogConflict } from './fog.js';

export const H0 = 6, H1 = 21;                // Auswertung 06–21 Uhr Ortszeit
export const NH = H1 - H0 + 1;
const MAX_DAYS = 5;

export const REF_POINT = { id: 'REF', lat: 46.68, lon: 7.86 };
/** Föhnpunkte: Druckunterschied Lugano minus Zürich-Kloten (Föhnregel). */
/** Bergstationen ab dieser Höhe korrigieren die Windprognose für Startplätze in der Nähe. */
export const MOUNTAIN_ALT = 1500;
export const MOUNTAIN_DECAY_H = 8;
/** Selbst nachkalibrieren: Böenfehler der Bergstationen der letzten Tage, zu diesem Anteil übernommen. */
/** «am Nachmittag bei West» aus dem Schlüssel einer gelernten Gruppe. */
const learnedWhen = key => { const [b, sec] = key.split('|'); return `${BLOCK_NAMES[b] ? 'am ' + BLOCK_NAMES[b] : ''}${sec && sec !== 'ruhig' ? ' bei ' + sec + '-Wind' : sec === 'ruhig' ? ' bei wenig Wind' : ''}`; };
export const LEARN_DAYS = 30, LEARN_MIN_N = 30, LEARN_WEIGHT = Number(globalThis.process?.env?.AFC_LEARN_WEIGHT ?? 0.6);
export const FOEHN_POINTS = [{ id: 'LUG', lat: 46.004, lon: 8.960 }, { id: 'KLO', lat: 47.480, lon: 8.536 }, { id: 'GVE', lat: 46.248, lon: 6.128 }];

/** Taupunkt aus Temperatur und relativer Feuchte (Magnus). */
export function dewPoint(t, rh) {
  if (!isNum(t) || !isNum(rh) || rh <= 0) return null;
  const a = 17.62, b = 243.12, g = Math.log(rh / 100) + (a * t) / (b + t);
  return (b * g) / (a - g);
}

/** Gebiets-Mittelpunkte aus den Startplätzen. */
export const isBlocked = s => s.pg === false || /gesperrt|nicht geeignet/.test(s.status || '');
/** Nur Startplätze mit bekannter Höhe werden bewertet (Landeplätze und unverifizierte Plätze nicht). */
export const isRanked = s => s.type === 'start' && isNum(s.alt);

/**
 * Gebiete. Der Bezugspunkt (Landewind, Höhenprofil, zweites Modell) liegt bei den Landeplätzen des Gebiets,
 * sonst in der Mitte der Startplätze.
 */
export function areasOf(sites) {
  const m = new Map();
  for (const s of sites) {
    if (!m.has(s.area)) m.set(s.area, { id: s.area, sites: [], landings: [] });
    (isRanked(s) ? m.get(s.area).sites : s.type === 'landing' ? m.get(s.area).landings : []).push(s);
  }
  const out = [];
  for (const a of m.values()) {
    if (!a.sites.length) continue;
    const ref = a.landings.length ? a.landings : a.sites;
    a.lat = ref.reduce((p, s) => p + s.lat, 0) / ref.length;
    a.lon = ref.reduce((p, s) => p + s.lon, 0) / ref.length;
    a.alt = Math.min(...a.sites.map(s => s.alt));
    a.name = a.sites.find(s => s.group)?.group || a.sites[0].name;
    out.push(a);
  }
  return out;
}

const nearestIdx = (t, ms) => {
  let b = 0, bd = Infinity;
  for (let i = 0; i < t.length; i++) { const d = Math.abs(t[i] - ms); if (d < bd) { bd = d; b = i; } }
  return b;
};

export class PlanModel {
  /**
   * ctx: { now, raw:{sites,areas,ref,stations}, obs:{CODE:row}, stationMeta:{CODE:{lat,lon,alt,name}},
   *        regional, trend, sites, fetchedAt }
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.allSites = ctx.sites.map(s => ({ ...s, blocked: isBlocked(s) }));
    this.sites = this.allSites.filter(isRanked);
    this.areas = areasOf(this.allSites);
    this.cache = new Map();
    const ref = ctx.raw?.ref?.sea;
    this.ok = !!ref?.t?.length;
    if (!this.ok) return;
    this.t = ref.t;
    this.n = this.t.length;
    this.parts = this.t.map(zurichParts);
    const todayDate = zurichParts(ctx.now).date;
    const dates = [...new Set(this.parts.map(p => p.date))].filter(d => d >= todayDate).sort().slice(0, MAX_DAYS);
    this.dates = dates;
    this.dayOf = this.parts.map(p => dates.indexOf(p.date));
    this.nowIdx = this.t.findIndex(x => x >= ctx.now - 30 * 60000);
    this.buildRegion();
    this.stationBias = new Map();
    this.landings = this.allSites.filter(x => x.type === 'landing' && isNum(x.alt) && isNum(x.lat));
  }

  /** Landeplatz eines Startplatzes: Hauptlandeplatz des Gebiets, sonst der nächste im Gebiet, sonst bis 6 km. */
  landingFor(site) {
    const d = l => haversineKm(site.lat, site.lon, l.lat, l.lon);
    const inArea = this.landings.filter(l => l.area === site.area);
    if (inArea.length) return inArea.sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0) || d(a) - d(b))[0];
    return this.landings.filter(l => d(l) <= 6).sort((a, b) => d(a) - d(b))[0] || null;
  }

  /** Gemessener Nebel für eine Stunde an einem Startplatz (nur heute). */
  fogFor(site, i, land) {
    const F = this.ctx.fog;
    if (!F?.obs?.top || this.dayOf[i] !== 0) return null;
    const state = fogStateAt(F.tl, this.t[i]);
    if (!state) return null;
    const c = fogConflict(F.obs, site.alt, land?.alt);
    if (!c) return null;
    const o = F.obs, src = [o.inn[0] ? `${o.inn.at(-1).name} ${o.inn.at(-1).alt} m im Nebel` : o.under[0] ? `${o.under.at(-1).name} grau` : '', o.above[0] ? `${o.above[0].name} ${o.above[0].alt} m in der Sonne` : ''].filter(Boolean).join(', ');
    return { ...c, state, top: o.top, base: o.base, ground: o.ground, src, land: land?.name || null };
  }

  buildRegion() {
    const { raw, regional, trend, now } = this.ctx;
    const sea = raw.ref.sea, pl = raw.ref.pl;
    const lh = this.parts.map(p => p.hour);
    const spd = (k, i) => pl?.[`wind_speed_${k}hPa`]?.[i], dir = (k, i) => pl?.[`wind_direction_${k}hPa`]?.[i];
    // Druck an den Föhnpunkten zur Stunde (eigene Zeitreihen, nach Zeit zugeordnet)
    const pAt = s => { if (!s?.t || !s.pressure_msl) return () => null; const m = new Map(s.t.map((t, k) => [t, s.pressure_msl[k]])); return t => m.get(t) ?? null; };
    const pLug = pAt(raw.grad?.LUG), pKlo = pAt(raw.grad?.KLO), pGve = pAt(raw.grad?.GVE);
    this.front = frontRiskSeries({
      P: sea.pressure_msl, T: sea.temperature_2m,
      D800: pl?.wind_direction_800hPa, S800: pl?.wind_speed_800hPa,
      CAPE: sea.cape, POP: sea.precipitation_probability, lh
    });
    // Typische Starthöhe der Region (Median der bewerteten Startplätze) als Bezug für die Wolkenbasis
    const alts = this.sites.map(s => s.alt).filter(isNum).sort((a, b) => a - b);
    const launchAlt = alts.length ? alts[Math.floor(alts.length / 2)] : 1800;
    this.region = [];
    const today = zurichParts(now).date;
    for (let i = 0; i < this.n; i++) {
      const u800 = isNum(spd(800, i)) ? { speed: spd(800, i), dir: dir(800, i) } : null;
      const u700 = isNum(spd(700, i)) ? { speed: spd(700, i), dir: dir(700, i) } : null;
      const prev = isNum(spd(800, Math.max(0, i - 3))) ? spd(800, Math.max(0, i - 3)) : null;
      const rising = !!(u800 && prev !== null && u800.speed - prev >= 15);
      const pl1 = pLug(this.t[i]), pk1 = pKlo(this.t[i]);
      // Gelernt (lib/learn.js pressureLearn): wie weit der Druckunterschied danebenlag, und tiefere Warngrenzen
      const PL = this.ctx.pressureLearn, fb = PL?.foehn?.bias || 0, bb = PL?.bise?.bias || 0;
      const dp = isNum(pl1) && isNum(pk1) ? Math.round((pl1 - pk1 + fb) * 10) / 10 : null;
      const pg1 = pGve(this.t[i]), bdp = isNum(pk1) && isNum(pg1) ? Math.round((pk1 - pg1 + bb) * 10) / 10 : null;
      const foehnModel = worstLevel(foehnFromAloft(u800, u700), foehnFromGradient(dp, PL?.foehn?.warn ?? 4));
      const ha = (this.t[i] - now) / 3600000;
      const local = localForHour(regional, ha);
      let foehn = foehnModel;
      if (local?.foehn === 'danger') foehn = 'danger';
      else if (local?.foehn === 'warn' && foehn === 'ok') foehn = 'warn';
      const cape = sea.cape?.[i] ?? 0, pop = sea.precipitation_probability?.[i] ?? 0;
      const t2 = sea.temperature_2m?.[i], rh = sea.relative_humidity_2m?.[i];
      const cb = cloudBaseMsl(t2, dewPoint(t2, rh), raw.ref.sea.elevation ?? 1000);
      const sun = sea.shortwave_radiation?.[i] ?? 0;
      const tp = thermalProfile(levelsAt(pl, i), t2, raw.ref.sea.elevation ?? 1000, sun);
      // Bise im Oberland gemessen (Brienz, Meiringen, Interlaken): gilt für den ganzen heutigen Tag
      const oberland = !!(regional?.biseOberland && this.parts[i].date === today);
      const bise = biseLevel(bdp, u800, local?.biseScore || 0, PL?.bise?.warn ?? 2, oberland);
      const verdict = regionVerdict({ front: this.front[i], cape, pop, foehn, bise: bise.weak ? 'weak' : bise.level, up800: u800, rising });
      // Wettervarianten: in wie vielen davon reicht der Druckunterschied für Bise bzw. Föhn?
      let ens = null;
      const E = this.ctx.ens;
      if (E?.byId && E.members >= ENS_MIN) {
        const bm = pairDiff(E.byId.KLO, E.byId.GVE, this.t[i], bb), fm = pairDiff(E.byId.LUG, E.byId.KLO, this.t[i], fb);
        if (bm.length >= ENS_MIN) ens = { n: bm.length, pBise: share(bm, x => x >= (PL?.bise?.warn ?? 2)), pFoehn: fm.length >= ENS_MIN ? share(fm, x => x >= (PL?.foehn?.warn ?? 4)) : null };
      }
      this.region.push({
        i, front: this.front[i], foehnModel, dp, bdp, bise, foehn, local, u800, u700, rising, cape, pop, cb, sun, ens,
        therm: thermalPotential({ sun, cape, cloudMargin: isNum(cb) ? cb - launchAlt : null, rainRisk: pop, topMargin: tp ? Math.min(tp.top, isNum(cb) ? cb : Infinity) - launchAlt : null, wstar: tp?.wstar }),
        top: tp ? Math.min(tp.top, isNum(cb) ? cb : Infinity) : null, inversion: tp?.inversion ?? null,
        verdict
      });
    }
    // Bise hält meist den ganzen Tag und frischt im Bödeli am Nachmittag oft noch auf, während der
    // Druckunterschied in der Prognose nachlässt (Rückblick 28./29.5.2026: Warnung am Morgen, «Start» um 15 Uhr,
    // gemessen starke Bise). Darum gilt eine Bise-Warnung zwischen 6 und 20 Uhr für den ganzen Tag, mindestens als Vorsicht.
    // Schwache Bise (siehe biseLevel) gilt ebenfalls den ganzen Tag, aber nur als schwache; eine volle Warnung am
    // selben Tag macht auch die schwachen Stunden voll.
    const rank = b => (b.level === 'danger' ? 3 : b.level === 'warn' ? (b.weak ? 1 : 2) : 0);
    const dayBise = new Map();
    this.region.forEach((r, i) => {
      const p = this.parts[i];
      if (p.hour < 6 || p.hour > 20 || r.bise.level === 'ok') return;
      const cur = dayBise.get(p.date);
      if (!cur || rank(r.bise) > cur.rank) dayBise.set(p.date, { rank: rank(r.bise), weak: !!r.bise.weak, why: r.bise.why, hour: p.hour });
    });
    // Unsicherheit statt Strenge: Vor der ersten Bise-Stunde eines Tages bleibt eine Stunde frei, wenn in ihr und den
    // zwei Stunden danach höchstens 1 von 10 Varianten Bise hat und heute im Oberland keine gemessen wird. Nur
    // rückwärts: nach der ersten Bise-Stunde gilt die Warnung weiter bis am Abend (Rückblick 28./29.5.2026).
    // Die Selbstprüfung (ensembleCheck) schaltet das ab, wenn die Bise trotz «unter 10 %» zu oft kam.
    const E = this.ctx.ens, ensOn = !!(E?.members >= ENS_MIN && E.check?.ok !== false);
    const first = new Map();
    this.region.forEach((r, i) => { const p = this.parts[i]; if (p.hour >= 6 && p.hour <= 20 && r.bise.level !== 'ok' && !first.has(p.date)) first.set(p.date, { i, hour: p.hour }); });
    const measured = !!(regional?.biseOberland || (regional?.biseScore || 0) >= 40);
    const calmBefore = (i, f) => {
      if (!ensOn || !f || i >= f.i) return false;
      if (this.parts[i].date === today && measured) return false;
      for (let j = i; j <= i + 2; j++) {
        if (j >= f.i || this.parts[j]?.date !== this.parts[i].date) return false;
        const p = this.region[j].ens?.pBise;
        if (!isNum(p) || p > 0.1) return false;
      }
      return true;
    };
    this.region.forEach((r, i) => {
      const p = this.parts[i], d = dayBise.get(p.date);
      if (!d || p.hour < 6 || p.hour > 20 || rank(r.bise) >= Math.min(d.rank, 2)) return;
      const f = first.get(p.date);
      if (rank(r.bise) === 0 && calmBefore(i, f)) { r.biseLater = { hour: f.hour, p: this.region[f.i].ens?.pBise ?? null, n: this.region[f.i].ens?.n ?? null, weak: d.weak }; return; }
      r.bise = { level: 'warn', weak: d.weak, why: [`${d.weak ? 'Schwache Bise' : 'Bise'} am selben Tag (${d.hour} Uhr: ${d.why[0] || 'Nordost'}), hält oft bis am Abend`] };
      r.verdict = regionVerdict({ front: r.front, cape: r.cape, pop: r.pop, foehn: r.foehn, bise: d.weak ? 'weak' : 'warn', up800: r.u800, rising: r.rising });
    });
  }

  /** Nächste geeignete Station für den Nowcast-Abgleich eines Startplatzes. */
  biasFor(site) {
    const { obs, stationMeta, raw, now } = this.ctx;
    if (!obs || !stationMeta) return null;
    let best = null;
    for (const [code, o] of Object.entries(obs)) {
      const m = stationMeta[code];
      if (!m || !isNum(o.wind) || !isNum(m.alt)) continue;
      const age = (now - Date.parse(o.time)) / 60000;
      if (!(age <= 30)) continue;
      const dist = haversineKm(site.lat, site.lon, m.lat, m.lon);
      // Bergstationen (ab 1500 m) messen den Wind auf Starthöhe: grösserer Umkreis als Talstationen
      const mtn = m.alt >= MOUNTAIN_ALT;
      if (dist > (mtn ? 20 : 15) || Math.abs(m.alt - site.alt) > (mtn ? 700 : 600)) continue;
      // Prognose am Stationsort; fehlt sie (Rückblick-Test), die Prognose am Startplatz
      const fc = raw.stations?.[code]?.wind_speed_10m ? raw.stations[code] : mtn ? raw.sites?.[site.id] : null;
      if (!fc?.wind_speed_10m) continue;
      const i = nearestIdx(fc.t, Date.parse(o.time));
      const f = fc.wind_speed_10m[i];
      if (!isNum(f)) continue;
      const score = dist + (mtn ? 0 : 10);   // bei Startplätzen am Berg zählt die Bergstation vor der Talstation
      if (!best || score < best.score) best = { code, name: m.name || code, dist, score, alt: m.alt, mountain: mtn, obs: o.wind, fc: f, bias: clamp(o.wind - f, -12, mtn ? 15 : 12), gustBias: isNum(o.gust) && isNum(fc.wind_gusts_10m?.[i]) ? clamp(o.gust - fc.wind_gusts_10m[i], -15, 20) : null, obsGust: o.gust, obsDir: o.dir, fcDir: fc.wind_direction_10m?.[i], age, time: o.time };
    }
    return best;
  }

  /**
   * Gelernte Abweichung: Wie viel stärker waren die Böen an der nächsten Bergstation in den letzten 14 Tagen
   * als prognostiziert? (ctx.learned je Station: gust = Mittel Messung minus Prognose, n = Anzahl Stunden)
   */
  learnedFor(site) {
    const { learned, stationMeta } = this.ctx;
    if (!learned || !stationMeta) return null;
    let best = null;
    for (const [code, l] of Object.entries(learned)) {
      const m = stationMeta[code];
      if (!m || !isNum(m.alt) || m.alt < MOUNTAIN_ALT || !(l.n >= LEARN_MIN_N) || !isNum(l.gust) || l.mode === 'none') continue;
      const dist = haversineKm(site.lat, site.lon, m.lat, m.lon);
      if (dist > 20 || Math.abs(m.alt - site.alt) > 700) continue;
      if (!best || dist < best.dist) best = { code, name: m.name || code, dist, l };
    }
    return best;
  }
  /**
   * Gelernte Böenkorrektur für eine Stunde (lib/learn.js): anheben bis 10 km/h; senken nur, wenn die Station
   * über Wochen bestätigt weniger misst, halb so stark und höchstens 4 km/h (nie bei «nur anheben»).
   */
  learnedAdd(lg, hour, dir, speed) {
    const c = lg ? stationCorrection(lg.l, hour, dir, speed) : null;
    if (!c) return null;
    const add = c.gust > 0 ? clamp(c.gust * LEARN_WEIGHT, 0, 10) : lg.l.raiseOnly ? 0 : clamp(c.gust * LEARN_WEIGHT * 0.5, -4, 0);
    return { add: Math.round(add * 10) / 10, key: c.key, n: c.n };
  }

  /** Nächste Talstation (unter 1100 m, bis 15 km) mit gelerntem Grundwind oder Böen: für den Talwind an der Landung. */
  valleyFor(site) {
    const { learned, stationMeta } = this.ctx;
    if (!learned || !stationMeta) return null;
    let best = null;
    for (const [code, l] of Object.entries(learned)) {
      const m = stationMeta[code];
      if (!m || !isNum(m.alt) || m.alt >= 1100 || !(l.n >= LEARN_MIN_N)) continue;
      if (l.mode === 'none' && (!l.wind || l.wind.mode === 'none')) continue;
      const dist = haversineKm(site.lat, site.lon, m.lat, m.lon);
      if (dist <= 15 && (!best || dist < best.dist)) best = { code, name: m.name || code, dist, l };
    }
    return best;
  }

  /** Talwind an der Landung mit dem, was die Talstation gelernt hat: mehr voll, weniger halb und höchstens 3 km/h. */
  valleyAt(vs, se, i, hour) {
    let speed = se.wind_speed_10m?.[i], gust = se.wind_gusts_10m?.[i], learned = null;
    if (vs && isNum(speed)) {
      const dir = se.wind_direction_10m?.[i];
      const wc = windCorrection(vs.l, hour, dir, speed), gc = stationCorrection(vs.l, hour, dir, speed);
      const adj = v => (v > 0 ? clamp(v * LEARN_WEIGHT, 0, 8) : clamp(v * LEARN_WEIGHT * 0.5, -3, 0));
      const dw = wc ? adj(wc.wind) : 0, dg = gc ? adj(gc.gust) : 0;
      if (dw || dg) {
        speed = Math.max(0, speed + dw); if (isNum(gust)) gust = Math.max(speed, gust + dg);
        if (Math.abs(dw) >= 2 || Math.abs(dg) >= 3) learned = { name: vs.name, dw: Math.round(dw), dg: Math.round(dg) };
      }
    }
    return { speed, gust, learned };
  }

  /** Stundenbewertungen aller Startplätze für eine Erfahrungsstufe. */
  compute(levelId) {
    const id = LEVELS[levelId] ? levelId : DEFAULT_LEVEL;
    if (this.cache.has(id)) return this.cache.get(id);
    const lv = levelOf(id);
    const res = new Map();
    if (this.ok) for (const site of this.sites) res.set(site.id, this.computeSite(site, lv));
    this.cache.set(id, res);
    return res;
  }

  computeSite(site, lv) {
    const { raw, now, trend } = this.ctx;
    const area = raw.areas?.[site.area] || {};
    const fc = raw.sites?.[site.id] || area.sea || null;
    const out = { site, nowcast: this.biasFor(site), hours: new Array(this.n).fill(null) };
    if (!fc) return out;
    const nb = out.nowcast;
    const lg = out.learned = this.learnedFor(site), vs = this.valleyFor(site), land = this.landingFor(site);
    const mw = this.ctx.modelLearn?.[site.area]?.weight || 0;
    for (let i = 0; i < this.n; i++) {
      const hour = this.parts[i].hour;
      if (hour < H0 || hour > H1 || this.dayOf[i] < 0) continue;
      if (solarPosition(this.t[i], site.lat, site.lon).elevationDeg < 3) continue;   // nach Sonnenuntergang kein Flugfenster
      const ha = (this.t[i] - now) / 3600000;
      // Abweichung Messung–Prognose klingt ab. Misst eine Bergstation mehr Wind als prognostiziert,
      // hält das meist den ganzen Tag (grossräumiger Wind): dann nur langsam abklingen, und nur heute.
      const keep = nb?.mountain && Math.max(nb.bias, nb.gustBias ?? -1) > 0 && this.dayOf[i] === 0;
      const decay = nb && ha > -1 ? Math.exp(-Math.max(0, ha) / (keep ? MOUNTAIN_DECAY_H : 2)) : 0;
      const bias = nb ? nb.bias * decay : 0;
      const levels = levelsAt(area.pl, i);
      const free = interpolateWind(levels, site.alt + 30);
      const s10 = fc.wind_speed_10m?.[i], g10 = fc.wind_gusts_10m?.[i], d10 = fc.wind_direction_10m?.[i];
      let speed = isNum(s10) ? s10 : (free ? free.speed * 0.85 : null);
      let dir = isNum(d10) ? d10 : (free ? free.dir : null);
      let gust = gustAtLaunch(free ? free.speed * 0.9 : null, s10, g10);
      let mtnGust = null;
      // Böen anheben, wenn die Bergstation mehr misst (heute) oder in den letzten 14 Tagen meist mehr gemessen hat.
      // Nur die Böen: mehr Grundwind würde Soaring besser aussehen lassen und den Score heben
      // (Rückblick-Test Winter 2026: 01-16 Planplatten 82 bei 49 km/h Böen).
      const la = this.learnedAdd(lg, hour, dir, speed);
      const nowAdd = keep ? Math.max(0, nb.gustBias ?? nb.bias) * decay : 0, learnAdd = la?.add ?? 0;
      if (!keep) {
        if (isNum(speed)) speed = Math.max(0, speed + bias);
        if (isNum(gust)) gust = Math.max(speed ?? 0, gust + bias);
      }
      // Gelernt weniger Böen: nur wenn die Station jetzt nicht mehr misst als prognostiziert
      const add = learnAdd < 0 ? (nowAdd > 0 || (nb && bias > 0) ? 0 : learnAdd) : Math.max(nowAdd, learnAdd);
      if (add !== 0 && isNum(gust)) gust = Math.max(speed ?? 0, gust + add);
      const when = la?.key ? learnedWhen(la.key) : '';
      if (add >= 4) mtnGust = nowAdd >= learnAdd ? { name: nb.name, add, why: 'now' } : { name: lg.name, add, why: 'learned', days: LEARN_DAYS, when };
      else if (add <= -2) mtnGust = { name: lg.name, add, why: 'learned', days: LEARN_DAYS, when };
      // Besseres Modell gewichten (lib/learn.js modelLearn): Verschiebung ECMWF minus ICON am Gebietspunkt
      let modelShift = null, windUp = 0;
      if (mw && area.sea && area.ecmwf) {
        const dg = (area.ecmwf.wind_gusts_10m?.[i] ?? NaN) - (area.sea.wind_gusts_10m?.[i] ?? NaN);
        const dw = (area.ecmwf.wind_speed_10m?.[i] ?? NaN) - (area.sea.wind_speed_10m?.[i] ?? NaN);
        if (isNum(dg) && isNum(gust)) { const sg = mw * (dg > 0 ? dg : dg * 0.5); gust = Math.max(speed ?? 0, gust + sg); if (Math.abs(sg) >= 3) modelShift = { gust: Math.round(sg), weight: mw }; }
        if (isNum(dw) && isNum(speed) && dw > 0) windUp += mw * dw;
      }
      // Grundwind am Start gelernt (Bergstation): nur mehr Wind, und der darf die Bewertung nur verschlechtern (unten)
      const wc = lg && !keep ? windCorrection(lg.l, hour, dir, speed) : null;
      if (wc && wc.wind > 0) windUp += clamp(wc.wind * LEARN_WEIGHT, 0, 8);
      windUp = Math.round(windUp * 10) / 10;
      const t2 = fc.temperature_2m?.[i], rh = fc.relative_humidity_2m?.[i];
      const cloudBase = cloudBaseMsl(t2, dewPoint(t2, rh), fc.elevation ?? site.alt);
      const prof = levels.length ? windProfile(levels, site.alt) : null;
      const thermik = thermalProfile(levels, t2, fc.elevation ?? site.alt, fc.shortwave_radiation?.[i] ?? 0);
      const se = area.sea, ec = area.ecmwf;
      let spread = null;
      if (se && ec && isNum(se.wind_speed_10m?.[i]) && isNum(ec.wind_speed_10m?.[i])) {
        spread = Math.max(Math.abs(se.wind_speed_10m[i] - ec.wind_speed_10m[i]),
          isNum(se.wind_gusts_10m?.[i]) && isNum(ec.wind_gusts_10m?.[i]) ? Math.abs(se.wind_gusts_10m[i] - ec.wind_gusts_10m[i]) * 0.6 : 0);
      }
      const reg = this.region[i];
      // Die nächsten 5 Stunden: kommen am Nachmittag Schauer oder Gewitter, während man noch fliegt?
      const later = { precip: 0, cape: 0, hour: null };
      for (let j = i + 1; j <= i + 5 && j < this.n && this.dayOf[j] === this.dayOf[i]; j++) {
        const pr = fc.precipitation?.[j] ?? 0, pp = fc.precipitation_probability?.[j] ?? 0;
        const rainJ = Math.max(pr, pp >= 60 ? 1 : pp >= 40 ? 0.3 : 0), capeJ = fc.cape?.[j] ?? this.region[j]?.cape ?? 0;
        later.precip = Math.max(later.precip, rainJ); later.cape = Math.max(later.cape, capeJ);
        if (later.hour === null && (rainJ >= 0.3 || capeJ >= 800)) later.hour = this.parts[j].hour;
      }
      const ens = this.ensSite(site, i, speed, gust, lv, reg);
      const w = {
        ms: this.t[i], speed, gust, dir, speed10: s10, ens, biseLater: reg.biseLater || null, fog: this.fogFor(site, i, land),
        cloudBase, cloudCover: fc.cloud_cover?.[i], cloudCoverLow: fc.cloud_cover_low?.[i],
        pop: fc.precipitation_probability?.[i] ?? reg.pop, precip: fc.precipitation?.[i], cape: fc.cape?.[i] ?? reg.cape,
        sun: fc.shortwave_radiation?.[i] ?? 0,
        valley: se ? this.valleyAt(vs, se, i, hour) : null,
        mtnGust, feedback: (this.ctx.feedbackByLevel ? this.ctx.feedbackByLevel[lv.id] : this.ctx.feedback)?.[site.id] || null, thermLearn: (() => { const t = this.ctx.thermLearn?.[site.area]; return t && (t.add || (t.climb?.factor ?? 1) !== 1) ? t : null; })(), front: reg.front, foehn: reg.foehnModel, foehnDp: reg.dp, local: reg.local, bise: reg.bise, biseExposure: site.lat >= 46.6 ? 'full' : 'half',
        trend: ha < 3 && trend && reg.local ? { foehn: trend.foehn } : null,
        shear: prof ? { shear500: prof.shear500, turn1000: prof.turn1000 } : null,
        spread, nowBias: nb && !keep ? bias : null, thermik, later,
        up800: reg.u800?.speed, up700: reg.u700?.speed,
        windSource: isNum(s10) ? 'ICON-CH 10 m' : 'Höhenmodell'
      };
      let a = assessHour(site, w, lv);
      if (modelShift) a.reasons.push(`Böen ${modelShift.gust > 0 ? '+' : ''}${modelShift.gust} km/h: das Vergleichsmodell ECMWF lag hier zuletzt besser (Gewicht ${modelShift.weight})`);
      // Mehr Grundwind (gelernt) zählt nur, wenn er die Bewertung verschlechtert, nie fürs Soaring
      if (windUp >= 1 && isNum(w.speed)) {
        const w2 = { ...w, speed: w.speed + windUp, gust: Math.max(w.gust ?? 0, w.speed + windUp) };
        const a2 = assessHour(site, w2, lv);
        if (a2.score < a.score) { a = a2; a.reasons.push(`Grundwind ${Math.round(windUp)} km/h stärker gerechnet: ${lg?.name || 'die Messungen'} mass zuletzt mehr als prognostiziert`); out.hours[i] = { a, w: w2, prof: prof?.points || null, shear: prof }; continue; }
      }
      out.hours[i] = { a, w, prof: prof?.points || null, shear: prof };
    }
    return out;
  }

  /**
   * Wettervarianten am Startplatz: Die Varianten am Gebietspunkt streuen um ihren Median; diese Streuung kommt auf
   * die Werte, die AFC für den Startplatz rechnet (mit allen Korrekturen). -> Anteile der Varianten mit
   * starken Böen, kräftigem Wind, Regen, Gewitterpotenzial, dazu Bise/Föhn aus der Region.
   */
  ensSite(site, i, speed, gust, lv, reg) {
    const E = this.ctx.ens, e = E?.byId?.[site.area];
    const k = ensIdx(e, this.t[i]);
    if (k < 0) return null;
    const g = membersAt(e, 'wind_gusts_10m', k), sp = membersAt(e, 'wind_speed_10m', k);
    if (g.length < ENS_MIN || !isNum(gust)) return null;
    const gm = quantile(g, 0.5), sm = quantile(sp, 0.5);
    const G = g.map(x => Math.max(0, gust + x - gm)), S = isNum(speed) && sp.length ? sp.map(x => Math.max(0, speed + x - sm)) : [];
    const pr = membersAt(e, 'precipitation', k), cp = membersAt(e, 'cape', k);
    const r2 = v => (isNum(v) ? Math.round(v * 100) / 100 : null);
    return {
      n: g.length, g: [Math.round(quantile(G, 0.1)), Math.round(quantile(G, 0.9))],
      pHard: r2(share(G, x => x >= lv.gustHard)), pStrong: S.length ? r2(share(S, x => x > lv.windStrong)) : null,
      pRain: pr.length >= ENS_MIN ? r2(share(pr, x => x >= 0.3)) : null, pCape: cp.length >= ENS_MIN ? r2(share(cp, x => x >= 800)) : null,
      pBise: r2(reg?.ens?.pBise), pFoehn: r2(reg?.ens?.pFoehn)
    };
  }

  /** Startfenster eines Startplatzes je Tag. */
  daySummary(siteRes, d) {
    const idxs = [];
    for (let i = 0; i < this.n; i++) if (this.dayOf[i] === d) idxs.push(i);
    const slots = new Array(NH).fill(null);
    const ms = new Array(NH).fill(null);
    for (const i of idxs) {
      const h = this.parts[i].hour;
      if (h < H0 || h > H1) continue;
      slots[h - H0] = siteRes.hours[i] ? { score: siteRes.hours[i].a.score, cap: siteRes.hours[i].a.cap } : null;
      ms[h - H0] = this.t[i];
    }
    let from = 0;
    if (d === 0) {
      const nowH = zurichParts(this.ctx.now).hour;
      from = clamp(nowH - H0, 0, NH);
      if (nowH > H1) return { scores: slots.map(s => s?.score ?? null), best: null };
    }
    const win = pickWindow(slots, from);
    const best = win ? {
      score: win.score, from: H0 + win.from, to: H0 + win.to + 1, peak: H0 + win.idx,
      decision: decisionFor(win.score), stability: Math.round(win.stability)
    } : null;
    return { scores: slots.map(s => s?.score ?? null), best };
  }

  /** Tagesstunden 9–17 Uhr eines Tages (für das Wetterbild). */
  skyIdx(d) {
    const idx = [];
    for (let i = 0; i < this.n; i++) if (this.dayOf[i] === d && this.parts[i].hour >= 9 && this.parts[i].hour <= 17) idx.push(i);
    return idx;
  }

  /** Kompakte Antwort für die App (alle Gebiete/Startplätze, alle Tage). */
  planPayload(levelId) {
    const { now, fetchedAt } = this.ctx;
    const lvl = LEVELS[levelId] ? levelId : DEFAULT_LEVEL;
    if (!this.ok) return { ok: false, level: lvl, now: new Date(now).toISOString() };
    const res = this.compute(lvl);
    const sites = [];
    for (const site of this.sites) {
      const r = res.get(site.id);
      const sfc = this.ctx.raw?.sites?.[site.id] || this.ctx.raw?.areas?.[site.area]?.sea || null;
      const days = this.dates.map((_, d) => ({ ...(r ? this.daySummary(r, d) : { scores: new Array(NH).fill(null), best: null }), sky: skyOf(sfc, this.skyIdx(d)) }));
      sites.push({
        id: site.id, name: site.name, area: site.area, type: site.type, lat: site.lat, lon: site.lon, alt: site.alt,
        aspects: site.aspects, pg: site.pg, status: site.status, season: site.season || null, blocked: site.blocked, notes: Array.isArray(site.notes) ? site.notes : [],
        nowcast: r?.nowcast ? { station: r.nowcast.code, name: r.nowcast.name, dist: Math.round(r.nowcast.dist * 10) / 10, bias: Math.round(r.nowcast.bias) } : null,
        days
      });
    }
    const areas = this.areas.map(a => {
      const ids = a.sites.map(s => s.id);
      const days = this.dates.map((_, d) => {
        let best = null;
        for (const id of ids) {
          const si = sites.find(s => s.id === id);
          if (si.blocked) continue;
          const sb = si.days[d].best;
          if (sb && (!best || sb.score > best.best.score)) best = { siteId: id, best: sb };
        }
        return best;
      });
      const sky = this.dates.map((_, d) => skyOf(this.ctx.raw?.areas?.[a.id]?.sea, this.skyIdx(d)));
      return { id: a.id, name: a.name, lat: a.lat, lon: a.lon, sites: ids, days, sky };
    });
    const days = this.dates.map((date, d) => {
      let top = null;
      for (const a of areas) { const b = a.days[d]; if (b && (!top || b.best.score > top.best.score)) top = { areaId: a.id, ...b }; }
      const idx = [];
      for (let i = 0; i < this.n; i++) if (this.dayOf[i] === d && this.parts[i].hour >= 9 && this.parts[i].hour <= 17) idx.push(i);
      const rs = idx.map(i => this.region[i].verdict.score);
      const regionScore = rs.length ? Math.round(rs.reduce((p, c) => p + c, 0) / rs.length) : null;
      const worst = idx.map(i => this.region[i].verdict).sort((p, q) => p.score - q.score)[0];
      // Wetterbild des Tages: dort, wo es am besten zum Fliegen ist, sonst die Region (nur Anzeige)
      const sky = (top && areas.find(a => a.id === top.areaId)?.sky[d]) || skyOf(this.ctx.raw?.ref?.sea, idx);
      return { date, top, sky, regionScore, regionWorst: worst ? worst.worst : null, regionStatus: worst ? worst.status : null, conf: this.confidence(d, idx, now) };
    });
    return {
      ok: true, level: lvl, now: new Date(now).toISOString(), fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
      h0: H0, dates: this.dates, days, headline: this.headline(days, areas, sites, res),
      areas, sites, region: this.regionPayload(),
      landings: this.allSites.filter(x => x.type === 'landing').map(x => ({ id: x.id, name: x.name, area: x.area, lat: x.lat, lon: x.lon, alt: x.alt, status: x.status || null, main: !!x.main, volte: x.volte || null, notes: Array.isArray(x.notes) ? x.notes : [] })),
      unrated: this.allSites.filter(x => x.type === 'start' && !isNum(x.alt)).map(x => ({ id: x.id, name: x.name, lat: x.lat, lon: x.lon, status: x.status || null }))
    };
  }

  /** Wie sicher die Prognose eines Tages ist: Vorlauf und wie stark ICON und ECMWF auseinanderliegen (9–17 Uhr, alle Gebiete). */
  confidence(d, idx, now = Date.now()) {
    const today = zurichParts(now).date;
    const lead = Math.max(0, Math.round((Date.parse(this.dates[d]) - Date.parse(today)) / 86400000));
    const wind = [], rain = [], cloud = [];
    const ew = [], er = [], E = this.ctx.ens;
    let en = 0;
    if (E?.members >= ENS_MIN) for (const e of Object.values(E.byId || {})) {
      for (const i of idx) {
        const k = ensIdx(e, this.t[i]);
        const g = membersAt(e, 'wind_gusts_10m', k);
        if (g.length >= ENS_MIN) { ew.push((quantile(g, 0.9) - quantile(g, 0.1)) / 2); en = Math.max(en, g.length); }
        const pr = membersAt(e, 'precipitation', k);
        if (pr.length >= ENS_MIN) { const p = share(pr, x => x >= 0.3); er.push(p > 0.2 && p < 0.8 ? 1 : 0); }
      }
    }
    for (const a of Object.values(this.ctx.raw?.areas || {})) {
      const se = a.sea, ec = a.ecmwf;
      if (!se || !ec) continue;
      for (const i of idx) {
        const sw = se.wind_speed_10m?.[i], ew = ec.wind_speed_10m?.[i], sg = se.wind_gusts_10m?.[i], eg = ec.wind_gusts_10m?.[i];
        if (isNum(sw) && isNum(ew)) wind.push(Math.max(Math.abs(sw - ew), isNum(sg) && isNum(eg) ? Math.abs(sg - eg) * 0.6 : 0));
        const sp = se.precipitation?.[i], ep = ec.precipitation?.[i];
        if (isNum(sp) && isNum(ep)) rain.push((sp >= 0.3) !== (ep >= 0.3) && Math.max(sp, ep) >= 0.3 ? 1 : 0);
        const sc = se.cloud_cover?.[i], ecc = ec.cloud_cover?.[i];
        if (isNum(sc) && isNum(ecc)) cloud.push(Math.abs(sc - ecc));
      }
    }
    return dayConfidence({ lead, wind, rain, cloud, ens: ew.length ? { wind: ew, rain: er, n: en } : null });
  }

  headline(days, areas, sites, res) {
    const nowH = zurichParts(this.ctx.now).hour;
    let d = days.findIndex(x => x.top);
    if (d < 0) return { day: 0, tone: 'danger', title: 'Keine belastbare Prognose', text: 'Für die nächsten Tage liegen keine auswertbaren Daten vor.' };
    const dayName = d === 0 ? 'Heute' : d === 1 ? 'Morgen' : 'Am ' + this.dates[d].slice(8) + '.' + this.dates[d].slice(5, 7) + '.';
    const top = days[d].top;
    const site = sites.find(s => s.id === top.siteId);
    const b = top.best;
    const score = b.score;
    const tone = score >= 80 ? 'ok' : score >= 55 ? 'warn' : 'danger';
    let title;
    if (score >= 80) title = d === 0 ? 'Heute lohnt sich der Start' : `${dayName} sieht gut aus`;
    else if (score >= 55) title = `${dayName} nur mit Vorsicht`;
    else title = `${dayName} besser am Boden bleiben`;
    const win = `${b.from}–${b.to} Uhr`;
    let text = score >= 55
      ? `Bester Start: ${site.name}${(an => (an && !site.name.startsWith(an) ? ' (' + an + ')' : ''))(areas.find(a => a.id === top.areaId)?.name)}, ${win}, Score ${score}.`
      : `Selbst der beste Startplatz (${site.name}) erreicht nur ${score} von 100.`;
    // wichtigster Grund am besten Startplatz im Fenster
    const r = res.get(site.id);
    const counts = new Map();
    for (let i = 0; i < this.n; i++) {
      if (this.dayOf[i] !== d || !r?.hours[i]) continue;
      const hh = this.parts[i].hour;
      if (hh < b.from || hh >= b.to) continue;
      for (const x of [...r.hours[i].a.hard, ...(score < 80 ? r.hours[i].a.reasons.slice(0, 2) : [])]) counts.set(x, (counts.get(x) || 0) + 1);
    }
    const why = [...counts.entries()].sort((p, q) => q[1] - p[1]).slice(0, 2).map(x => x[0].replace(/^K\.-o\.: /, ''));
    if (why.length && score < 80) text += ' Hauptgrund: ' + why.join(', ') + '.';
    const reg = days[d];
    if (reg.regionStatus && reg.regionStatus !== 'ok') text += ` Regional: ${regionLabel(reg.regionWorst, reg.regionStatus)}.`;
    const after = score >= 55 ? this.afterWindow(r, d, b.to) : null;
    if (after) text += ` ${after}`;
    if (d === 0 && nowH > H1) text = 'Der Flugtag ist vorbei. ' + text;
    // dieselbe Aussage in Einzelteilen: die Startseite zeigt sie als ruhige Zeilen statt als Absatz
    return { day: d, tone, title, text, site: top.siteId, score, win: [b.from, b.to], why: score < 80 ? why : [],
      region: reg.regionStatus && reg.regionStatus !== 'ok' ? regionLabel(reg.regionWorst, reg.regionStatus) : null, over: d === 0 && nowH > H1, after };
  }

  /** Nach dem Startfenster: Was bringen die Wettervarianten? «Danach in 6 von 21 Varianten Bise.» (ab 20 %) */
  afterWindow(r, d, to) {
    let best = null;
    const pick = (p, what, h, n) => { if (isNum(p) && p >= 0.2 && (!best || p > best.p)) best = { p, what, h, n }; };
    for (let i = 0; i < this.n; i++) {
      if (this.dayOf[i] !== d || this.parts[i].hour < to || this.parts[i].hour > 18) continue;
      const e = r?.hours[i]?.w?.ens;
      if (!e) continue;
      pick(e.pBise, 'Bise', this.parts[i].hour, e.n); pick(e.pHard, 'starke Böen', this.parts[i].hour, e.n);
      pick(e.pRain, 'Regen', this.parts[i].hour, e.n); pick(e.pCape, 'Gewitterpotenzial', this.parts[i].hour, e.n); pick(e.pFoehn, 'Föhn', this.parts[i].hour, e.n);
    }
    return best ? `Danach (um ${best.h} Uhr) in ${Math.round(best.p * best.n)} von ${best.n} Wettervarianten ${best.what}.` : null;
  }

  regionPayload() {
    const out = [];
    this.dates.forEach((date, d) => {
      const hours = [];
      for (let i = 0; i < this.n; i++) {
        if (this.dayOf[i] !== d) continue;
        const h = this.parts[i].hour;
        if (h < H0 || h > H1) continue;
        const r = this.region[i];
        hours.push({
          h, front: r.front.level, frontWhy: r.front.level !== 'ok' ? r.front.why.slice(0, 2) : [],
          storm: stormLevel(r.cape, r.pop), cape: Math.round(r.cape), pop: Math.round(r.pop),
          foehn: r.foehn, dp: r.dp, bdp: r.bdp, bise: r.bise.level, biseWeak: !!r.bise.weak, biseWhy: r.bise.level !== 'ok' ? r.bise.why.slice(0, 2) : [], up800: r.u800 ? [Math.round(r.u800.speed), Math.round(r.u800.dir)] : null,
          up700: r.u700 ? [Math.round(r.u700.speed), Math.round(r.u700.dir)] : null,
          cb: isNum(r.cb) ? Math.round(r.cb / 50) * 50 : null, therm: r.therm,
          top: isNum(r.top) ? Math.round(r.top / 50) * 50 : null, inv: r.inversion,
          v: r.verdict.score, vs: r.verdict.status, worst: r.verdict.worst
        });
      }
      out.push({ date, hours });
    });
    const rg = this.ctx.regional;
    return {
      days: out,
      now: rg ? {
        foehn: rg.foehn, foehnScore: rg.foehnScore, bise: rg.biseScore, talwind: rg.talwindScore, reasons: rg.reasons,
        dpFoehn: rg.dp?.foehn ?? null, dpBise: rg.dp?.bise ?? null, dpTime: rg.dp?.time ?? null,
        fog: this.fogPayload()
      } : null
    };
  }

  /** Gemessener Nebel für die Lage: Schicht, Stationen, bis wann laut Prognose. */
  fogPayload() {
    const F = this.ctx.fog;
    if (!F?.obs) return null;
    if (F.obs.none) return { none: true, at: F.obs.at };
    const tl = F.tl, liftH = tl?.lift ? zurichParts(tl.lift).hour : null;
    return { at: F.obs.at, top: F.obs.top, base: F.obs.base, ground: F.obs.ground, range: F.obs.range, inn: F.obs.inn, under: F.obs.under, above: F.obs.above, seen: !!tl?.seen, lift: liftH, allDay: !!(tl?.seen && !tl.lift) };
  }

  /** Detailansicht eines Startplatzes. */
  siteDetail(siteId, levelId) {
    const site = this.sites.find(s => s.id === siteId);
    if (!site || !this.ok) return null;
    const r = this.compute(levelId).get(siteId);
    const R = v => (isNum(v) ? Math.round(v) : null);
    const days = this.dates.map((date, d) => {
      const hours = [];
      for (let i = 0; i < this.n; i++) {
        if (this.dayOf[i] !== d || !r.hours[i]) continue;
        const { a, w, prof } = r.hours[i];
        hours.push({
          h: this.parts[i].hour, score: a.score, cap: a.cap, status: a.status, hard: a.hard, reasons: a.reasons.slice(0, 6),
          why: explainHour(a, w, levelOf(levelId)),
          speed: R(w.speed), gust: R(w.gust), dir: R(w.dir), temp: R(this.ctx.raw.sites?.[siteId]?.temperature_2m?.[i]),
          cloudBase: R(w.cloudBase), cloudMargin: a.cloudMargin, pop: R(w.pop), cape: R(w.cape), sun: R(w.sun),
          cloud: R(w.cloudCover), sky: skyHour({ cloud: w.cloudCover, precip: w.precip, pop: w.pop, cape: w.cape }),
          thermal: a.thermal, topMargin: a.topMargin, thermalTop: R(a.thermalTop), wstar: w.thermik?.wstar ?? null, inversion: w.thermik?.inversion ?? null,
          head: R(a.headwind), tail: R(a.tailwind), wd: a.windDiff,
          valley: w.valley && isNum(w.valley.speed) ? [R(w.valley.speed), R(w.valley.gust)] : null,
          up800: R(w.up800), shear: R(w.shear?.shear500), spread: R(w.spread), nowBias: R(w.nowBias), dq: a.dataQuality,
          ens: w.ens ? { n: w.ens.n, g: w.ens.g, ph: w.ens.pHard, pr: w.ens.pRain, pc: w.ens.pCape, pb: w.ens.pBise, pf: w.ens.pFoehn } : null,
          later: w.biseLater ? { h: w.biseLater.hour, p: w.biseLater.p, n: w.biseLater.n } : null,
          fog: w.fog ? { k: w.fog.kind, s: w.fog.state, top: w.fog.top, base: w.fog.base } : null,
          prof: prof ? prof.map(p => [p.dz, p.speed, p.dir]) : null
        });
      }
      return { date, hours, best: this.daySummary(r, d).best };
    });
    return {
      ok: true, level: levelId, site: { id: site.id, name: site.name, area: site.area, alt: site.alt, aspects: site.aspects, lat: site.lat, lon: site.lon, pg: site.pg, type: site.type, status: site.status, season: site.season || null, source: site.source },
      nowcast: r.nowcast ? { station: r.nowcast.code, name: r.nowcast.name, dist: Math.round(r.nowcast.dist * 10) / 10, altDiff: Math.round(r.nowcast.alt - site.alt), obs: R(r.nowcast.obs), fc: R(r.nowcast.fc), obsGust: R(r.nowcast.obsGust), obsDir: R(r.nowcast.obsDir), fcDir: R(r.nowcast.fcDir), bias: R(r.nowcast.bias), ageMin: R(r.nowcast.age), at: r.nowcast.time || null } : null,
      days
    };
  }
}

export function regionLabel(worst, status) {
  const m = { front: 'Kaltfront', storm: 'Gewitterrisiko', foehn: 'Föhn', bise: 'Bise', valley: 'Talwind', upper: 'starker Höhenwind' };
  return `${m[worst] || 'Lage'} ${status === 'danger' ? '(K.-o.)' : '(Vorsicht)'}`;
}

/**
 * Sicherheit der Prognose für einen Tag: 0–100 und «gut», «mittel» oder «unsicher» mit Gründen.
 * lead: Tage voraus. wind: Unterschied ICON gegen ECMWF je Stunde und Gebiet (km/h, Böen zu 60 %),
 * rain: 1, wenn nur ein Modell Regen hat, cloud: Unterschied der Bewölkung in Prozent.
 */
export function dayConfidence({ lead = 0, wind = [], rain = [], cloud = [], ens = null } = {}) {
  const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  let s = 100;
  const why = [];
  const leadCut = [0, 5, 15, 25, 35, 45][Math.min(5, lead)];
  s -= leadCut;
  if (lead >= 2) why.push(`${lead} Tage voraus`);
  let w = avg(wind), r = avg(rain);
  const c = avg(cloud);
  // Mit Wettervarianten: deren Streuung (halbe Spanne der mittleren 80 % bei den Böen) statt ICON gegen ECMWF
  const ev = ens ? avg(ens.wind) : null, er = ens ? avg(ens.rain) : null;
  if (ev != null) {
    if (ev >= 9) { s -= 25; why.push(`${ens.n} Wettervarianten weit auseinander beim Wind (± ${Math.round(ev)} km/h)`); }
    else if (ev >= 6) { s -= 15; why.push(`Wettervarianten beim Wind etwas uneinig (± ${Math.round(ev)} km/h)`); }
    else if (ev >= 4) s -= 5;
    if (er != null && er >= 0.3) { s -= 20; why.push('Regen nur in einem Teil der Varianten'); }
    else if (er != null && er >= 0.15) { s -= 10; why.push('Regen nicht sicher'); }
    w = null; r = null;
    if (c != null && c >= 40) { s -= 15; why.push('Modelle uneinig bei den Wolken'); }
    else if (c != null && c >= 25) { s -= 8; why.push('Bewölkung nicht sicher'); }
    s = Math.max(0, Math.min(100, Math.round(s)));
    if (!why.length) why.push(`${ens.n} Wettervarianten sind sich einig`);
    return { score: s, level: s >= 75 ? 'gut' : s >= 50 ? 'mittel' : 'unsicher', why, ens: ens.n };
  }
  if (w == null) { s -= 10; why.push('kein Vergleichsmodell'); }
  else if (w >= 8) { s -= 25; why.push(`Modelle uneinig beim Wind (${Math.round(w)} km/h)`); }
  else if (w >= 5) { s -= 15; why.push(`Modelle beim Wind etwas uneinig (${Math.round(w)} km/h)`); }
  else if (w >= 3) s -= 5;
  if (r != null && r >= 0.3) { s -= 20; why.push('Modelle uneinig beim Regen'); }
  else if (r != null && r >= 0.15) { s -= 10; why.push('Regen nicht sicher'); }
  if (c != null && c >= 40) { s -= 15; why.push('Modelle uneinig bei den Wolken'); }
  else if (c != null && c >= 25) { s -= 8; why.push('Bewölkung nicht sicher'); }
  s = Math.max(0, Math.min(100, Math.round(s)));
  const level = s >= 75 ? 'gut' : s >= 50 ? 'mittel' : 'unsicher';
  if (!why.length) why.push(w != null ? 'ICON und ECMWF sind sich einig' : 'kurzer Vorlauf');
  return { score: s, level, why };
}
