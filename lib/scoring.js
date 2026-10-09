// Bewertungslogik von AFC. Reine Funktionen ohne Netzwerk, ohne Datenbank und ohne
// globalen Zustand, damit sie sich testen lassen (test/scoring.test.js).
//
// Grundprinzip (Quellen: DHV-Magazin, SHV-Prüfungskatalog, MeteoSchweiz):
//   1. K.-o.-Kriterien: Kaltfront, Gewitter, Föhn-Durchbruch, zu starker Wind/Böen, Regen,
//      Wolke am Startplatz. Der Score wird gedeckelt, gute Thermik gleicht das nicht aus.
//   2. Starke Abzüge: Böigkeit, Rückenwind, Windscherung, Regen möglich, Frontnähe, Landewind.
//   3. Leichte Abzüge/Bonus: Höhenwind, Thermik, Hangbesonnung, Gelände.
import {
  clamp, isNum, windDiff, windComponent, toVector, fromVector, solarPosition
} from './util.js';

/* ---------------------------------------------------------------- Erfahrungsstufen */
export const LEVELS = {
  careful: { id: 'careful', label: 'Vorsichtig', windSoft: 18, windStrong: 24, windHard: 30, gustHard: 34, gustExSoft: 6, gustExStrong: 10, minHead: 6, shearScale: 0.8 },
  normal:  { id: 'normal',  label: 'Normal',     windSoft: 22, windStrong: 28, windHard: 35, gustHard: 40, gustExSoft: 8, gustExStrong: 12, minHead: 5, shearScale: 1 },
  expert:  { id: 'expert',  label: 'Erfahren',   windSoft: 26, windStrong: 32, windHard: 40, gustHard: 46, gustExSoft: 10, gustExStrong: 15, minHead: 4, shearScale: 1.25 }
};
export const DEFAULT_LEVEL = 'normal';
export const levelOf = id => LEVELS[id] || LEVELS[DEFAULT_LEVEL];

/** Deckel je K.-o.-Grund (Reihenfolge = Priorität des ersten Treffers). */
const CAP_RULES = [
  [/Front/, 30],
  [/Gewitter|Konvektion/, 35],
  [/Föhn/, 35],
  [/Wind am Startplatz|Böen/, 35],
  [/Niederschlag|Regen/, 40],
  [/Wolke/, 45],
  [/Rückenwind|Abwind/, 45]
];
export const KO_PREFIX = 'K.-o.: ';

/* ---------------------------------------------------------------- Entscheidung */
export function decisionFor(score) {
  if (!isNum(score)) return { id: 'unknown', label: 'UNSICHER', cls: 'warn', detail: 'Noch nicht genug belastbare Daten' };
  if (score >= 85) return { id: 'go', label: 'Starten', cls: 'ok', detail: 'Sehr gute Ausgangslage' };
  if (score >= 80) return { id: 'ready', label: 'Startbereit', cls: 'ok', detail: 'Gute Ausgangslage, Startkontrolle vor Ort' };
  if (score >= 70) return { id: 'check', label: 'Prüfen', cls: 'warn', detail: 'Brauchbar, Details prüfen' };
  if (score >= 55) return { id: 'wait', label: 'Abwarten', cls: 'warn', detail: 'Kein klares Startsignal' };
  return { id: 'nogo', label: 'Nicht starten', cls: 'danger', detail: 'Bedingungen zu ungünstig' };
}

/* ---------------------------------------------------------------- Wind in der Höhe */
/** levels: [{z, speed, dir}] (Meter MSL, km/h, Grad). Interpoliert vektoriell auf targetAlt. */
export function interpolateWind(levels, targetAlt) {
  const pts = (levels || []).filter(l => isNum(l.z) && isNum(l.speed) && isNum(l.dir)).sort((a, b) => a.z - b.z);
  if (!pts.length || !isNum(targetAlt)) return null;
  const at = l => ({ speed: l.speed, dir: l.dir });
  if (targetAlt <= pts[0].z) return { ...at(pts[0]), source: 'unterstes Druckniveau' };
  const top = pts[pts.length - 1];
  if (targetAlt >= top.z) return { ...at(top), source: 'oberstes Druckniveau' };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (targetAlt >= a.z && targetAlt <= b.z) {
      const f = (targetAlt - a.z) / (b.z - a.z || 1);
      const va = toVector(a.speed, a.dir), vb = toVector(b.speed, b.dir);
      const w = fromVector(va.u + (vb.u - va.u) * f, va.v + (vb.v - va.v) * f);
      return { ...w, source: `interpoliert ${Math.round(a.z)}–${Math.round(b.z)} m` };
    }
  }
  return null;
}

