// Regionale Lage aus Messwerten (Föhn, Bise, Talwind). Nur Beobachtung: gilt für die nächsten Stunden.
import { windComponent, isNum } from './util.js';

const officialLevel = (idx, code) => {
  const p = idx?.[code];
  if (!p) return null;
  const v = Number(p.value ?? p.foehn_index ?? p.index ?? p.foehn);
  return Number.isFinite(v) ? v : null;
};

/** obs: { CODE: {wind,gust,dir,...} } – Rückgabe mit Stufen und Begründungen. */
export function regionalFromObs(obs = {}, foehnIndex = {}) {
  const g = obs.GRH || {}, th = obs.THU || {}, it = obs.INT || {}, me = obs.MER || {}, ad = obs.ABO || {}, gu = obs.GUE || {}, be = obs.BER || {};
  const ok = (o, ...k) => k.every(x => isNum(o[x]));
  let foehn = 0, bise = 0, tal = 0;
  const reasons = [];
  const official = ['ABO', 'INT', 'MER'].map(c => officialLevel(foehnIndex, c)).filter(isNum);
  const offMax = official.length ? Math.max(...official) : 0;
  if (offMax >= 2) { foehn += 45; reasons.push('Föhnindex der MeteoSchweiz aktiv'); }
  else if (offMax >= 1) { foehn += 24; reasons.push('Föhnindex der MeteoSchweiz mit Tendenz'); }
  if (official.filter(x => x >= 1).length >= 2) foehn += 16;
  if (ok(gu, 'dir', 'wind')) {
    const s = windComponent(gu.dir, 180);
    if (s > 0.75 && gu.wind >= 28) { foehn += 28; reasons.push('Gütsch: Südströmung am Alpenkamm'); }
    else if (s > 0.55 && gu.wind >= 20) foehn += 16;
  }
  if (ok(g, 'dir')) {
    const s = Math.max(windComponent(g.dir, 160), windComponent(g.dir, 140), windComponent(g.dir, 180));
    if (s > 0.75 && (g.wind || 0) >= 20) { foehn += 28; reasons.push('Grimsel: Südsektor mit Wind'); }
    else if (s > 0.55 && (g.wind || 0) >= 12) foehn += 14;
  }
  if ((g.gust || 0) >= 30 || (me.gust || 0) >= 30) foehn += 10;
  if (ok(me, 'dir', 'wind') && windComponent(me.dir, 180) > 0.45 && me.wind >= 15) { foehn += 18; reasons.push('Meiringen: Südwind erreicht das Haslital'); }
  if (ok(ad, 'dir', 'wind') && windComponent(ad.dir, 180) > 0.45 && ad.wind >= 12) foehn += 8;
  if (ok(th, 'dir', 'wind') && windComponent(th.dir, 180) > 0.35 && th.wind >= 12) foehn += 5;
  if (ok(it, 'dir', 'wind') && windComponent(it.dir, 180) > 0.35 && it.wind >= 10) foehn += 5;
  const ne = d => Math.max(windComponent(d, 45), windComponent(d, 30));
  if (ok(th, 'dir', 'wind') && ne(th.dir) > 0.7 && th.wind >= 12) bise += 28;
  if (ok(be, 'dir', 'wind') && ne(be.dir) > 0.7 && be.wind >= 10) bise += 22;
  if (bise >= 40) reasons.push('Bise im Vorland');
  if (ok(th, 'dir', 'wind') && ok(it, 'wind')) {
    const toAlps = Math.max(windComponent(th.dir, 285), windComponent(th.dir, 270));
    if (toAlps > 0.6 && it.wind > th.wind + 3 && it.wind >= 8) { tal = 60; reasons.push('Talwind Richtung Interlaken verstärkt'); }
    else if (toAlps > 0.45 && it.wind >= 10) tal = 35;
  }
  foehn = Math.min(100, foehn); bise = Math.min(100, bise);
  return {
    foehnScore: foehn, biseScore: bise, talwindScore: tal,
    foehn: foehn >= 70 ? 'danger' : foehn >= 40 ? 'warn' : 'ok',
    reasons, official: offMax
  };
}

/** Gewicht der Messwerte für eine Stunde in der Zukunft: 1 jetzt, 0 nach 6 h. */
export const localWeight = hoursAhead => Math.max(0, 1 - Math.max(0, hoursAhead) / 6);

/** Angepasste Sicht für eine Stunde; null, wenn kaum noch relevant. */
export function localForHour(state, hoursAhead) {
  if (!state) return null;
  const w = localWeight(hoursAhead);
  if (w < 0.2) return null;
  const down = lv => (w < 0.5 && lv === 'danger' ? 'warn' : w < 0.35 ? 'ok' : lv);
  return { ...state, foehn: down(state.foehn), biseScore: state.biseScore * w, talwindScore: state.talwindScore * w, weight: w };
}
