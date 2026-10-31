// Plan-Berechnung: aus Rohdaten (Prognose, Messwerte, Regionallage) werden Stundenbewertungen,
// Startfenster je Tag, Gebietskarten und Lage-Raster. Läuft komplett auf dem Server.
import {
  clamp, isNum, haversineKm, zurichParts, solarPosition
} from './util.js';
import {
  LEVELS, levelOf, DEFAULT_LEVEL, assessHour, pickWindow, decisionFor, interpolateWind, windProfile,
  gustAtLaunch, cloudBaseMsl, frontRiskSeries, foehnFromAloft, foehnFromGradient, worstLevel, regionVerdict, thermalPotential, thermalProfile, explainHour,
  stormLevel
} from './scoring.js';
import { levelsAt } from './openmeteo.js';
import { localForHour } from './regional.js';

export const H0 = 6, H1 = 21;                // Auswertung 06–21 Uhr Ortszeit
export const NH = H1 - H0 + 1;
const MAX_DAYS = 5;

export const REF_POINT = { id: 'REF', lat: 46.68, lon: 7.86 };
/** Föhnpunkte: Druckunterschied Lugano minus Zürich-Kloten (Föhnregel). */
/** Bergstationen ab dieser Höhe korrigieren die Windprognose für Startplätze in der Nähe. */
export const MOUNTAIN_ALT = 1500;
export const MOUNTAIN_DECAY_H = 8;
/** Selbst nachkalibrieren: Böenfehler der Bergstationen der letzten Tage, zu diesem Anteil übernommen. */
export const LEARN_DAYS = 14, LEARN_MIN_N = 30, LEARN_WEIGHT = Number(globalThis.process?.env?.AFC_LEARN_WEIGHT ?? 0.6);
export const FOEHN_POINTS = [{ id: 'LUG', lat: 46.004, lon: 8.960 }, { id: 'KLO', lat: 47.480, lon: 8.536 }];

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
  }

  buildRegion() {
    const { raw, regional, trend, now } = this.ctx;
    const sea = raw.ref.sea, pl = raw.ref.pl;
    const lh = this.parts.map(p => p.hour);
    const spd = (k, i) => pl?.[`wind_speed_${k}hPa`]?.[i], dir = (k, i) => pl?.[`wind_direction_${k}hPa`]?.[i];
    // Druck an den Föhnpunkten zur Stunde (eigene Zeitreihen, nach Zeit zugeordnet)
    const pAt = s => { if (!s?.t || !s.pressure_msl) return () => null; const m = new Map(s.t.map((t, k) => [t, s.pressure_msl[k]])); return t => m.get(t) ?? null; };
    const pLug = pAt(raw.grad?.LUG), pKlo = pAt(raw.grad?.KLO);
    this.front = frontRiskSeries({
      P: sea.pressure_msl, T: sea.temperature_2m,
      D800: pl?.wind_direction_800hPa, S800: pl?.wind_speed_800hPa,
      CAPE: sea.cape, POP: sea.precipitation_probability, lh
    });
    // Typische Starthöhe der Region (Median der bewerteten Startplätze) als Bezug für die Wolkenbasis
    const alts = this.sites.map(s => s.alt).filter(isNum).sort((a, b) => a - b);
    const launchAlt = alts.length ? alts[Math.floor(alts.length / 2)] : 1800;
    this.region = [];
    for (let i = 0; i < this.n; i++) {
      const u800 = isNum(spd(800, i)) ? { speed: spd(800, i), dir: dir(800, i) } : null;
      const u700 = isNum(spd(700, i)) ? { speed: spd(700, i), dir: dir(700, i) } : null;
      const prev = isNum(spd(800, Math.max(0, i - 3))) ? spd(800, Math.max(0, i - 3)) : null;
      const rising = !!(u800 && prev !== null && u800.speed - prev >= 15);
      const pl1 = pLug(this.t[i]), pk1 = pKlo(this.t[i]);
      const dp = isNum(pl1) && isNum(pk1) ? Math.round((pl1 - pk1) * 10) / 10 : null;
      const foehnModel = worstLevel(foehnFromAloft(u800, u700), foehnFromGradient(dp));
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
      const verdict = regionVerdict({ front: this.front[i], cape, pop, foehn, up800: u800, rising });
      this.region.push({
        i, front: this.front[i], foehnModel, dp, foehn, local, u800, u700, rising, cape, pop, cb, sun,
        therm: thermalPotential({ sun, cape, cloudMargin: isNum(cb) ? cb - launchAlt : null, rainRisk: pop, topMargin: tp ? Math.min(tp.top, isNum(cb) ? cb : Infinity) - launchAlt : null, wstar: tp?.wstar }),
        top: tp ? Math.min(tp.top, isNum(cb) ? cb : Infinity) : null, inversion: tp?.inversion ?? null,
        verdict
      });
    }
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
      if (!best || score < best.score) best = { code, name: m.name || code, dist, score, alt: m.alt, mountain: mtn, obs: o.wind, fc: f, bias: clamp(o.wind - f, -12, mtn ? 15 : 12), gustBias: isNum(o.gust) && isNum(fc.wind_gusts_10m?.[i]) ? clamp(o.gust - fc.wind_gusts_10m[i], -15, 20) : null, obsGust: o.gust, obsDir: o.dir, fcDir: fc.wind_direction_10m?.[i], age };
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
      if (!m || !isNum(m.alt) || m.alt < MOUNTAIN_ALT || !(l.n >= LEARN_MIN_N) || !isNum(l.gust)) continue;
      const dist = haversineKm(site.lat, site.lon, m.lat, m.lon);
      if (dist > 20 || Math.abs(m.alt - site.alt) > 700) continue;
      if (!best || dist < best.dist) best = { code, name: m.name || code, dist, n: l.n, gust: l.gust, add: clamp(l.gust * LEARN_WEIGHT, 0, 10) };
    }
    return best;
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
    const lg = out.learned = this.learnedFor(site);
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
      const nowAdd = keep ? Math.max(0, nb.gustBias ?? nb.bias) * decay : 0, learnAdd = lg?.add ?? 0;
      if (!keep) {
        if (isNum(speed)) speed = Math.max(0, speed + bias);
        if (isNum(gust)) gust = Math.max(speed ?? 0, gust + bias);
      }
      const add = Math.max(nowAdd, learnAdd);
      if (add > 0 && isNum(gust)) gust = Math.max(speed ?? 0, gust + add);
      if (add >= 4) mtnGust = nowAdd >= learnAdd ? { name: nb.name, add, why: 'now' } : { name: lg.name, add, why: 'learned', days: LEARN_DAYS };
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
      const w = {
        ms: this.t[i], speed, gust, dir, speed10: s10,
        cloudBase, cloudCover: fc.cloud_cover?.[i], cloudCoverLow: fc.cloud_cover_low?.[i],
        pop: fc.precipitation_probability?.[i] ?? reg.pop, precip: fc.precipitation?.[i], cape: fc.cape?.[i] ?? reg.cape,
        sun: fc.shortwave_radiation?.[i] ?? 0,
        valley: se ? { speed: se.wind_speed_10m?.[i], gust: se.wind_gusts_10m?.[i] } : null,
        mtnGust, front: reg.front, foehn: reg.foehnModel, foehnDp: reg.dp, local: reg.local,
        trend: ha < 3 && trend && reg.local ? { foehn: trend.foehn } : null,
        shear: prof ? { shear500: prof.shear500, turn1000: prof.turn1000 } : null,
        spread, nowBias: nb && !keep ? bias : null, thermik, later,
        up800: reg.u800?.speed, up700: reg.u700?.speed,
        windSource: isNum(s10) ? 'ICON-CH 10 m' : 'Höhenmodell'
      };
      const a = assessHour(site, w, lv);
      out.hours[i] = { a, w, prof: prof?.points || null, shear: prof };
    }
    return out;
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

  /** Kompakte Antwort für die App (alle Gebiete/Startplätze, alle Tage). */
  planPayload(levelId) {
    const { now, fetchedAt } = this.ctx;
    const lvl = LEVELS[levelId] ? levelId : DEFAULT_LEVEL;
    if (!this.ok) return { ok: false, level: lvl, now: new Date(now).toISOString() };
    const res = this.compute(lvl);
    const sites = [];
    for (const site of this.sites) {
      const r = res.get(site.id);
      const days = this.dates.map((_, d) => r ? this.daySummary(r, d) : { scores: new Array(NH).fill(null), best: null });
      sites.push({
        id: site.id, name: site.name, area: site.area, type: site.type, lat: site.lat, lon: site.lon, alt: site.alt,
        aspects: site.aspects, pg: site.pg, status: site.status, season: site.season || null, blocked: site.blocked,
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
      return { id: a.id, name: a.name, lat: a.lat, lon: a.lon, sites: ids, days };
    });
    const days = this.dates.map((date, d) => {
      let top = null;
      for (const a of areas) { const b = a.days[d]; if (b && (!top || b.best.score > top.best.score)) top = { areaId: a.id, ...b }; }
      const idx = [];
      for (let i = 0; i < this.n; i++) if (this.dayOf[i] === d && this.parts[i].hour >= 9 && this.parts[i].hour <= 17) idx.push(i);
      const rs = idx.map(i => this.region[i].verdict.score);
      const regionScore = rs.length ? Math.round(rs.reduce((p, c) => p + c, 0) / rs.length) : null;
      const worst = idx.map(i => this.region[i].verdict).sort((p, q) => p.score - q.score)[0];
      return { date, top, regionScore, regionWorst: worst ? worst.worst : null, regionStatus: worst ? worst.status : null };
    });
    return {
      ok: true, level: lvl, now: new Date(now).toISOString(), fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
      h0: H0, dates: this.dates, days, headline: this.headline(days, areas, sites, res),
      areas, sites, region: this.regionPayload(),
      landings: this.allSites.filter(x => x.type === 'landing').map(x => ({ id: x.id, name: x.name, area: x.area, lat: x.lat, lon: x.lon, alt: x.alt, status: x.status || null })),
      unrated: this.allSites.filter(x => x.type === 'start' && !isNum(x.alt)).map(x => ({ id: x.id, name: x.name, lat: x.lat, lon: x.lon, status: x.status || null }))
    };
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
      ? `Bester Start: ${site.name} (${areas.find(a => a.id === top.areaId)?.name || ''}), ${win}, Score ${score}.`
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
    if (d === 0 && nowH > H1) text = 'Der Flugtag ist vorbei. ' + text;
    return { day: d, tone, title, text, site: top.siteId, score };
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
          foehn: r.foehn, dp: r.dp, up800: r.u800 ? [Math.round(r.u800.speed), Math.round(r.u800.dir)] : null,
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
        foehn: rg.foehn, foehnScore: rg.foehnScore, bise: rg.biseScore, talwind: rg.talwindScore, reasons: rg.reasons
      } : null
    };
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
          thermal: a.thermal, topMargin: a.topMargin, thermalTop: R(a.thermalTop), wstar: w.thermik?.wstar ?? null, inversion: w.thermik?.inversion ?? null,
          head: R(a.headwind), tail: R(a.tailwind), wd: a.windDiff,
          valley: w.valley && isNum(w.valley.speed) ? [R(w.valley.speed), R(w.valley.gust)] : null,
          up800: R(w.up800), shear: R(w.shear?.shear500), spread: R(w.spread), nowBias: R(w.nowBias), dq: a.dataQuality,
          prof: prof ? prof.map(p => [p.dz, p.speed, p.dir]) : null
        });
      }
      return { date, hours, best: this.daySummary(r, d).best };
    });
    return {
      ok: true, level: levelId, site: { id: site.id, name: site.name, area: site.area, alt: site.alt, aspects: site.aspects, lat: site.lat, lon: site.lon, pg: site.pg, type: site.type, status: site.status, season: site.season || null, source: site.source },
      nowcast: r.nowcast ? { station: r.nowcast.code, name: r.nowcast.name, dist: Math.round(r.nowcast.dist * 10) / 10, altDiff: Math.round(r.nowcast.alt - site.alt), obs: R(r.nowcast.obs), fc: R(r.nowcast.fc), obsGust: R(r.nowcast.obsGust), obsDir: R(r.nowcast.obsDir), fcDir: R(r.nowcast.fcDir), bias: R(r.nowcast.bias), ageMin: R(r.nowcast.age) } : null,
      days
    };
  }
}

export function regionLabel(worst, status) {
  const m = { front: 'Kaltfront', storm: 'Gewitterrisiko', foehn: 'Föhn', valley: 'Talwind', upper: 'starker Höhenwind' };
  return `${m[worst] || 'Lage'} ${status === 'danger' ? '(K.-o.)' : '(Vorsicht)'}`;
}