/** Windprofil über dem Startplatz plus Scherung als Turbulenzindikator (modellbasiert). */
export function windProfile(levels, alt) {
  const heights = [0, 250, 500, 1000, 1500].map(d => alt + d);
  const pts = heights.map((z, i) => {
    const w = interpolateWind(levels, z);
    return w ? { dz: [0, 250, 500, 1000, 1500][i], z: Math.round(z), speed: Math.round(w.speed), dir: Math.round(w.dir) } : null;
  });
  const p0 = pts[0], p500 = pts[2], p1000 = pts[3];
  const vecDiff = (a, b) => {
    if (!a || !b) return null;
    const va = toVector(a.speed, a.dir), vb = toVector(b.speed, b.dir);
    return Math.hypot(va.u - vb.u, va.v - vb.v);
  };
  const turn = (a, b) => (a && b && a.speed >= 10 && b.speed >= 10 ? windDiff(a.dir, b.dir) : null);
  return {
    points: pts.filter(Boolean),
    shear500: vecDiff(p0, p500),
    shear1000: vecDiff(p0, p1000),
    turn1000: turn(p0, p1000)
  };
}

/** Böen am Startplatz: 10-m-Böen, aber nie weniger als der (höhenkorrigierte) Wind mal Böenfaktor. */
export function gustAtLaunch(speedAlt, speed10, gust10) {
  if (!isNum(speedAlt)) return isNum(gust10) ? gust10 : null;
  const base = isNum(speed10) ? Math.max(speed10, 4) : 6;
  const ratio = isNum(gust10) ? clamp(gust10 / base, 1.25, 2.0) : 1.45;
  return Math.max(isNum(gust10) ? gust10 : 0, speedAlt * ratio);
}

/* ---------------------------------------------------------------- Thermik */
/** Wolkenbasis (Kumulus-Kondensationsniveau) über Meer: 125 m je Grad Taupunktdifferenz. */
export function cloudBaseMsl(tempC, dewC, groundAlt) {
  if (!isNum(tempC) || !isNum(dewC) || !isNum(groundAlt)) return null;
  return Math.round(groundAlt + Math.max(0, 125 * (tempC - dewC)));
}
/** Deardorff-Konvektionsgeschwindigkeit w* (grobe Schätzung, ~20 % der Strahlung als fühlbarer Wärmestrom). */
export function convectiveVelocity(zi, tempC, shortwave) {
  if (!(zi > 0) || !(shortwave > 0) || !isNum(tempC)) return 0;
  const kin = (0.2 * shortwave) / (1.15 * 1005);
  const w3 = (9.81 / (tempC + 273.15)) * zi * kin;
  return w3 > 0 ? Math.cbrt(w3) : 0;
}
export function thermalPotential(w) {
  let t = 0;
  const sun = w.sun || 0, cape = w.cape || 0, rain = w.rainRisk || 0;
  if (sun > 550) t += 28; else if (sun > 400) t += 22; else if (sun > 250) t += 14; else if (sun > 120) t += 6;
  if (cape > 1400) t += 18; else if (cape > 900) t += 14; else if (cape > 500) t += 9; else if (cape > 250) t += 4;
  const cb = isNum(w.cloudMargin) ? w.cloudMargin : null; // Basis über Startplatz
  if (cb !== null) { if (cb >= 1400) t += 18; else if (cb >= 900) t += 12; else if (cb >= 400) t += 5; else if (cb < 150) t -= 18; }
  if (rain > 70) t -= 45; else if (rain > 50) t -= 30; else if (rain > 30) t -= 18; else if (rain > 15) t -= 8;
  return clamp(Math.round(t), 0, 100);
}
export function terrainThermalFactor(site, w, ms) {
  const tr = site.terrain || {};
  const sun = solarPosition(ms, site.lat, site.lon);
  const radiation = clamp((w.sun || 0) / 650, 0, 1);
  if (sun.elevationDeg <= 5 || radiation <= 0.05) return { score: 0, sun, detail: null };
  const aspects = site.aspects?.length ? site.aspects : [isNum(tr.terrainAspect) ? tr.terrainAspect : 180];
  let aspect = aspects[0], best = -1;
  for (const a of aspects) { const c = Math.cos((sun.azimuthDeg - a) * Math.PI / 180); if (c > best) { best = c; aspect = a; } }
  const slope = clamp(Number(tr.slopeDeg) || 20, 0, 50);
  const aspectAlign = Math.max(0, best);
  const elevFactor = Math.max(0, Math.sin(sun.elevationDeg * Math.PI / 180));
  const slopeFactor = 0.65 + 0.35 * Math.cos(slope * Math.PI / 180);
  const hm = tr.horizonAngles || {};
  const keys = Object.keys(hm);
  const nearest = keys.length ? keys.reduce((b, k) => (Math.abs(Number(k) - sun.azimuthDeg) < Math.abs(Number(b) - sun.azimuthDeg) ? k : b), keys[0]) : null;
  const horizon = nearest != null ? Number(hm[nearest]) : 0;
  const horizonFactor = sun.elevationDeg > horizon + 8 ? 1 : sun.elevationDeg > horizon ? 0.82 : 0.55;
  const incidence = clamp(0.45 + 0.55 * aspectAlign * elevFactor, 0, 1) * slopeFactor * horizonFactor;
  const rel = Number(tr.relief500m) || 0;
  const complexity = rel > 1200 ? -3 : rel > 700 ? -2 : rel > 250 ? 1 : 0;
  return { score: Math.round(22 * radiation * incidence) + complexity, sun, detail: `Sonne ${Math.round(sun.elevationDeg)}° bei ${Math.round(sun.azimuthDeg)}°, Hangsonne ${Math.round(incidence * 100)} %` };
}
export function terrainLaunchFactor(site) {
  const tr = site.terrain || {};
  const slope = Number(tr.slopeDeg), relief = Number(tr.relief250m ?? tr.relief500m);
  const out = { score: 0, detail: [] };
  if (isNum(slope)) {
    if (slope >= 12 && slope <= 38) out.score += 5;
    else if (slope < 8) { out.score -= 4; out.detail.push('Gelände wenig geneigt'); }
    else if (slope > 45) { out.score -= 5; out.detail.push('sehr steiles Gelände'); }
  }
  if (isNum(relief)) {
    if (relief > 900) { out.score -= 4; out.detail.push('sehr reliefreich'); }
    else if (relief < 100) out.score -= 1;
  }
  return out;
}

/* ---------------------------------------------------------------- Start-Anströmung */
export function startWindQuality(speed, diff, lv = LEVELS.normal) {
  if (!isNum(speed) || !isNum(diff)) return { penalty: 0, hard: null, reason: null, headwind: null, tailwind: null };
  const rad = diff * Math.PI / 180;
  const headwind = Math.max(0, speed * Math.cos(rad)), tailwind = Math.max(0, -speed * Math.cos(rad));
  let penalty = 0, hard = null, reason = null;
  if (diff <= 35) {
    if (headwind < lv.minHead) { penalty += 10; reason = 'zu wenig nutzbarer Anblaswind'; }
    else if (headwind > 32) { penalty += 30; hard = 'Wind am Startplatz: Aufwind am Start zu kräftig'; }
    else if (headwind > 26) { penalty += 19; reason = 'sehr kräftiger Aufwind, Startfenster eingeschränkt'; }
    else if (headwind > 21) { penalty += 10; reason = 'kräftiger Aufwind, Starttechnik beachten'; }
  } else if (diff <= 75) {
    if (headwind < 4) { penalty += 11; reason = 'wenig nutzbarer Anblaswind'; }
    else if (headwind > 24) { penalty += 13; reason = 'kräftige seitliche Anströmung'; }
  }
  if (diff > 135 || tailwind >= 8) { penalty += 36; hard = hard || 'Rückenwind/Abwind am Start'; }
  return { penalty, hard, reason, headwind, tailwind };
}

/* ---------------------------------------------------------------- Front / Föhn / Gewitter */
export const LVL = { ok: 0, warn: 1, danger: 2 };
export const worseLevel = (a, b) => (LVL[b] > LVL[a] ? b : a);

/**
 * Frontrisiko je Stunde aus der Prognose eines Referenzpunkts.
 * s: { P, T, D800, S800, CAPE, POP, lh } (gleich lange Arrays; lh = Ortsstunde).
 * Signale: Druckfall/-anstieg in 6 h, Windsprung auf 2000 m, Temperatursturz tagsüber, Schauer mit CAPE.
 * Für K.-o. braucht es mindestens zwei Signale. Wer jetzt startet, ist 1–3 h oben: Maximum der nächsten 3 h.
 */
export function frontRiskSeries(s) {
  const n = (s.P || []).length;
  const F = isNum;
  const base = [];
  for (let i = 0; i < n; i++) {
    let sc = 0, sig = 0;
    const why = [];
    const i0 = Math.max(0, i - 3), i1 = Math.min(n - 1, i + 3);
    if (F(s.P[i0]) && F(s.P[i1])) {
      const dp = s.P[i1] - s.P[i0];
      if (dp <= -3) { sc += 30; sig++; why.push(`Druckfall ${(-dp).toFixed(1)} hPa in 6 h`); }
      else if (dp <= -1.5) { sc += 14; why.push(`Druckfall ${(-dp).toFixed(1)} hPa in 6 h`); }
      else if (dp >= 3) { sc += 30; sig++; why.push(`Druckanstieg ${dp.toFixed(1)} hPa in 6 h (Rückseite einer Front)`); }
    }
    const j0 = Math.max(0, i - 2);
    if (F(s.D800?.[j0]) && F(s.D800?.[i1]) && F(s.S800?.[j0]) && F(s.S800?.[i1])) {
      const sh = windDiff(s.D800[j0], s.D800[i1]), sp = Math.max(s.S800[j0], s.S800[i1]);
      if (sh >= 60 && sp >= 20) { sc += 26; sig++; why.push(`Windsprung ${Math.round(sh)}° auf 2000 m`); }
      else if (sh >= 40 && sp >= 15) sc += 10;
    }
    const hr = s.lh?.[i];
    const i3 = Math.min(n - 1, i + 3);
    if (hr >= 9 && hr <= 17 && F(s.T?.[i]) && F(s.T?.[i3]) && s.T[i] - s.T[i3] >= 3) {
      sc += 20; sig++; why.push(`Temperatursturz ${(s.T[i] - s.T[i3]).toFixed(1)} °C in 3 h`);
    }
    if (F(s.POP?.[i1]) && s.POP[i1] >= 60 && F(s.CAPE?.[i1]) && s.CAPE[i1] >= 300) { sc += 14; sig++; why.push('Schauer- und Gewitterpotenzial im Frontbereich'); }
    const level = (sc >= 55 && sig >= 2) ? 'danger' : (sc >= 30 && sig >= 1) ? 'warn' : 'ok';
    base.push({ level, score: sc, why });
  }
  return base.map((b, i) => {
    let w = b;
    for (let k = i + 1; k <= Math.min(n - 1, i + 3); k++) if (LVL[base[k].level] > LVL[w.level]) w = base[k];
    return w;
  });
}

/** Föhn aus dem Höhenwind (Südkomponente). 3000 m entscheidet, 2000 m kann nur warnen. */
export function foehnFromAloft(up800, up700) {
  let level = 'ok';
  if (up700 && isNum(up700.speed)) {
    const south = Math.cos((up700.dir - 180) * Math.PI / 180);
    if (south > 0.7 && up700.speed > 40) level = 'danger';
    else if (south > 0.5 && up700.speed > 25) level = 'warn';
  }
  if (level === 'ok' && up800 && isNum(up800.speed)) {
    const south = Math.cos((up800.dir - 180) * Math.PI / 180);
    if (south > 0.6 && up800.speed >= 30) level = 'warn';
  }
  return level;
}

export const stormLevel = (cape, pop) => ((cape > 800 || pop > 70) ? 'danger' : (cape > 300 || pop > 40) ? 'warn' : 'ok');
export const upperWindLevel = (kmh, rising) => (kmh >= 60 ? 'danger' : (kmh >= 40 || rising) ? 'warn' : 'ok');

/**
 * Regionales Urteil je Stunde (Lage-Tab, Tagesprozent). K.-o.-Faktoren entscheiden allein,
 * alles andere sind gewichtete Abzüge.
 */
export function regionVerdict(h) {
  const factors = {
    front: h.front?.level || 'ok',
    storm: stormLevel(h.cape || 0, h.pop || 0),
    foehn: h.foehn || 'ok',
    upper: upperWindLevel(h.up800?.speed || 0, !!h.rising)
  };
  if (h.valleyLevel) factors.valley = h.valleyLevel;
  const KO = ['front', 'storm', 'foehn'];
  const PEN = { front: { warn: 30, danger: 100 }, storm: { warn: 25, danger: 100 }, foehn: { warn: 25, danger: 100 }, valley: { warn: 15, danger: 35 }, upper: { warn: 8, danger: 20 } };
  let score = 100, worst = null, worstPen = 0, ko = false;
  for (const [k, v] of Object.entries(factors)) {
    const pen = PEN[k]?.[v] || 0;
    if (KO.includes(k) && v === 'danger') ko = true;
    score -= pen;
    if (pen > worstPen) { worstPen = pen; worst = k; }
  }
  score = ko ? 0 : Math.max(0, score);
  return { score, status: (ko || score < 40) ? 'danger' : score < 75 ? 'warn' : 'ok', worst, factors };
}

/* ---------------------------------------------------------------- Bewertung einer Stunde */
/**
 * site: { alt, aspects, terrain, lat, lon, blocked }
 * w:    { ms, speed, gust, dir, speed10, cloudBase, cloudCover, pop, precip, cape, sun, valley:{speed,gust},
 *         front, foehn, local, trend, shear:{shear500,turn1000}, spread, nowBias }
 * lv:   LEVELS[...]
 */
export function assessHour(site, w, lv = LEVELS.normal) {
  if (site.blocked) {
    return { score: 0, cap: 0, status: 'danger', hard: [KO_PREFIX + 'Startplatz nicht für Gleitschirme freigegeben'], reasons: [], thermal: 0, decision: decisionFor(0) };
  }
  const reasons = [], hard = [];
  let s = 100, cap = 100;
  const speed = isNum(w.speed) ? w.speed : 0;
  const gust = isNum(w.gust) ? w.gust : speed;
  const rain = Math.max(isNum(w.pop) ? w.pop : 0, w.precip >= 1 ? 80 : w.precip >= 0.3 ? 55 : w.precip >= 0.1 ? 30 : 0);
  const cape = isNum(w.cape) ? w.cape : 0;
  const alt = isNum(site.alt) ? site.alt : null;

  // Wind und Böen am Startplatz
  if (speed > lv.windHard) { s -= 42; hard.push('Wind am Startplatz sehr stark'); }
  else if (speed > lv.windStrong) { s -= 28; reasons.push('kräftiger Wind am Startplatz'); }
  else if (speed > lv.windSoft) { s -= 15; reasons.push('stärkerer Wind'); }
  else if (speed < 5) { s -= 12; reasons.push('sehr wenig Wind'); }
  else if (speed < 8) { s -= 4; reasons.push('leichter Wind'); }
  const gustEx = Math.max(0, gust - speed);
  if (gust >= lv.gustHard) { s -= 35; hard.push('starke Böen'); }
  else if (gustEx >= lv.gustExStrong) { s -= 20; reasons.push('deutliche Böen'); }
  else if (gustEx >= lv.gustExSoft) { s -= 9; reasons.push('Böigkeit'); }

  // Anströmung
  let wd = null, headwind = null, tailwind = null;
  if (site.aspects?.length && isNum(w.dir)) {
    wd = Math.min(...site.aspects.map(x => windDiff(w.dir, x)));
    if (wd > 75) { s -= 18; reasons.push('Anströmung nicht optimal'); }
    else if (wd > 35) { s -= 7; reasons.push('leicht seitliche Anströmung'); }
    const q = startWindQuality(speed, wd, lv);
    s -= q.penalty; if (q.hard) hard.push(q.hard); if (q.reason) reasons.push(q.reason);
    headwind = q.headwind; tailwind = q.tailwind;
  }

  // Wolkenbasis über dem Startplatz (nur relevant, wenn sich überhaupt Wolken bilden)
  let cloudMargin = null;
  if (alt !== null && isNum(w.cloudBase)) {
    cloudMargin = Math.round(w.cloudBase - alt);
    const cover = Math.max(w.cloudCoverLow || 0, (w.cloudCover || 0) * 0.7);
    if (cover >= 30) {
      if (cloudMargin < 200) { s -= 38; hard.push('Wolke am Startplatz, Basis zu nah'); }
      else if (cloudMargin < 400) { s -= 20; reasons.push('geringe Reserve zur Wolkenbasis'); }
      else if (cloudMargin < 700) { s -= 8; reasons.push('begrenzte Wolkenbasisreserve'); }
    } else if (cover >= 10 && cloudMargin < 200) { s -= 8; reasons.push('Wolkenbildung am Startplatz möglich'); }
  }

  // Niederschlag und Konvektion
  if (rain >= 70) { s -= 42; hard.push('hohe Niederschlagswahrscheinlichkeit'); }
  else if (rain >= 45) { s -= 25; reasons.push('erhöhtes Regenrisiko'); }
  else if (rain >= 25) { s -= 9; reasons.push('Regen möglich'); }
  if (cape >= 1200) { s -= 28; hard.push('hohes Gewitterpotenzial (Konvektion)'); }
  else if (cape >= 800) { s -= 14; reasons.push('erhöhte Konvektion'); }
  else if (cape >= 500) { s -= 6; reasons.push('spürbare Konvektion'); }

  // Landeplatz
  if (w.valley && isNum(w.valley.speed)) {
    const v = Math.max(w.valley.speed, 0.75 * (w.valley.gust || 0));
    if (v >= 35) { s -= 32; reasons.push('starker Landewind'); }
    else if (v >= 28) { s -= 18; reasons.push('kräftiger Landewind'); }
    else if (v >= 22) { s -= 8; reasons.push('Landewind beachten'); }
  }

  // Front: K.-o. bei klarem Signal, sonst Warnung mit Deckel
  const fr = w.front;
  if (fr?.level === 'danger') { s -= 40; hard.push('Kaltfront/Frontdurchgang erwartet (' + (fr.why?.[0] || 'Drucktendenz') + ')'); }
  else if (fr?.level === 'warn') { s -= 14; cap = Math.min(cap, 62); reasons.push('Frontnähe: ' + (fr.why?.[0] || 'Drucktendenz auffällig')); }

  // Höhenwind: bewusst nur leichter Abzug
  if (isNum(w.up800)) { if (w.up800 >= 50) { s -= 8; reasons.push('kräftiger Höhenwind (2000 m)'); } else if (w.up800 >= 40) { s -= 4; reasons.push('Höhenwind spürbar'); } }
  if (isNum(w.up700)) { if (w.up700 >= 75) { s -= 6; reasons.push('starker Höhenwind (3000 m)'); } else if (w.up700 >= 60) s -= 3; }

  // Windscherung über dem Startplatz (Turbulenz-/Rotorindikator, modellbasiert)
  const sh = w.shear;
  if (sh) {
    const k = lv.shearScale || 1;
    if (isNum(sh.shear500)) {
      if (sh.shear500 >= 30 * k) { s -= 12; reasons.push('starke Windscherung über dem Startplatz'); }
      else if (sh.shear500 >= 20 * k) { s -= 6; reasons.push('Windscherung über dem Startplatz'); }
    }
    if (isNum(sh.turn1000) && sh.turn1000 >= 90 && speed >= 15) { s -= 8; reasons.push('Wind dreht stark mit der Höhe (Lee-/Rotorgefahr)'); }
  }

  // Föhn (Modell) und regionale Messungen
  if (w.foehn === 'danger') { s -= 28; hard.push('Föhn-Durchbruch möglich'); }
  else if (w.foehn === 'warn') { s -= 12; reasons.push('Föhnsignal möglich'); }
  if (w.local) {
    if (w.local.foehn === 'danger') { s -= 24; hard.push('regionales Föhnsignal (Messwerte)'); }
    else if (w.local.foehn === 'warn') { s -= 10; reasons.push('regionaler Föhnindikator'); }
    if (w.local.biseScore >= 70 && site.aspects?.length) {
      const bestBise = Math.min(...site.aspects.map(x => windDiff(45, x)));
      if (bestBise > 90) { s -= 14; reasons.push('Bise im Vorland wahrscheinlich'); }
    }
    if (w.local.talwindScore >= 55) reasons.push('Talwind Richtung Oberland verstärkt sich');
  }
  if (w.trend?.foehn > 12) { s -= 8; reasons.push('Föhntrend nimmt zu'); }

  // Messung weicht von der Prognose ab (Nowcasting)
  if (isNum(w.nowBias) && Math.abs(w.nowBias) >= 6) reasons.push(`Messung liegt ${w.nowBias > 0 ? 'über' : 'unter'} der Prognose (${w.nowBias > 0 ? '+' : ''}${Math.round(w.nowBias)} km/h), korrigiert`);

  // Modellunsicherheit
  if (isNum(w.spread)) {
    if (w.spread >= 10) { s -= 5; reasons.push('Wettermodelle uneinig'); }
    else if (w.spread >= 7) s -= 2;
  }

  // Thermik, Hangbesonnung, Gelände (leichter Bonus/Abzug)
  const therm = thermalPotential({ sun: w.sun, cape, cloudMargin, rainRisk: rain });
  const sunTerrain = terrainThermalFactor(site, w, w.ms);
  const launch = terrainLaunchFactor(site);
  const thermal = clamp(Math.round(therm + sunTerrain.score), 0, 100);
  s += Math.round((thermal - 50) * 0.22) + launch.score;
  if (thermal >= 72) reasons.push('Thermik und Hangbesonnung günstig');
  else if (thermal < 30 && (w.sun || 0) > 50) reasons.push('schwaches Thermiksignal');
  reasons.push(...launch.detail);

  // Datenqualität
  const missing = [];
  if (!isNum(w.speed)) missing.push('Wind');
  if (!isNum(w.gust)) missing.push('Böen');
  if (!isNum(w.dir)) missing.push('Richtung');
  let dataQuality = 100 - missing.length * 22;
  if (w.windSource === 'Bodenwind') dataQuality -= 8;
  if (missing.length >= 2 && !hard.length) reasons.unshift('Datenlage unvollständig, Entscheidung zurückhaltend');
  if (dataQuality < 45) { hard.push('zu geringe Datenqualität für eine belastbare Freigabe'); cap = Math.min(cap, 54); }

  // Deckel und K.-o.-Kennzeichnung
  for (const hm of hard) {
    let c = 45;
    for (const [re, v] of CAP_RULES) if (re.test(hm)) { c = v; break; }
    cap = Math.min(cap, c);
  }
  const hardTagged = hard.map(h => (h.startsWith('K.-o.') ? h : KO_PREFIX + h));
  const score = clamp(Math.round(Math.min(cap, s)), 0, 100);
  return {
    score, cap: cap < 100 ? cap : null,
    status: hard.length ? 'danger' : score < 55 ? 'danger' : score < 80 ? 'warn' : 'ok',
    hard: hardTagged, reasons: reasons.filter(Boolean), thermal,
    windDiff: wd === null ? null : Math.round(wd), headwind, tailwind, cloudMargin,
    sunDetail: sunTerrain.detail, dataQuality: Math.max(0, dataQuality),
    decision: decisionFor(score)
  };
}

/* ---------------------------------------------------------------- Startfenster */
/**
 * hours: [{score, cap}|null] (null = Nacht/keine Daten); fromIdx = erster zulässiger Index (jetzt).
 * Bester 3-h-Block: Mitte 60 %, Schnitt 40 %, Abzug für Schwankung, gedeckelt auf den niedrigsten Deckel.
 */
export function pickWindow(hours, fromIdx = 0) {
  let best = null;
  const val = i => (hours[i] && isNum(hours[i].score) ? hours[i].score : null);
  for (let k = Math.max(0, fromIdx); k < hours.length; k++) {
    const c = val(k);
    if (c === null) continue;
    const idxs = [k, k + 1, k + 2].filter(i => i < hours.length && val(i) !== null);
    const vals = idxs.map(val);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const stab = vals.length > 1 ? Math.max(...vals) - Math.min(...vals) : 0;
    const capWin = Math.min(...idxs.map(i => (isNum(hours[i].cap) ? hours[i].cap : 100)));
    const cand = Math.min(capWin, Math.round(c * 0.6 + avg * 0.4 - Math.min(10, stab * 0.25)));
    if (!best || cand > best.score) best = { idx: k, score: cand, raw: c, avg, stability: stab };
  }
  if (!best) return null;
  const thr = Math.max(55, best.score - 12);
  let from = best.idx, to = best.idx;
  while (from - 1 >= Math.max(0, fromIdx) && val(from - 1) !== null && val(from - 1) >= thr) from--;
  while (to + 1 < hours.length && val(to + 1) !== null && val(to + 1) >= thr) to++;
  return { ...best, from, to };
}
