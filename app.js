/* AFC 8.0 – App. Der Server rechnet, die App zeigt an und merkt sich Favoriten, Erfahrungsstufe und Flugbuch. */
'use strict';

/* ---------------------------------------------------------------- Helfer */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => typeof v === 'number' && Number.isFinite(v);
const store = {
  get(k, d) { try { const v = localStorage.getItem('afc.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('afc.' + k, JSON.stringify(v)); } catch { /* privat/voll */ } },
  del(k) { try { localStorage.removeItem('afc.' + k); } catch { /* egal */ } }
};
const DIR16 = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const dirLabel = d => (num(d) ? DIR16[Math.round(((d % 360) + 360) % 360 / 22.5) % 16] : '–');
const cls = s => (!num(s) ? 'none' : s >= 85 ? 'go' : s >= 80 ? 'ready' : s >= 70 ? 'check' : s >= 55 ? 'wait' : 'no');
const DECISION = { go: 'Starten', ready: 'Startbereit', check: 'Prüfen', wait: 'Abwarten', no: 'Nicht starten', none: '–' };
const arrow = dir => (num(dir) ? `<svg class="arr" viewBox="0 0 24 24" style="transform:rotate(${Math.round(dir + 180)}deg)" aria-hidden="true"><path d="M12 3v17M5 13l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>` : '');
const todayKey = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' });
const timeOf = iso => { try { return new Date(iso).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }); } catch { return '–'; } };

const clientId = (() => {
  let v = store.get('cid');
  if (!v || !/^[\w-]{8,64}$/.test(v)) {
    v = (self.crypto?.randomUUID?.() || (Math.random().toString(36).slice(2) + Date.now().toString(36) + '00000000')).slice(0, 40);
    store.set('cid', v);
  }
  return v;
})();

/* ---------------------------------------------------------------- Zustand */
const S = {
  plan: null, day: 0, tab: 'decide', warming: false, offline: false, err: null, loadedAt: 0,
  level: ['careful', 'normal', 'expert'].includes(store.get('level')) ? store.get('level') : 'normal',
  theme: ['auto', 'light', 'dark'].includes(store.get('theme')) ? store.get('theme') : 'auto',
  fav: new Set(store.get('fav', [])), open: new Set(store.get('open', [])),
  detail: new Map(), site: null, hour: null, mapReady: false
};
const LEVEL_INFO = {
  careful: ['Vorsichtig', 'Strengere Wind- und Böengrenzen, empfindlicher bei Scherung. Für Einsteiger und unbekannte Plätze.'],
  normal: ['Normal', 'Ausgewogene Grenzwerte für geübte Piloten.'],
  expert: ['Erfahren', 'Höhere Wind- und Böengrenzen. Kaltfront, Föhn und Gewitter bleiben K.-o.-Kriterien.']
};

function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  const dark = S.theme === 'dark' || (S.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('#metaTheme').content = dark ? '#08100b' : '#0f1a14';
}

/* ---------------------------------------------------------------- Laden */
let loadTimer = null;
async function loadPlan(manual) {
  clearTimeout(loadTimer);
  $('.icon-btn[data-act="reload"]')?.classList.add('spin');
  try {
    const r = await fetch(`/api/plan?level=${S.level}`, { cache: 'no-cache' });
    if (r.status === 202) {
      S.warming = true;
      loadTimer = setTimeout(() => loadPlan(), 4000);
    } else if (!r.ok) {
      throw new Error(r.status === 429 ? 'Zu viele Anfragen, bitte kurz warten' : `Server antwortet mit ${r.status}`);
    } else {
      const p = await r.json();
      if (!p.ok) throw new Error('Keine Prognosedaten');
      S.plan = p; S.warming = false; S.offline = false; S.err = null; S.loadedAt = Date.now();
      store.set('plan', { level: S.level, at: Date.now(), plan: p });
      if (manual) toast('Aktualisiert');
    }
  } catch (e) {
    S.offline = true; S.err = e.message || 'Netzwerkfehler';
    if (!S.plan) {
      const c = store.get('plan');
      if (c?.plan && c.level === S.level) { S.plan = c.plan; S.cachedAt = c.at; }
    }
  } finally {
    $('.icon-btn[data-act="reload"]')?.classList.remove('spin');
    if (S.plan) S.day = Math.min(S.day, S.plan.dates.length - 1);
    render();
  }
}
async function loadDetail(id) {
  const key = `${S.level}:${id}`;
  const c = S.detail.get(key);
  if (c && Date.now() - c.at < 3 * 60000) return c.data;
  const r = await fetch(`/api/site/${encodeURIComponent(id)}?level=${S.level}`, { cache: 'no-cache' });
  if (r.status === 202) throw new Error('Daten werden noch geladen, bitte gleich nochmals versuchen');
  if (!r.ok) throw new Error(`Server antwortet mit ${r.status}`);
  const data = await r.json();
  S.detail.set(key, { at: Date.now(), data });
  return data;
}

/* ---------------------------------------------------------------- Bausteine */
const siteById = id => S.plan.sites.find(s => s.id === id);
const areaById = id => S.plan.areas.find(a => a.id === id);
function dayName(i) {
  if (i === 0) return 'Heute'; if (i === 1) return 'Morgen';
  return new Date(S.plan.dates[i] + 'T12:00:00').toLocaleDateString('de-CH', { weekday: 'short' }).replace('.', '');
}
const dayDate = i => S.plan.dates[i].slice(8) + '.' + S.plan.dates[i].slice(5, 7) + '.';
const winText = b => (b ? `${b.from}–${b.to} Uhr` : 'kein Fenster');

function ribbon(scores, best, o = {}) {
  const h0 = S.plan.h0;
  let h = '';
  for (let i = 0; i < 16; i++) {
    const s = scores[i], hour = h0 + i;
    const c = ['rc'];
    if (num(s)) c.push('s-' + cls(s));
    if (!o.big && best && num(s) && !(hour >= best.from && hour < best.to)) c.push('dim');
    if (o.now === hour) c.push('now');
    if (o.sel === hour) c.push('sel');
    h += o.btn
      ? `<button type="button" class="${c.join(' ')}" data-act="hour" data-h="${hour}" aria-label="${hour} Uhr, ${num(s) ? 'Score ' + s : 'keine Bewertung'}">${num(s) ? s : ''}</button>`
      : `<i class="${c.join(' ')}">${o.big && num(s) ? s : ''}</i>`;
  }
  const label = `Stundenscore 6 bis 21 Uhr${best ? ', bestes Fenster ' + winText(best) : ''}`;
  let out = `<div class="ribbon${o.big ? ' big' : ''}" ${o.btn ? 'role="group"' : 'role="img"'} aria-label="${label}">${h}</div>`;
  if (o.axis) out += `<div class="ribbon-ax" aria-hidden="true">${Array.from({ length: 16 }, (_, i) => `<span>${h0 + i}</span>`).join('')}</div>`;
  return out;
}
const nowHourToday = () => (S.day === 0 ? Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Zurich' })) : null);

function pill(score, small = true) {
  const c = cls(score);
  return `<div class="pill s-${c}">${num(score) ? score : '–'}${small ? `<small>${DECISION[c]}</small>` : ''}</div>`;
}
function starBtn(id) {
  const on = S.fav.has(id);
  return `<button type="button" class="star" data-act="fav" data-id="${esc(id)}" aria-pressed="${on}" aria-label="${on ? 'Favorit entfernen' : 'Als Favorit merken'}"><svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" stroke-linejoin="round"/></svg></button>`;
}
const aspectText = s => (s.aspects?.length ? s.aspects.map(dirLabel).join('/') : '');

/* ---------------------------------------------------------------- Rendern */
function render() {
  applyTheme();
  renderStamp();
  renderBanner();
  $('#daybar').hidden = !S.plan || !['decide', 'map', 'lage'].includes(S.tab);
  if (S.plan) renderDaybar();
  for (const t of ['decide', 'map', 'lage', 'day', 'book', 'profile']) $('#v-' + t).hidden = S.tab !== t;
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
  if (S.tab === 'decide') renderDecide();
  else if (S.tab === 'lage') renderLage();
  else if (S.tab === 'day') renderDay();
  else if (S.tab === 'profile') renderProfile();
  else if (S.tab === 'book') renderBook();
  else if (S.tab === 'map') renderMap();
}

function sourceState() {
  const p = S.plan; if (!p) return ['bad', 'Keine Daten'];
  const s = p.sources || {};
  const age = p.fetchedAt ? (Date.now() - Date.parse(p.fetchedAt)) / 60000 : 999;
  if (S.offline && S.plan) return ['bad', 'Offline'];
  if (!s.forecast?.ok || age > 180) return ['bad', 'Störung'];
  if (!s.observations?.ok || !s.pressure?.ok || s.forecast.error || age > 90) return ['warn', 'Teilweise'];
  return ['ok', 'Daten ok'];
}
function renderStamp() {
  const p = S.plan, st = sourceState();
  $('#srcDotI').className = 'dot ' + st[0];
  $('#srcDotT').textContent = st[1];
  $('#stamp').textContent = p ? `Prognose ${timeOf(p.fetchedAt)} · ${S.level === 'careful' ? 'Vorsichtig' : S.level === 'expert' ? 'Erfahren' : 'Normal'}` : 'Lade Daten …';
}
function renderBanner() {
  const b = $('#banner');
  let msg = '', bad = false;
  if (S.offline && S.plan) {
    const at = S.plan.fetchedAt || (S.cachedAt && new Date(S.cachedAt).toISOString());
    msg = `Keine Verbindung (${S.err}). Letzter Stand von ${at ? timeOf(at) + ' Uhr' : 'früher'} – nicht für den Startentscheid verwenden.`; bad = true;
  } else if (S.offline) { msg = `Daten nicht erreichbar: ${S.err}`; bad = true; }
  else if (S.plan) {
    const s = S.plan.sources || {};
    const issues = [];
    if (!s.observations?.ok) issues.push('Messwerte');
    if (!s.pressure?.ok) issues.push('Höhenwind');
    if (!s.ecmwf?.ok) issues.push('Modellvergleich');
    if (!s.foehn?.ok) issues.push('Föhnindex');
    if (s.forecast?.error) issues.push('Teile der Prognose');
    if (issues.length) msg = `Eingeschränkt: ${issues.join(', ')} derzeit nicht verfügbar. Die Bewertung ist vorsichtiger zu lesen.`;
  }
  b.hidden = !msg; b.textContent = msg; b.classList.toggle('bad', bad);
}

function renderDaybar() {
  const p = S.plan;
  $('#daybar').innerHTML = p.dates.map((_, i) => {
    const top = p.days[i].top, site = top && siteById(top.siteId);
    const sc = top?.best.score;
    return `<button type="button" class="day" data-act="day" data-i="${i}" aria-pressed="${i === S.day}">
      <span class="day-h"><span class="day-n">${dayName(i)}</span><span class="day-d">${dayDate(i)}</span></span>
      <span class="day-s t-${cls(sc)}">${num(sc) ? sc : '–'}</span>
      ${site ? ribbon(site.days[i].scores, top.best) : '<div class="ribbon"></div>'}
    </button>`;
  }).join('');
}

function stateBox() {
  if (S.plan) return '';
  if (S.warming || !S.offline) return `<div class="warm"><div class="spinner"></div>Wetterdaten werden geladen. Beim ersten Start dauert das bis zu einer Minute.</div>`;
  return `<div class="empty">Keine Daten verfügbar (${esc(S.err)}). <button class="btn sec" data-act="reload" type="button">Erneut versuchen</button></div>`;
}

/* ---- Entscheid */
function headlineFor(d) {
  const p = S.plan, h = p.headline;
  if (d === h.day) return { tone: h.tone, title: h.title, text: h.text };
  const t = p.days[d].top;
  if (!t) return { tone: 'danger', title: `${dayName(d)}: keine Bewertung`, text: 'Für diesen Tag liegen noch keine Daten vor.' };
  const site = siteById(t.siteId), area = areaById(t.areaId), sc = t.best.score;
  const tone = sc >= 80 ? 'ok' : sc >= 55 ? 'warn' : 'danger';
  const title = sc >= 80 ? `${dayName(d)} sieht gut aus` : sc >= 55 ? `${dayName(d)} nur mit Vorsicht` : `${dayName(d)} besser am Boden bleiben`;
  let text = sc >= 55 ? `Bester Start: ${site.name} (${area.name}), ${winText(t.best)}, Score ${sc}.` : `Der beste Startplatz (${site.name}) erreicht nur ${sc} von 100.`;
  const dd = p.days[d];
  if (dd.regionStatus && dd.regionStatus !== 'ok') text += ` Regional: ${({ front: 'Kaltfront', storm: 'Gewitterrisiko', foehn: 'Föhn', valley: 'Talwind', upper: 'starker Höhenwind' })[dd.regionWorst] || 'Lage'} ${dd.regionStatus === 'danger' ? '(K.-o.)' : '(Vorsicht)'}.`;
  if (d > 2) text += ' Je weiter in der Zukunft, desto unsicherer.';
  return { tone, title, text };
}

function areaCard(a) {
  const d = a.days[S.day];
  const sites = a.sites.map(siteById).filter(Boolean);
  const open = S.open.has(a.id);
  const hasFav = sites.some(s => S.fav.has(s.id));
  const best = d && siteById(d.siteId);
  const nowH = nowHourToday();
  const head = d
    ? `<div class="card-top"><div><div class="card-name">${esc(a.name)}${hasFav ? ' ★' : ''}</div><div class="card-sub">${esc(best.name)} · ${best.alt} m · ${esc(aspectText(best))} · ${winText(d.best)}</div></div>${pill(d.best.score)}</div>${ribbon(best.days[S.day].scores, d.best, { now: nowH })}`
    : `<div class="card-top"><div><div class="card-name">${esc(a.name)}</div><div class="card-sub">${S.day === 0 ? 'Heute kein Flugfenster mehr' : 'Kein auswertbares Fenster'}</div></div>${pill(null, false)}</div>`;
  const rows = [...sites].sort((x, y) => (y.days[S.day].best?.score ?? -1) - (x.days[S.day].best?.score ?? -1)).map(s => {
    const b = s.days[S.day].best;
    return `<div class="srow"><button type="button" class="srow-main" data-act="site" data-id="${esc(s.id)}" aria-label="${esc(s.name)} öffnen"><span class="srow-name">${esc(s.name)}</span><span class="srow-sub">${s.alt} m · ${esc(aspectText(s))} · ${b ? winText(b) : 'kein Fenster'}${s.blocked ? ' · gesperrt' : ''}</span>${ribbon(s.days[S.day].scores, b, { now: nowH })}</button><div style="display:grid;justify-items:center">${starBtn(s.id)}<div class="mini-pill s-${s.blocked ? 'none' : cls(b?.score)}">${s.blocked ? '✕' : b ? b.score : '–'}</div></div></div>`;
  }).join('');
  return `<article class="card">
    <button type="button" class="card-main" data-act="${d ? 'site' : 'toggle'}" data-id="${d ? esc(d.siteId) : esc(a.id)}" aria-label="${esc(a.name)}: ${d ? 'bester Start ' + esc(best.name) + ' öffnen' : 'aufklappen'}">${head}</button>
    <div class="card-foot"><span class="card-sub">${sites.length} ${sites.length === 1 ? 'Startplatz' : 'Startplätze'}</span>
      <button type="button" class="exp-btn" data-act="toggle" data-id="${esc(a.id)}" aria-expanded="${open}">${open ? 'Weniger' : 'Alle Startplätze'}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
    ${open ? `<div class="rows">${rows}</div>` : ''}
  </article>`;
}

/** Erfahrungsstufe kurz anzeigen; ändern im Profil (dort wird sie aus Flügen, Stunden und Pause berechnet). */
function levelLine() {
  const pl = window.AFCPilot?.pilotLevel(store.get('pilot', {}));
  const src = !pl ? 'Profil noch nicht ausgefüllt' : pl.level === S.level ? 'aus deinem Profil' : 'von Hand gewählt';
  return `<div class="level"><span class="lbl">Erfahrung</span><b>${LEVEL_INFO[S.level][0]}</b><span class="lbl">${src}</span><button type="button" class="linkbtn" data-act="tab" data-tab="profile">${pl ? 'ändern' : 'Profil ausfüllen'}</button></div>`;
}
function renderDecide() {
  const el = $('#v-decide');
  if (!S.plan) { el.innerHTML = stateBox(); return; }
  const p = S.plan, h = headlineFor(S.day);
  const favSites = [...S.fav].map(siteById).filter(Boolean);
  const areas = [...p.areas].sort((a, b) => (b.days[S.day]?.best.score ?? -1) - (a.days[S.day]?.best.score ?? -1));
  const nowH = nowHourToday();
  el.innerHTML = `
    ${gearAlertHtml(gearAlerts().filter(x => x.level === 'due'))}
    <div class="headline ${h.tone}"><h2>${esc(h.title)}</h2><p>${esc(h.text)}</p></div>
    ${levelLine()}
    ${favSites.length ? `<h2 class="sec-h">Meine Startplätze</h2><div class="cards"><article class="card"><div class="rows" style="border-top:0">${favSites.map(s => {
      const b = s.days[S.day].best;
      return `<div class="srow"><button type="button" class="srow-main" data-act="site" data-id="${esc(s.id)}"><span class="srow-name">${esc(s.name)}</span><span class="srow-sub">${s.alt} m · ${b ? winText(b) : 'kein Fenster'}</span>${ribbon(s.days[S.day].scores, b, { now: nowH })}</button><div style="display:grid;justify-items:center">${starBtn(s.id)}<div class="mini-pill s-${cls(b?.score)}">${b ? b.score : '–'}</div></div></div>`;
    }).join('')}</div></article></div>` : ''}
    <h2 class="sec-h">Gebiete ${S.day === 0 ? 'heute' : 'am ' + dayName(S.day)}</h2>
    <div class="cards">${areas.map(areaCard).join('')}</div>
    <p class="fine">Der Score ist eine Entscheidungshilfe, keine Freigabe. K.-o.-Kriterien (Kaltfront, Gewitter, Föhn, zu starker Wind, Regen, Wolke am Start, Rückenwind) deckeln den Score. Die Entscheidung trifft immer die Pilotin oder der Pilot vor Ort.</p>`;
}

/* ---- Lage */
function regionSummary(d) {
  const hours = S.plan.region.days[d]?.hours || [];
  const day = hours.filter(h => h.h >= 8 && h.h <= 18);
  const parts = [];
  for (const [k, name] of [['front', 'Kaltfront'], ['storm', 'Gewitterrisiko'], ['foehn', 'Föhn']]) {
    const hit = day.find(h => h[k] === 'danger') || day.find(h => h[k] === 'warn');
    if (hit) parts.push(`${name} ab ${hit.h} Uhr (${hit[k] === 'danger' ? 'K.-o.' : 'Vorsicht'})`);
  }
  const up = day.filter(h => h.up800 && h.up800[0] >= 40);
  if (up.length) parts.push(`Höhenwind bis ${Math.max(...up.map(h => h.up800[0]))} km/h auf 2000 m`);
  if (!parts.length) return 'Keine K.-o.-Faktoren in der Region. Kaltfront, Gewitter und Föhn sind unauffällig.';
  return parts.join('. ') + '.';
}
const LVL_SYM = { ok: '✓', warn: '!', danger: '✕' };
const LVL_TXT = { ok: 'unauffällig', warn: 'Vorsicht', danger: 'K.-o.' };
function renderLage() {
  const el = $('#v-lage');
  if (!S.plan) { el.innerHTML = stateBox(); return; }
  const p = S.plan, day = p.region.days[S.day];
  const step = matchMedia('(min-width: 900px)').matches ? 1 : 2;
  const hrs = (day?.hours || []).filter(h => h.h >= 7 && h.h <= 20 && (h.h - 7) % step === 0);
  const nowH = nowHourToday();
  const lc = (lvl, tip) => `<div class="bc ${lvl}" title="${esc(tip || LVL_TXT[lvl])}" aria-label="${LVL_TXT[lvl]}${tip ? ': ' + esc(tip) : ''}">${LVL_SYM[lvl]}</div>`;
  const wc = (w, lim) => (w ? `<div class="bc ${w[0] >= lim ? 'warn' : 'ok'}" aria-label="${w[0]} km/h aus ${dirLabel(w[1])}">${w[0]}<span style="margin-left:2px">${arrow(w[1])}</span></div>` : '<div class="bc mut">–</div>');
  const rows = [
    ['Kaltfront', h => lc(h.front, h.frontWhy?.[0])],
    ['Gewitter', h => lc(h.storm, `CAPE ${h.cape} J/kg, Regen ${h.pop} %`)],
    ['Föhn', h => lc(h.foehn)],
    ['Wind 2000 m', h => wc(h.up800, 40)],
    ['Wind 3000 m', h => wc(h.up700, 60)],
    ['Basis in km', h => (num(h.cb) ? `<div class="bc mut" aria-label="Basis ${h.cb} m">${(h.cb / 1000).toFixed(1)}</div>` : '<div class="bc mut">–</div>')],
    ['Thermik bis km', h => (num(h.top) ? `<div class="bc mut" aria-label="Thermik bis ${h.top} m${h.inv ? ', Inversion ab ' + h.inv + ' m' : ''}">${(h.top / 1000).toFixed(1)}</div>` : '<div class="bc mut">–</div>')],
    ['Thermik', h => `<div class="bc mut" aria-label="Thermikindex ${h.therm}">${h.therm >= 60 ? '●●●' : h.therm >= 30 ? '●●○' : h.therm > 8 ? '●○○' : '○○○'}</div>`],
    ['Urteil', h => `<div class="bc v s-${cls(h.v)}" aria-label="Regionsurteil ${h.v}">${h.v}</div>`]
  ];
  const whyAll = [];
  for (const h of day?.hours || []) for (const w of h.frontWhy || []) if (!whyAll.includes(w)) whyAll.push(w);
  const nowS = p.region.now;
  el.innerHTML = `
    <div class="headline ${p.days[S.day].regionStatus === 'danger' ? 'danger' : p.days[S.day].regionStatus === 'warn' ? 'warn' : 'ok'}">
      <h2>Lage ${S.day === 0 ? 'heute' : 'am ' + dayName(S.day)}</h2>
      <p>${esc(regionSummary(S.day))}</p>
    </div>
    <div class="gridwrap" tabindex="0" role="region" aria-label="Briefing-Raster, seitlich scrollbar"><table class="brief">
      <thead><tr><th class="rl" scope="col">Uhr</th>${hrs.map(h => `<th scope="col">${h.h === nowH ? 'jetzt' : h.h}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(([name, f]) => `<tr><th class="rl" scope="row">${name}</th>${hrs.map(h => `<td>${f(h)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
    <div class="legend"><span><i style="background:var(--wait)"></i>Vorsicht</span><span><i style="background:var(--no)"></i>K.-o. (Kaltfront, Gewitter, Föhn)</span><span>Höhenwind färbt nur leicht: er verschlechtert, verbietet aber nichts.</span></div>
    ${whyAll.length ? `<div class="panel" style="margin-top:12px"><h3>Warum die Frontwarnung?</h3><ul class="why">${whyAll.map(w => `<li>${esc(w)}</li>`).join('')}</ul><p class="fine">Eine Warnung braucht mindestens zwei Signale (Druck, Windsprung, Temperatursturz, Schauer).</p></div>` : ''}
    ${S.day === 0 && nowS ? `<div class="panel" style="margin-top:12px"><h3>Jetzt gemessen</h3><div class="kv">
      <div><b>${nowS.foehnScore}</b><span>Föhn-Signal${nowS.foehn !== 'ok' ? ' (' + LVL_TXT[nowS.foehn] + ')' : ''}</span></div>
      <div><b>${nowS.bise}</b><span>Bise im Vorland</span></div>
      <div><b>${nowS.talwind}</b><span>Talwind Richtung Alpen</span></div></div>
      ${nowS.reasons?.length ? `<ul class="why">${nowS.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      <p class="fine">Messwerte zählen nur für die nächsten Stunden. Für spätere Stunden und andere Tage gilt allein die Modellprognose.</p></div>` : ''}`;
}

/* ---- Flugtag */
const CHECKS = [
  'Luftraum und Einschränkungen geprüft (Skybriefing, Karte)',
  'Hindernisse und Seilbahnen auf der Karte kontrolliert',
  'Landeplatz und Ausweichlandeplatz festgelegt',
  'Wind am Start vor Ort bestätigt (Windsack, Wolken, Bäume)',
  'Ausrüstung, Rettung und Funk kontrolliert',
  'Jemand weiss, wo ich fliege und wann ich zurück bin'
];
function renderDay() {
  const el = $('#v-day');
  const key = 'check.' + todayKey();
  const done = store.get(key, []);
  const st = (S.plan?.stations || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'de'));
  const q = S.plan?.quality?.stations || [];
  el.innerHTML = `
    <div class="panel"><h3>Vor dem Start</h3>
      ${CHECKS.map((c, i) => `<label class="chk"><input type="checkbox" data-act="check" data-i="${i}" ${done.includes(i) ? 'checked' : ''}><span>${esc(c)}</span></label>`).join('')}
      <p class="fine">Die Liste gilt für heute und wird morgen zurückgesetzt. <a href="https://www.skybriefing.com/" target="_blank" rel="noopener">Skybriefing</a> · <a href="https://map.geo.admin.ch/" target="_blank" rel="noopener">Karte des Bundes</a></p>
    </div>
    <div class="panel"><h3>Messwerte jetzt</h3>
      ${st.length ? `<div class="tw"><table class="plain"><thead><tr><th>Station</th><th>Wind</th><th>Böen</th><th>Richtung</th><th>Temp.</th><th>Alter</th></tr></thead><tbody>${st.map(s => `<tr><td>${esc(s.name)} <span class="srow-sub">${s.alt ?? ''} m</span></td><td>${num(s.wind) ? Math.round(s.wind) : '–'}</td><td>${num(s.gust) ? Math.round(s.gust) : '–'}</td><td>${num(s.dir) ? arrow(s.dir) + ' ' + dirLabel(s.dir) : '–'}</td><td>${num(s.temp) ? s.temp.toFixed(1) + '°' : '–'}</td><td>${s.age} min</td></tr>`).join('')}</tbody></table></div><p class="fine">Wind in km/h, 10-Minuten-Mittel der MeteoSchweiz (SwissMetNet).</p>` : '<div class="empty">Keine aktuellen Messwerte. Wetterstationen liefern derzeit keine Daten.</div>'}
    </div>
    <div class="panel"><h3>Wie gut war die Prognose?</h3>
      ${q.length ? `<div class="tw"><table class="plain"><thead><tr><th>Station</th><th>Wind Ø-Fehler</th><th>Böen</th><th>Richtung</th><th>Messungen</th></tr></thead><tbody>${q.map(r => `<tr><td>${esc(r.name)}</td><td>${num(r.windMae) ? r.windMae.toFixed(1) + ' km/h' : '–'}${num(r.windBias) && Math.abs(r.windBias) >= 2 ? ` <span class="srow-sub">(${r.windBias > 0 ? 'zu schwach' : 'zu stark'} prognostiziert)</span>` : ''}</td><td>${num(r.gustMae) ? r.gustMae.toFixed(1) : '–'}</td><td>${num(r.dirMae) ? Math.round(r.dirMae) + '°' : '–'}</td><td>${r.n}</td></tr>`).join('')}</tbody></table></div><p class="fine">Prognose 3 Stunden im Voraus gegen die spätere Messung, letzte 7 Tage. Je kleiner der Fehler, desto verlässlicher die Prognose an dieser Station.</p>` : '<div class="empty">Die Auswertung braucht etwa einen Tag Laufzeit, bis genug Vergleiche vorliegen.</div>'}
    </div>`;
}

/* ---- Profil */
function sourcesHtml() {
  const s = S.plan?.sources;
  if (!s) return '<div class="empty">Keine Angaben.</div>';
  const items = [
    ['Prognose (MeteoSchweiz ICON über Open-Meteo)', s.forecast, s.forecast?.model],
    ['Höhenwind auf Druckflächen (DWD ICON)', s.pressure],
    ['Zweites Modell (ECMWF) für den Modellvergleich', s.ecmwf],
    ['Messwerte (SwissMetNet)', s.observations, s.observations?.source],
    ['Föhnindex (MeteoSchweiz)', s.foehn],
    ['Stationsliste', s.stations, s.stations?.note]
  ];
  return `<div class="srcs">${items.map(([n, x, d]) => `<div><span class="dot ${x?.ok ? (x.error ? 'warn' : 'ok') : 'bad'}"></span><span>${esc(n)}<small>${x?.at ? 'Stand ' + timeOf(x.at) + ' Uhr' : 'noch nie geladen'}${d ? ' · ' + esc(d) : ''}${x?.error ? ' · ' + esc(x.error) : ''}</small></span></div>`).join('')}</div>`;
}
/* ---- Status: Open-Meteo-Verbrauch und Update-Hinweis (/api/status) */
const ST = { data: null, busy: false };
async function loadStatus() {
  try { const r = await fetch('/api/status', { cache: 'no-store' }); if (r.ok) ST.data = await r.json(); } catch {}
  renderUpdBanner();
  if (S.tab === 'profile') { const el = $('#statusPanel'); if (el) el.innerHTML = statusHtml(); }
}
function updText(u) {
  const when = u.latest?.date ? new Date(u.latest.date).toLocaleDateString('de-CH') : '';
  return `${u.behind === 1 ? 'Eine Änderung' : u.behind + ' Änderungen'}${when ? ' vom ' + when : ''}${u.latest?.msg ? ': ' + u.latest.msg : ''}`;
}
function renderUpdBanner() {
  const u = ST.data?.update, b = $('#updBanner');
  if (!u?.available || store.get('updSkip') === u.latest?.date) { b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = `<span><b>Neue AFC-Version verfügbar.</b> ${esc(updText(u))}</span><span class="btn-row">${u.canApply
    ? `<button class="btn" type="button" data-act="update" ${ST.busy ? 'disabled' : ''}>${ST.busy ? 'Wird aktualisiert …' : 'Jetzt aktualisieren'}</button>`
    : '<span class="fine">Auf dem Mac «AFC aktualisieren» doppelklicken.</span>'}<button class="btn sec" type="button" data-act="updskip">Später</button></span>`;
}
async function applyUpdate() {
  ST.busy = true; renderUpdBanner();
  try {
    const r = await fetch('/api/update', { method: 'POST', headers: { 'X-AFC-Client': clientId } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Fehler ' + r.status);
    toast('Update geladen, AFC startet neu …');
    // warten, bis der Dienst mit der neuen Version wieder antwortet
    await new Promise(res => setTimeout(res, 2500));
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch('/healthz', { cache: 'no-store' })).ok) { location.reload(); return; } } catch {}
      await new Promise(res => setTimeout(res, 1000));
    }
    throw new Error('AFC antwortet nicht. Auf dem Mac «AFC neu starten» doppelklicken.');
  } catch (err) { ST.busy = false; renderUpdBanner(); toast('Update fehlgeschlagen: ' + err.message); }
}
function statusHtml() {
  const d = ST.data;
  if (!d) return '<p class="fine" style="margin:0">Wird geladen …</p>';
  const o = d.openMeteo, pct = Math.min(100, Math.round(o.calls / o.limitDay * 100)), u = d.update;
  const upd = !u?.enabled ? 'Keine Git-Kopie: Update-Prüfung aus.'
    : u.error ? `Letzte Prüfung fehlgeschlagen (${esc(u.error)}).`
    : u.available ? `Neue Version verfügbar. ${esc(updText(u))}`
    : u.checkedAt ? `Aktuell (geprüft ${timeOf(u.checkedAt)} Uhr).` : 'Noch nicht geprüft.';
  return `<div><b>Open-Meteo heute: ${o.calls.toLocaleString('de-CH')} von ${o.limitDay.toLocaleString('de-CH')} Gratis-Aufrufen</b> <span class="fine">(${pct} %, letzte Stunde ${o.lastHour.toLocaleString('de-CH')})</span>
      <div class="usage-bar" aria-hidden="true"><span style="width:${pct}%;${pct >= 80 ? 'background:var(--no)' : ''}"></span></div>
      <p class="fine" style="margin:6px 0 0">Open-Meteo zählt je Ort und je 10 Wettergrössen einen Aufruf. Der Zähler beginnt um ${new Date(Date.parse(o.day + 'T00:00:00Z')).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })} Uhr neu.${pct >= 80 ? ' <b>Achtung: nahe am Tageslimit.</b>' : ''}</p></div>
    <div style="margin-top:12px"><b>AFC ${esc(d.version)}</b> <span class="fine">${upd}</span>
      <div class="btn-row" style="justify-content:flex-start;margin-top:6px">${u?.available && u.canApply ? `<button class="btn" type="button" data-act="update" ${ST.busy ? 'disabled' : ''}>Jetzt aktualisieren</button>` : ''}${u?.enabled ? '<button class="btn sec" type="button" data-act="updcheck">Nach Updates suchen</button>' : ''}</div></div>`;
}
function renderProfile() {
  const el = $('#v-profile');
  const log = store.get('log', []);
  const favs = [...S.fav].map(id => S.plan && siteById(id)).filter(Boolean);
  el.innerHTML = `
    ${pilotPanel()}
    <div class="panel"><h3>Darstellung</h3>
      <div class="seg" role="group" aria-label="Darstellung">${[['auto', 'Automatisch'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([k, n]) => `<button type="button" data-act="theme" data-v="${k}" aria-pressed="${S.theme === k}">${n}</button>`).join('')}</div></div>
    <div class="panel"><h3>Favoriten</h3>
      ${favs.length ? favs.map(s => `<div class="srow" style="padding-left:0;padding-right:0"><button type="button" class="srow-main" data-act="site" data-id="${esc(s.id)}"><span class="srow-name">${esc(s.name)}</span><span class="srow-sub">${s.alt} m · ${esc(aspectText(s))}</span></button>${starBtn(s.id)}</div>`).join('') : '<p class="fine" style="margin:0">Noch keine Favoriten. Tippe in der Startplatz-Ansicht auf den Stern.</p>'}</div>
    <div class="panel"><h3>Gemeldete Flüge und AFC-Score</h3>
      ${flightCheck(log)}
      ${log.length ? `<div class="tw"><table class="plain"><thead><tr><th>Datum</th><th>Startplatz</th><th>Flug</th><th>Score</th><th></th></tr></thead><tbody>${log.slice().reverse().map((r, i) => `<tr><td>${new Date(r.launchTime).toLocaleDateString('de-CH')}</td><td>${esc(r.name)}</td><td>${r.launched ? '★'.repeat(r.quality) : 'nicht geflogen'}</td><td>${num(r.afcScore) ? r.afcScore : '–'}${flightMatch(r) && flightMatch(r) !== 'passt' ? ` <span class="fine" title="${flightMatch(r)}">(${flightMatch(r)})</span>` : ''}</td><td><button type="button" class="star" data-act="logdel" data-i="${log.length - 1 - i}" aria-label="Eintrag entfernen">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="fine" style="margin:0">Noch keine Einträge. Nach einem Flug über die Startplatz-Ansicht melden.</p>'}
      <p class="fine">Gemeldete Flüge werden anonym gespeichert (ohne Namen, mit zufälliger Gerätekennung).</p></div>
    <div class="panel"><h3>Datenquellen</h3>${sourcesHtml()}</div>
    <div class="panel"><h3>Verbrauch und Updates</h3><div id="statusPanel">${statusHtml()}</div></div>
    <div class="panel"><h3>Datenschutz</h3>
      <div class="btn-row" style="justify-content:flex-start"><button class="btn sec" type="button" data-act="export">Meine Daten exportieren</button><button class="btn sec" type="button" data-act="wipe">Meine Daten löschen</button><a class="btn sec" href="/privacy">Datenschutzerklärung</a></div></div>
    <div class="panel"><h3>Hilfe</h3><div class="btn-row" style="justify-content:flex-start"><button class="btn sec" type="button" data-act="intro">Einführung nochmals ansehen</button></div></div>
    <p class="fine">AFC ${esc(S.plan?.version || '8.0')} · ${S.plan?.siteCount ?? ''} Startplätze (DHV-Geländedatenbank) · Prognose: MeteoSchweiz, DWD, ECMWF über Open-Meteo · Messwerte: MeteoSchweiz · Karte: swisstopo. Keine Gewähr. Der Startentscheid liegt immer bei der Pilotin oder beim Piloten.</p>`;
}

/* ---- Flugbuch (lib/logbook.js, /api/logbook): Flüge, Ausrüstung, fällige Checks. Bleibt auf diesem Rechner. */
const LB = { data: null, req: null, year: 'all' };
const LG = () => window.AFCLog;
const lbFetch = (url, opt = {}) => fetch(url, { ...opt, headers: { 'X-AFC-Client': clientId, ...(opt.body ? { 'Content-Type': 'application/json' } : {}), ...(opt.headers || {}) } });
async function lbLoad(force = false) {
  if (LB.data && !force) return LB.data;
  LB.req ??= (async () => {
    const r = await lbFetch('/api/logbook');
    if (!r.ok) throw new Error('Flugbuch nicht erreichbar (' + r.status + ')');
    LB.data = await r.json();
    await lbMigrate();
    return LB.data;
  })().finally(() => { LB.req = null; });
  return LB.req;
}
// Einmalig: alte «Flug melden»-Einträge aus dem Browser ins Flugbuch übernehmen
async function lbMigrate() {
  if (store.get('logMigrated') || !LG()) return;
  for (const r of store.get('log', []).filter(x => x.launched)) {
    const f = LG().cleanFlight({ date: String(r.launchTime || '').slice(0, 10), siteId: r.siteId, siteName: r.name, rating: r.quality, note: r.note, afcScore: r.afcScore, start: new Date(r.launchTime).toTimeString().slice(0, 5) });
    if (f) await lbSave('flight', f, true).catch(() => {});
  }
  store.set('logMigrated', true);
}
async function lbSave(kind, item, quiet = false) {
  const r = await lbFetch(`/api/logbook/${kind}/${kind === 'settings' ? 'main' : item.id}`, { method: 'PUT', body: JSON.stringify(item) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Fehler ' + r.status);
  const d = LB.data;
  if (kind === 'settings') d.settings = j.item;
  else { const list = kind === 'flight' ? d.flights : d.gear, i = list.findIndex(x => x.id === j.item.id); if (i >= 0) list[i] = j.item; else list.push(j.item); }
  d.flights.sort((a, b) => (b.date + b.start).localeCompare(a.date + a.start));
  if (!quiet) lbSyncProfile();
  return j.item;
}
async function lbDelete(kind, id) {
  const r = await lbFetch(`/api/logbook/${kind}/${id}`, { method: 'DELETE' });
  if (!r.ok) throw new Error('Fehler ' + r.status);
  if (kind === 'flight') LB.data.flights = LB.data.flights.filter(x => x.id !== id);
  else LB.data.gear = LB.data.gear.filter(x => x.id !== id);
  lbSyncProfile();
}
/** Pilotenprofil aus dem Flugbuch nachführen (Flüge, Stunden, letzter Flug, Schirmklasse). */
function lbSyncProfile() {
  const d = LB.data, p = d && LG()?.profileFromLog(d.flights, d.settings);
  if (!p) return;
  const pr = { ...store.get('pilot', {}), ...p };
  const g = d.gear.find(x => x.id === d.settings.defaults?.glider);
  const cls = g?.cert?.toUpperCase().match(/\b(?:EN[- ]?)?([A-D])\b|CCC/);
  if (cls) pr.glider = cls[1] || 'D';
  store.set('pilot', pr);
  const pl = P()?.pilotLevel(pr);
  if (pl && !store.get('levelManual') && pl.level !== S.level) { S.level = pl.level; store.set('level', S.level); S.detail.clear(); loadPlan(); }
}
const ddmm = d => d.slice(8, 10) + '.' + d.slice(5, 7) + '.';
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const stars = n => (num(n) ? '★'.repeat(n) + '<span class="lb-off">' + '★'.repeat(5 - n) + '</span>' : '');
/** Fällige Checks und Packtermine (für Flugbuch und Entscheid). */
function gearAlerts() {
  const d = LB.data;
  if (!d || !LG()) return [];
  return d.gear.filter(g => !g.retired).flatMap(g => LG().gearStatus(g, d.flights).items.filter(x => x.level !== 'ok').map(x => ({ ...x, gear: LG().gearName(g) })));
}
function gearAlertHtml(list = gearAlerts()) {
  if (!list.length) return '';
  const due = list.some(x => x.level === 'due');
  return `<div class="lb-alert ${due ? 'due' : 'warn'}" role="status">${list.map(x => `<div><b>${esc(x.gear)}:</b> ${esc(x.text)}</div>`).join('')}</div>`;
}

function renderBook() {
  const el = $('#v-book');
  if (!LB.data) {
    el.innerHTML = '<div class="warm"><div class="spinner"></div>Flugbuch wird geladen …</div>';
    lbLoad().then(() => { if (S.tab === 'book') renderBook(); }).catch(err => { el.innerHTML = `<div class="empty">${esc(err.message)}</div>`; });
    return;
  }
  const L = LG(), d = LB.data, st = L.logStats(d.flights, d.settings);
  const years = [...new Set(d.flights.map(f => f.date.slice(0, 4)))].sort().reverse();
  const shown = LB.year === 'all' ? d.flights : d.flights.filter(f => f.date.startsWith(LB.year));
  const gearById = Object.fromEntries(d.gear.map(g => [g.id, g]));
  let lastMonth = '';
  const rows = shown.map(f => {
    const m = f.date.slice(0, 7), head = m !== lastMonth ? `<div class="lb-month">${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}</div>` : '';
    lastMonth = m;
    const route = [f.siteName || 'Start ?', f.landingName].filter(Boolean).join(' → ');
    const sub = [f.kind && L.FLIGHT_KINDS[f.kind], gearById[f.gliderId] && L.gearName(gearById[f.gliderId]), num(f.km) ? f.km + ' km' : '', f.track ? 'IGC' : ''].filter(Boolean).join(' · ');
    return `${head}<button type="button" class="lb-row" data-act="lbflight" data-id="${esc(f.id)}"><span class="lb-date">${ddmm(f.date)}${f.start ? `<small>${f.start}</small>` : ''}</span><span class="lb-main"><b>${esc(route)}</b><small>${esc(sub)}${f.rating ? ' ' + stars(f.rating) : ''}</small></span><span class="lb-dur">${f.durMin ? L.fmtDur(f.durMin) : '–'}</span></button>`;
  }).join('');
  const gear = d.gear.slice().sort((a, b) => a.retired - b.retired || Object.keys(L.GEAR_TYPES).indexOf(a.type) - Object.keys(L.GEAR_TYPES).indexOf(b.type));
  el.innerHTML = `
    ${gearAlertHtml()}
    <div class="panel">
      <div class="lb-head"><h3>Flugbuch</h3><button class="btn" type="button" data-act="lbflight">+ Flug</button></div>
      <div class="kv lb-kv">
        <div><b>${st.total}</b><span>Flüge total</span></div>
        <div><b>${L.fmtDur(st.totalMin)} h</b><span>Flugzeit total</span></div>
        <div><b>${st.yearFlights} · ${L.fmtDur(st.yearMin)}</b><span>${st.year}: Flüge · Std.</span></div>
        <div><b>${st.last ? Math.max(0, Math.round((Date.now() - Date.parse(st.last.date)) / 86400000)) + ' Tg.' : '–'}</b><span>seit dem letzten Flug</span></div>
      </div>
      ${years.length > 1 ? `<div class="seg" role="group" aria-label="Jahr">${['all', ...years].map(y => `<button type="button" data-act="lbyear" data-v="${y}" aria-pressed="${LB.year === y}">${y === 'all' ? 'Alle' : y}</button>`).join('')}</div>` : ''}
      <div class="lb-list">${rows || '<p class="fine" style="margin:8px 0 0">Noch keine Flüge. Tippe auf «+ Flug».</p>'}</div>
      ${st.longest?.durMin ? `<p class="fine">Längster Flug: ${L.fmtDur(st.longest.durMin)} h am ${ddmm(st.longest.date)}${st.longest.date.slice(0, 4)} (${esc(st.longest.siteName || '–')})${st.farthest ? ` · weitester: ${st.farthest.km} km` : ''}</p>` : ''}
    </div>
    <div class="panel">
      <div class="lb-head"><h3>Ausrüstung</h3><button class="btn sec" type="button" data-act="lbgear">+ Ausrüstung</button></div>
      ${gear.length ? `<div class="lb-gear">${gear.map(g => {
        const s = L.gearStatus(g, d.flights), def = Object.values(d.settings.defaults || {}).includes(g.id);
        return `<button type="button" class="lb-card ${g.retired ? 'off' : s.level}" data-act="lbgear" data-id="${esc(g.id)}"><span class="lb-type">${L.GEAR_TYPES[g.type]}${def ? ' · Standard' : ''}${g.retired ? ' · ausgemustert' : ''}</span><b>${esc(L.gearName(g))}</b>${g.cert ? `<small>${esc(g.cert)}</small>` : ''}<small>${g.type === 'reserve' ? '' : `${s.hours} h · ${s.flights} Flüge`}</small>${s.items.map(x => `<small class="lb-${x.level}">${esc(x.text)}</small>`).join('')}</button>`;
      }).join('')}</div>` : '<p class="fine" style="margin:0">Erfasse Schirm, Gurtzeug und Retter. AFC zählt dann die Stunden und erinnert an Schirm-Check und Retter-Packen.</p>'}
    </div>
    <div class="panel"><h3>Flüge vor dem Flugbuch</h3>
      <p class="fine" style="margin:0 0 8px">Damit Total und Pilotenprofil stimmen: was du vorher geflogen bist.</p>
      <form id="lbSettings" class="pilot-form">
        <label class="fld"><span>Flüge</span><input type="number" inputmode="numeric" min="0" name="flightsBefore" value="${d.settings.flightsBefore || ''}"></label>
        <label class="fld"><span>Stunden</span><input type="number" inputmode="decimal" min="0" step="0.5" name="hoursBefore" value="${d.settings.hoursBefore || ''}"></label>
        <div class="btn-row" style="justify-content:flex-start"><button class="btn sec" type="submit">Speichern</button></div>
      </form>
      <p class="fine">Das Flugbuch liegt nur auf diesem Rechner (data/afc.sqlite, täglich gesichert). Es füllt dein Pilotenprofil automatisch.</p>
    </div>`;
}

function flightForm(id) {
  const L = LG(), d = LB.data, f = d.flights.find(x => x.id === id) || null;
  const def = d.settings.defaults || {};
  const v = f || { date: todayKey(), start: '', durMin: 0, gliderId: def.glider, harnessId: def.harness, reserveId: def.reserve, rating: null };
  const opts = (type, sel) => `<option value="">–</option>` + d.gear.filter(g => g.type === type && (!g.retired || g.id === sel)).map(g => `<option value="${esc(g.id)}" ${g.id === sel ? 'selected' : ''}>${esc(L.gearName(g))}</option>`).join('');
  const sites = [...new Set((S.plan?.sites || []).map(s => s.name))].sort((a, b) => a.localeCompare(b, 'de'));
  const lands = [...new Set((S.plan?.landings || []).map(s => s.name))].sort((a, b) => a.localeCompare(b, 'de'));
  dlg('#msgDlg', `<form class="dlg-in lb-form" id="lbFlightForm"><div class="dlg-h"><h2 id="msgDlgT">${f ? 'Flug bearbeiten' : 'Flug erfassen'}</h2><button class="x-btn" type="button" data-act="closemsg" aria-label="Schliessen">×</button></div>
    <div class="lb-grid">
      <label class="fld"><span>Datum</span><input type="date" name="date" required value="${esc(v.date)}" max="${todayKey()}"></label>
      <label class="fld"><span>Startzeit</span><input type="time" name="start" value="${esc(v.start)}"></label>
      <label class="fld"><span>Dauer (Std. : Min.)</span><span class="lb-dur-in"><input type="number" inputmode="numeric" min="0" max="23" name="durH" value="${v.durMin ? Math.floor(v.durMin / 60) : ''}" aria-label="Stunden"> : <input type="number" inputmode="numeric" min="0" max="59" name="durM" value="${v.durMin ? v.durMin % 60 : ''}" aria-label="Minuten"></span></label>
      <label class="fld"><span>Art</span><select name="kind"><option value="">–</option>${Object.entries(L.FLIGHT_KINDS).map(([k, t]) => `<option value="${k}" ${v.kind === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="fld lb-wide"><span>Startplatz</span><input name="siteName" list="lbSites" autocomplete="off" value="${esc(v.siteName || '')}"></label>
      <label class="fld lb-wide"><span>Landeplatz</span><input name="landingName" list="lbLands" autocomplete="off" value="${esc(v.landingName || '')}"></label>
      <label class="fld"><span>Strecke km</span><input type="number" inputmode="decimal" min="0" step="0.1" name="km" value="${num(v.km) ? v.km : ''}"></label>
      <label class="fld"><span>Max. Höhe m</span><input type="number" inputmode="numeric" min="0" name="maxAlt" value="${num(v.maxAlt) ? v.maxAlt : ''}"></label>
      <label class="fld"><span>Schirm</span><select name="gliderId">${opts('glider', v.gliderId)}</select></label>
      <label class="fld"><span>Gurtzeug</span><select name="harnessId">${opts('harness', v.harnessId)}</select></label>
      <label class="fld"><span>Retter</span><select name="reserveId">${opts('reserve', v.reserveId)}</select></label>
      <div class="fld lb-wide"><span id="lbRateL">Bewertung</span><div class="stars" role="radiogroup" aria-labelledby="lbRateL">${[1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="rating" value="${n}" ${v.rating === n ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div></div>
      <label class="fld lb-wide"><span>Notiz (Bedingungen, Lernpunkte)</span><textarea name="note" maxlength="500" rows="3">${esc(v.note || '')}</textarea></label>
    </div>
    <datalist id="lbSites">${sites.map(n => `<option value="${esc(n)}">`).join('')}</datalist><datalist id="lbLands">${lands.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
    <div id="lbErr" class="fine" role="alert"></div>
    <div class="btn-row">${f ? '<button class="btn danger sec" type="button" data-act="lbdelflight">Löschen</button>' : ''}<button class="btn sec" type="button" data-act="closemsg">Abbrechen</button><button class="btn" type="submit">Speichern</button></div></form>`);
  const form = $('#lbFlightForm');
  form.dataset.id = f?.id || '';
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const x = Object.fromEntries(new FormData(form));
    const site = (S.plan?.sites || []).find(s => s.name === x.siteName), land = (S.plan?.landings || []).find(s => s.name === x.landingName);
    const item = { ...(f || {}), id: f?.id || L.newId(), date: x.date, start: x.start, durMin: (Number(x.durH) || 0) * 60 + (Number(x.durM) || 0), kind: x.kind, siteName: x.siteName, siteId: site?.id || null, landingName: x.landingName, landingId: land?.id || null, km: x.km, maxAlt: x.maxAlt, gliderId: x.gliderId || null, harnessId: x.harnessId || null, reserveId: x.reserveId || null, rating: x.rating ? Number(x.rating) : null, note: x.note };
    // AFC-Score des Startplatzes festhalten, wenn der Flug heute war (zum späteren Abgleich)
    if (!f && site && x.date === todayKey()) item.afcScore = site.days?.[0]?.best?.score ?? null;
    try { await lbSave('flight', item); closeDlg($('#msgDlg')); toast('Flug gespeichert'); renderBook(); }
    catch (err) { $('#lbErr').textContent = 'Nicht gespeichert: ' + err.message; }
  });
}

function gearForm(id) {
  const L = LG(), d = LB.data, g = d.gear.find(x => x.id === id) || null;
  const v = g || { type: 'glider', checkMonths: 24, checkHours: 100, packMonths: 6 };
  const isDef = g && Object.values(d.settings.defaults || {}).includes(g.id);
  const t = (n, l, val, type = 'text', extra = '') => `<label class="fld" data-for="${extra}"><span>${l}</span><input type="${type}" name="${n}" value="${esc(val ?? '')}" ${type === 'number' ? 'inputmode="decimal" min="0"' : ''}></label>`;
  dlg('#msgDlg', `<form class="dlg-in lb-form" id="lbGearForm"><div class="dlg-h"><h2 id="msgDlgT">${g ? 'Ausrüstung bearbeiten' : 'Ausrüstung erfassen'}</h2><button class="x-btn" type="button" data-act="closemsg" aria-label="Schliessen">×</button></div>
    <div class="lb-grid">
      <label class="fld lb-wide"><span>Art</span><select name="type">${Object.entries(L.GEAR_TYPES).map(([k, n]) => `<option value="${k}" ${v.type === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      ${t('brand', 'Marke', v.brand)}${t('model', 'Modell', v.model)}${t('size', 'Grösse', v.size)}
      ${t('cert', 'Klasse / Zulassung', v.cert, 'text', 'glider harness reserve')}
      ${t('serial', 'Seriennummer', v.serial)}${t('bought', 'Gekauft', v.bought, 'date')}
      ${t('hoursBefore', 'Stunden vor dem Flugbuch', v.hoursBefore || '', 'number', 'glider harness')}
      ${t('checkLast', 'Letzter Check', v.checkLast, 'date', 'glider harness')}
      ${t('checkMonths', 'Check alle … Monate', v.checkMonths ?? '', 'number', 'glider harness')}
      ${t('checkHours', 'oder alle … Stunden', v.checkHours ?? '', 'number', 'glider')}
      ${t('packedLast', 'Zuletzt gepackt', v.packedLast, 'date', 'reserve')}
      ${t('packMonths', 'Packen alle … Monate', v.packMonths ?? '', 'number', 'reserve')}
      <label class="chk lb-wide"><input type="checkbox" name="isDefault" ${isDef || (!g && !d.gear.some(x => x.type === v.type && !x.retired)) ? 'checked' : ''}><span>Standard für neue Flüge</span></label>
      <label class="chk lb-wide"><input type="checkbox" name="retired" ${v.retired ? 'checked' : ''}><span>Ausgemustert (verkauft, ersetzt)</span></label>
      <label class="fld lb-wide"><span>Notiz</span><textarea name="note" maxlength="300" rows="2">${esc(v.note || '')}</textarea></label>
    </div>
    <p class="fine">Fristen laut Hersteller eintragen. Üblich sind beim Schirm ein Check alle 1 bis 3 Jahre oder nach 100 bis 150 Stunden, beim Retter Packen alle 6 bis 12 Monate.</p>
    <div id="lbErr" class="fine" role="alert"></div>
    <div class="btn-row">${g ? '<button class="btn danger sec" type="button" data-act="lbdelgear">Löschen</button>' : ''}<button class="btn sec" type="button" data-act="closemsg">Abbrechen</button><button class="btn" type="submit">Speichern</button></div></form>`);
  const form = $('#lbGearForm');
  form.dataset.id = g?.id || '';
  // Nur die Felder zeigen, die zur Art passen
  const show = () => { const ty = form.type.value; form.querySelectorAll('[data-for]').forEach(l => { l.hidden = !!l.dataset.for && !l.dataset.for.split(' ').includes(ty); }); };
  form.type.addEventListener('change', show); show();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const x = Object.fromEntries(new FormData(form));
    const item = { ...(g || {}), ...x, id: g?.id || L.newId(), retired: x.retired === 'on' };
    try {
      const saved = await lbSave('gear', item);
      const defs = { ...(d.settings.defaults || {}) }, slot = saved.type;
      if (slot !== 'other') {
        if (x.isDefault === 'on' && !saved.retired) defs[slot] = saved.id; else if (defs[slot] === saved.id) defs[slot] = null;
        await lbSave('settings', { ...d.settings, defaults: defs });
      }
      closeDlg($('#msgDlg')); toast('Gespeichert'); renderBook();
    } catch (err) { $('#lbErr').textContent = 'Nicht gespeichert: ' + err.message; }
  });
}

/* ---- Pilotenprofil: Erfahrung und Übung bestimmen die Grenzen (lib/pilot.js) */
const P = () => window.AFCPilot;
function pilotPanel() {
  const pr = store.get('pilot', {}), pl = P()?.pilotLevel(pr);
  const n = (name, label, v, extra = '') => `<label class="fld"><span>${label}</span><input type="number" inputmode="numeric" min="0" max="20000" name="${name}" value="${num(v) ? v : ''}" ${extra}></label>`;
  return `<div class="panel"><h3>Ich als Pilot</h3>
    <form id="pilotForm" class="pilot-form">
      ${LB.data?.flights.length ? '<p class="fine lb-wide" style="margin:0;grid-column:1/-1">Flüge, Stunden und letzter Flug kommen aus deinem <a href="#" data-act="tab" data-tab="book">Flugbuch</a>.</p>' : ''}
      ${n('flights', 'Flüge total', pr.flights)}
      ${n('hours12', 'Flugstunden letzte 12 Monate', pr.hours12)}
      <label class="fld"><span>Schirm</span><select name="glider">${Object.entries(P()?.GLIDERS || {}).map(([k, t]) => `<option value="${k}" ${(pr.glider || 'B') === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="fld"><span>Letzter Flug</span><input type="date" name="lastFlight" value="${esc(pr.lastFlight || '')}" max="${todayKey()}"></label>
      <label class="chk"><input type="checkbox" name="student" ${pr.student ? 'checked' : ''}><span>Ich bin in Ausbildung (noch kein Brevet)</span></label>
      <div class="btn-row" style="justify-content:flex-start"><button class="btn" type="submit">Speichern</button></div>
    </form>
    ${pl ? `<p>AFC rechnet für dich mit <b>${LEVEL_INFO[pl.level][0]}</b>${S.level !== pl.level ? ` (du hast gerade «${LEVEL_INFO[S.level][0]}» gewählt)` : ''}:</p><ul class="why-list">${pl.why.map(x => `<li>${esc(x)}</li>`).join('')}</ul><p class="fine">${esc(LEVEL_INFO[pl.level][1])} Bei jedem Startplatz zeigt «Kurz erklärt» unter «Du», was für dich persönlich zu beachten ist.</p>`
      : `<p class="fine">Trag deine Erfahrung ein, dann passt AFC Wind- und Böengrenzen an dich an. Bis dahin gilt «${LEVEL_INFO[S.level][0]}».</p>`}
    <div class="seg" role="group" aria-label="Erfahrungsstufe selbst wählen">${['careful', 'normal', 'expert'].map(k => `<button type="button" data-act="level" data-v="${k}" aria-pressed="${S.level === k}">${LEVEL_INFO[k][0]}</button>`).join('')}</div>
    <p class="fine">Stufe selbst wählen, z.B. für einen unbekannten Platz. Speichern des Profils setzt sie wieder automatisch.</p></div>`;
}
function savePilot(form) {
  const f = new FormData(form), int = k => { const v = f.get(k); return v === '' || v == null ? null : Math.max(0, Math.round(Number(v))); };
  const pr = { flights: int('flights'), hours12: int('hours12'), glider: f.get('glider') || 'B', lastFlight: f.get('lastFlight') || null, student: f.get('student') === 'on' };
  store.set('pilot', pr); store.del('levelManual');
  const pl = P()?.pilotLevel(pr);
  if (pl && pl.level !== S.level) { S.level = pl.level; store.set('level', S.level); S.detail.clear(); loadPlan(); }
  toast(pl ? `Gespeichert: Stufe «${LEVEL_INFO[pl.level][0]}»` : 'Gespeichert');
  render();
}

/** Vergleich AFC-Score mit der eigenen Bewertung: lag AFC richtig? */
function flightMatch(r) {
  if (!num(r.afcScore)) return null;
  const mine = !r.launched || r.quality <= 2 ? 'bad' : r.quality >= 4 ? 'good' : 'mid';
  const afc = r.afcScore >= 80 ? 'good' : r.afcScore < 55 ? 'bad' : 'mid';
  if (afc === 'good' && mine === 'bad') return 'zu optimistisch';
  if (afc === 'bad' && mine === 'good') return 'zu streng';
  return 'passt';
}
function flightCheck(log) {
  const rated = log.filter(r => flightMatch(r));
  if (rated.length < 3) return rated.length ? '<p class="fine" style="margin:0 0 8px">Ab drei gemeldeten Flügen zeigt AFC hier, wie gut der Score zu deinen Bewertungen passt.</p>' : '';
  const ok = rated.filter(r => flightMatch(r) === 'passt').length;
  const opt = rated.filter(r => flightMatch(r) === 'zu optimistisch').length, str = rated.filter(r => flightMatch(r) === 'zu streng').length;
  return `<div class="kv" style="margin-bottom:10px"><div><b>${ok} / ${rated.length}</b><span>Score passte zu deiner Bewertung</span></div><div><b>${opt}</b><span>AFC zu optimistisch (80+, Flug schlecht)</span></div><div><b>${str}</b><span>AFC zu streng (unter 55, Flug gut)</span></div></div>`;
}

/* ---------------------------------------------------------------- Dialoge */
function dlg(id, html) {
  const d = $(id);
  d.innerHTML = html;
  if (!d.open) d.showModal();
  return d;
}
function closeDlg(d) { if (d?.open) d.close(); }
function ask({ title, text, ok = 'OK', danger = false, cancel = 'Abbrechen' }) {
  return new Promise(res => {
    const d = dlg('#msgDlg', `<div class="dlg-in"><h2 id="msgDlgT" style="font:700 24px var(--f-num)">${esc(title)}</h2><p>${esc(text)}</p><div class="btn-row">${cancel ? `<button class="btn sec" type="button" data-r="0">${esc(cancel)}</button>` : ''}<button class="btn ${danger ? 'danger' : ''}" type="button" data-r="1" autofocus>${esc(ok)}</button></div></div>`);
    const done = v => { d.removeEventListener('click', on); d.removeEventListener('close', onc); closeDlg(d); res(v); };
    const on = e => { const b = e.target.closest('[data-r]'); if (b) done(b.dataset.r === '1'); };
    const onc = () => { d.removeEventListener('click', on); res(false); };
    d.addEventListener('click', on); d.addEventListener('close', onc, { once: true });
  });
}
/* ---- Kurze Einführung beim ersten Öffnen (später unter Profil nochmals aufrufbar) */
const INTRO_VER = 1;
const INTRO = [
  ['Willkommen bei AFC', 'AFC rechnet für jeden Startplatz im Berner Oberland stündlich aus, wie gut und wie sicher ein Start ist. Ab 80 Punkten sieht es gut aus, von 55 bis 79 nur mit Vorsicht, darunter besser am Boden bleiben.'],
  ['Immer mit Begründung', 'Tippe auf einen Startplatz: Unter «Kurz erklärt» steht, warum es passt oder nicht, zum Beispiel Rückenwind, Böen, Wolke am Start oder Gewitter am Nachmittag. Die Stundentabelle zeigt, wann das beste Fenster ist.'],
  ['Karte, Thermik und Soaring', 'Auf der Karte unten «Thermik» oder «Soaring» wählen. Tippe irgendwo auf die Karte, dann erklärt AFC, warum es dort steigt oder nicht. Unter «Ebenen» kannst du die Thermik-Hotspots und Flugspuren von kk7 einblenden.'],
  ['Route von A nach B', 'Auf der Karte «Route» tippen, dann Startpunkt A und Ziel B. AFC sucht eine Strecke über die Thermik, mit genug Höhe und Landeplätzen im Gleitbereich, bleibt unter Lufträumen und markiert kritische Stellen. Tippst du auf eine rote Fläche, siehst du den Luftraum mit seinen Höhen.'],
  ['Dein Profil', 'Unter «Profil» trägst du Flüge, Stunden, Schirm und letzten Flug ein. Daraus wählt AFC deine Grenzen für Wind und Thermik und rechnet die Route mit deiner Gleitzahl. AFC ersetzt nie deine eigene Beurteilung am Startplatz.']
];
function showIntro(i = 0) {
  const last = i === INTRO.length - 1, [t, x] = INTRO[i];
  const d = dlg('#msgDlg', `<div class="dlg-in intro"><div class="dlg-h"><h2 id="msgDlgT">${esc(t)}</h2><button class="x-btn" type="button" data-intro="end" aria-label="Schliessen">×</button></div>
    <p>${esc(x)}</p>
    <div class="intro-dots" aria-label="Schritt ${i + 1} von ${INTRO.length}">${INTRO.map((_, k) => `<span class="${k === i ? 'on' : ''}"></span>`).join('')}</div>
    <div class="btn-row">${i ? `<button class="btn sec" type="button" data-intro="${i - 1}">Zurück</button>` : `<button class="btn sec" type="button" data-intro="end">Überspringen</button>`}<button class="btn" type="button" data-intro="${last ? (store.get('pilot')?.flights != null ? 'end' : 'profile') : i + 1}" autofocus>${last ? (store.get('pilot')?.flights != null ? 'Los gehts' : 'Profil ausfüllen') : 'Weiter'}</button></div></div>`);
  d.onclick = e => {
    const b = e.target.closest('[data-intro]'); if (!b) return;
    const v = b.dataset.intro;
    if (/^\d+$/.test(v)) return showIntro(Number(v));
    d.onclick = null; store.set('intro', INTRO_VER); closeDlg(d);
    if (v === 'profile') setTab('profile');
  };
  d.onclose = () => store.set('intro', INTRO_VER);
}
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3200);
}

/* ---- Startplatz-Ansicht */
async function openSite(id) {
  if (!S.plan || !siteById(id)) return;
  const base = siteById(id);
  S.site = id; S.hour = null;
  dlg('#siteDlg', `<div class="dlg-in"><div class="dlg-h"><h2 id="siteDlgT">${esc(base.name)}</h2><button class="x-btn" type="button" data-act="closesite" aria-label="Schliessen">×</button></div><div class="warm"><div class="spinner"></div>Lade Details …</div></div>`);
  try {
    const d = await loadDetail(id);
    if (S.site !== id) return;
    S.detailData = d;
    const best = d.days[S.day]?.best;
    S.hour = best?.peak ?? d.days[S.day]?.hours.find(h => num(h.score))?.h ?? null;
    renderSite();
  } catch (e) {
    dlg('#siteDlg', `<div class="dlg-in"><div class="dlg-h"><h2 id="siteDlgT">${esc(base.name)}</h2><button class="x-btn" type="button" data-act="closesite" aria-label="Schliessen">×</button></div><div class="empty">Details konnten nicht geladen werden: ${esc(e.message)}</div></div>`);
  }
}
function profileHtml(prof) {
  if (!prof?.length) return '<p class="fine">Kein Windprofil verfügbar (Höhenmodell fehlt).</p>';
  const max = Math.max(40, ...prof.map(p => p[1]));
  return `<div class="profile" role="table" aria-label="Windprofil">${[...prof].reverse().map(p => `<div class="pr" role="row"><span>+${p[0]} m</span><span class="bar"><i class="${p[1] >= 40 ? 'hi' : ''}" style="width:${Math.round(p[1] / max * 100)}%"></i></span><b>${p[1]} ${arrow(p[2])} ${dirLabel(p[2])}</b></div>`).join('')}</div>`;
}
function renderSite() {
  const d = S.detailData, day = d.days[S.day];
  const s = d.site, hrs = day?.hours || [];
  const hr = hrs.find(h => h.h === S.hour) || hrs[0];
  const scores = Array(16).fill(null);
  for (const h of hrs) scores[h.h - S.plan.h0] = h.score;
  const fav = S.fav.has(s.id);
  const c = hr ? cls(hr.score) : 'none';
  const nc = d.nowcast;
  const detailHtml = hr ? `
    <div class="hr-detail">
      <div class="hr-head">${pill(hr.score, false)}<div><h3>${hr.h}–${hr.h + 1} Uhr: ${DECISION[c]}</h3><p class="fine" style="margin:0">${hr.cap != null ? 'Gedeckelt auf ' + hr.cap + ' wegen K.-o.-Kriterium' : 'Kein K.-o.-Kriterium aktiv'}</p></div></div>
      ${hr.why?.length ? `<h3 class="why-h">Kurz erklärt</h3><ul class="why">${[...hr.why, P()?.pilotHint(store.get('pilot', {}), hr)].filter(Boolean).map(f => `<li class="why-${f.lvl}"><span class="why-i" aria-label="${f.lvl === 'ok' ? 'in Ordnung' : f.lvl === 'warn' ? 'beachten' : 'nicht fliegbar'}">${f.lvl === 'ok' ? '✓' : f.lvl === 'warn' ? '!' : '✕'}</span><b>${esc(f.k)}</b><span>${esc(f.t)}</span></li>`).join('')}</ul>` : ''}
      <details class="why-more"><summary>Alle Gründe für den Score</summary>
      ${hr.hard.length ? `<ul class="ko">${hr.hard.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${hr.reasons.length ? `<ul class="rs">${hr.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="fine">Keine Auffälligkeiten.</p>'}
      </details>
      <div class="kv">
        <div><b>${hr.speed ?? '–'} ${arrow(hr.dir)}</b><span>Wind km/h aus ${dirLabel(hr.dir)} (${hr.dir ?? '–'}°)</span></div>
        <div><b>${hr.gust ?? '–'}</b><span>Böen km/h</span></div>
        <div><b>${hr.head ?? '–'} / ${hr.tail ?? '–'}</b><span>Gegenwind / Rückenwind${hr.wd != null ? ', ' + hr.wd + '° neben dem Hang' : ''}</span></div>
        <div><b>${hr.cloudMargin ?? '–'} m</b><span>Wolkenbasis über Start${hr.cloudBase ? ' (Basis ' + hr.cloudBase + ' m)' : ''}</span></div>
        <div><b>${hr.pop ?? '–'} %</b><span>Regenrisiko, CAPE ${hr.cape ?? '–'}</span></div>
        <div><b>${hr.thermal}</b><span>Thermikindex (0–100)</span></div>
        ${hr.thermalTop != null ? `<div><b>${hr.thermalTop} m</b><span>Thermik bis${hr.topMargin != null ? ' (' + (hr.topMargin >= 0 ? '+' : '') + hr.topMargin + ' m über Start)' : ''}${hr.wstar ? ', Steigen ca. ' + hr.wstar.toFixed(1) + ' m/s' : ''}${hr.inversion ? ', Inversion ab ' + hr.inversion + ' m' : ''}</span></div>` : ''}
        <div><b>${hr.valley ? hr.valley[0] + ' / ' + hr.valley[1] : '–'}</b><span>Landewind Wind / Böen km/h</span></div>
        <div><b>${hr.shear ?? '–'}</b><span>Scherung 500 m über Start km/h</span></div>
        ${hr.spread != null ? `<div><b>${hr.spread}</b><span>Modell-Unterschied km/h</span></div>` : ''}
      </div>
      <h3 style="font:700 18px var(--f-num)">Wind über dem Startplatz</h3>
      ${profileHtml(hr.prof)}
    </div>` : '<div class="empty">Für diesen Tag gibt es keine Bewertung.</div>';
  const table = hrs.length ? `<div class="hours-tbl"><table><thead><tr><th>Uhr</th><th>Score</th><th>Wind</th><th>Böen</th><th>Dir.</th><th>Basis</th><th>Regen</th></tr></thead><tbody>${hrs.map(h => `<tr class="${h.h === hr?.h ? 'sel' : ''}" data-act="hour" data-h="${h.h}" tabindex="0"><td>${h.h}</td><td><b class="mini-pill s-${cls(h.score)}" style="display:inline-block">${h.score}</b></td><td>${h.speed ?? '–'}</td><td>${h.gust ?? '–'}</td><td>${arrow(h.dir)} ${dirLabel(h.dir)}</td><td>${h.cloudBase ?? '–'}</td><td>${h.pop ?? '–'} %</td></tr>`).join('')}</tbody></table></div>` : '';
  dlg('#siteDlg', `<div class="dlg-in">
    <div class="dlg-h"><div><h2 id="siteDlgT">${esc(s.name)}</h2><p class="fine" style="margin:2px 0 0">${s.alt} m · Ausrichtung ${esc(aspectText(s))}${s.status ? ' · ' + esc(s.status) : ''}</p></div><button class="x-btn" type="button" data-act="closesite" aria-label="Schliessen">×</button></div>
    <div class="btn-row" style="justify-content:flex-start">${starBtn(s.id).replace('class="star"', 'class="star" style="border:1px solid var(--line);border-radius:8px"')}<button class="btn sec" type="button" data-act="showmap" data-id="${esc(s.id)}">Auf Karte</button><button class="btn sec" type="button" data-act="report" data-id="${esc(s.id)}">Flug melden</button></div>
    <div><strong>${dayName(S.day)}</strong> · bestes Fenster <strong>${winText(day?.best)}</strong>${day?.best ? ` · Score ${day.best.score}` : ''}</div>
    ${ribbon(scores, day?.best, { big: true, btn: true, sel: hr?.h, axis: true, now: nowHourToday() })}
    ${detailHtml}
    ${table}
    <div class="panel" style="margin:0"><h3>Messung gegen Prognose</h3>${nc ? `<p>${esc(nc.name)} (${nc.dist} km, ${nc.altDiff >= 0 ? '+' : ''}${nc.altDiff} m Höhe) misst <b>${nc.obs} km/h</b> aus ${dirLabel(nc.obsDir)}; die Prognose sagte <b>${nc.fc} km/h</b> aus ${dirLabel(nc.fcDir)}. Abweichung ${nc.bias >= 0 ? '+' : ''}${nc.bias} km/h, in den nächsten 2 bis 3 Stunden eingerechnet. Messung ${nc.ageMin} min alt.</p>` : '<p class="fine" style="margin:0">Keine passende Station in der Nähe (höchstens 15 km und 600 m Höhenunterschied). Es gilt die reine Prognose.</p>'}</div>
  </div>`);
}
function reportForm(id) {
  const s = siteById(id);
  const best = s?.days[0]?.best;
  dlg('#msgDlg', `<form class="dlg-in" id="repForm"><div class="dlg-h"><h2 id="msgDlgT">Flug melden</h2><button class="x-btn" type="button" data-act="closemsg" aria-label="Schliessen">×</button></div>
    <p>${esc(s.name)}</p>
    <label class="chk"><input type="checkbox" name="launched" checked><span>Ich bin gestartet</span></label>
    <div class="fld"><span id="qL">Wie war der Flug?</span><div class="stars" role="radiogroup" aria-labelledby="qL">${[1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="quality" value="${n}" ${n === 3 ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div><span class="fine">1 = schlecht, 5 = ausgezeichnet</span></div>
    <label class="fld"><span>Notiz (optional, höchstens 280 Zeichen)</span><textarea name="note" maxlength="280" rows="3"></textarea></label>
    <div id="repErr" class="fine" role="alert"></div>
    <div class="btn-row"><button class="btn sec" type="button" data-act="closemsg">Abbrechen</button><button class="btn" type="submit">Melden</button></div></form>`);
  $('#repForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { siteId: id, launchTime: new Date().toISOString(), launched: f.get('launched') === 'on', quality: Number(f.get('quality')), afcScore: best?.score ?? null, afcDecision: best?.decision?.label || '', note: f.get('note') || '' };
    try {
      const r = await fetch('/api/flight-report', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-AFC-Client': clientId }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Fehler ${r.status}`);
      const log = store.get('log', []); log.push({ siteId: id, name: s.name, launchTime: body.launchTime, launched: body.launched, quality: body.quality, afcScore: body.afcScore, note: body.note }); store.set('log', log.slice(-200));
      closeDlg($('#msgDlg')); toast('Danke, Flug gemeldet');
    } catch (err) { $('#repErr').textContent = 'Nicht gemeldet: ' + err.message; }
  });
}

/* ---------------------------------------------------------------- Karte */
const SWT = (layer, ext = 'jpeg') => `https://wmts.geo.admin.ch/1.0.0/${layer}/default/current/3857/{z}/{x}/{y}.${ext}`;
const BASES = {
  color: { url: SWT('ch.swisstopo.pixelkarte-farbe'), attr: '© <a href="https://www.swisstopo.admin.ch/">swisstopo</a>', max: 18 },
  grey: { url: SWT('ch.swisstopo.pixelkarte-grau'), attr: '© <a href="https://www.swisstopo.admin.ch/">swisstopo</a>', max: 18 },
  photo: { url: SWT('ch.swisstopo.swissimage'), attr: '© <a href="https://www.swisstopo.admin.ch/">swisstopo</a>', max: 18 },
  osm: { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende', max: 18, subdomains: 'abc' }
};
const KK7 = layer => `https://thermal.kk7.ch/tiles/${layer}/{z}/{x}/{y}.png?src=${encodeURIComponent(location.hostname || 'afc')}`;
const KK7_ATTR = '<a href="https://thermal.kk7.ch">thermal.kk7.ch</a> (<a href="https://creativecommons.org/licenses/by-nc-sa/4.0/">CC BY-NC-SA</a>)';
const OVERLAYS = {
  slope: { url: SWT('ch.swisstopo.hangneigung-ueber_30', 'png'), name: 'Hangneigung', opacity: 0.55 },
  obst: { url: SWT('ch.bazl.luftfahrthindernis', 'png'), name: 'Hindernisse', opacity: 0.9 },
  // kk7: Auswertung von rund 3,8 Mio. Flügen (XContest, DHV-XC, Leonardo u. a.), CC BY-NC-SA 4.0, nur nicht-kommerziell
  kk7thermal: { url: KK7('thermals_all_all'), name: 'Thermik aus Flügen (kk7)', opacity: 0.6, tms: true, maxNative: 12, attr: KK7_ATTR },
  kk7sky: { url: KK7('skyways_all_all'), name: 'Skyways aus Flügen (kk7)', opacity: 0.6, tms: true, maxNative: 13, attr: KK7_ATTR }
};
const M = { map: null, base: null, baseKey: null, ov: {}, group: null, me: null, errs: {}, loaded: 0 };

function mapMsg(t) { const m = $('#mapMsg'); m.hidden = !t; m.textContent = t || ''; }
function setBase(key) {
  if (!M.map || !BASES[key]) return;
  if (M.base) M.map.removeLayer(M.base);
  const b = BASES[key];
  M.baseKey = key; store.set('base', key);
  M.errs.base = 0; M.loaded = 0;
  M.base = L.tileLayer(b.url, { attribution: b.attr, maxZoom: b.max, subdomains: b.subdomains || 'abc' });
  M.base.on('tileload', () => { M.loaded++; });
  M.base.on('tileerror', () => {
    M.errs.base = (M.errs.base || 0) + 1;
    if (key !== 'osm' && M.errs.base >= 6 && !M.loaded) { toast('swisstopo-Karte nicht erreichbar, wechsle zu OpenStreetMap'); setBase('osm'); syncLayerPanel(); }
  });
  M.base.addTo(M.map);
  if (M.base.bringToBack) M.base.bringToBack();
}
function setOverlay(key, on) {
  if (!M.map) return;
  if (M.ov[key]) { M.map.removeLayer(M.ov[key]); delete M.ov[key]; }
  const keep = store.get('ov', {}); keep[key] = on; store.set('ov', keep);
  if (!on || !OVERLAYS[key]) return;
  const o = OVERLAYS[key];
  let errs = 0, ok = 0;
  const l = L.tileLayer(o.url, { opacity: o.opacity, maxZoom: 18, attribution: o.attr || '© swisstopo, BAZL', tms: !!o.tms, maxNativeZoom: o.maxNative || 18 });
  l.on('tileload', () => { ok++; });
  l.on('tileerror', () => { errs++; if (errs === 8 && !ok) { mapMsg(`Ebene «${o.name}» liefert keine Kacheln. Sie ist möglicherweise nicht verfügbar.`); setTimeout(() => mapMsg(''), 7000); } });
  l.addTo(M.map); M.ov[key] = l;
}
function syncLayerPanel() {
  $$('#layerPanel input[name="base"]').forEach(i => { i.checked = i.value === M.baseKey; });
  const ov = store.get('ov', {});
  $$('#layerPanel input[name="ov"]').forEach(i => { if (i.value in ov) i.checked = !!ov[i.value]; });
}
/* ---- Lufträume (SHV/FSVL, /api/airspace) auf der Karte und im Routenplaner (lib/airspace.js) */
const AIR = { list: null, at: null, req: null, layer: null, n: 0, raster: null, rasterKey: '' };
const AIR_STYLE = { block: { color: '#c62828', fillOpacity: 0.1, weight: 2 }, warn: { color: '#ef6c00', fillOpacity: 0.06, weight: 2, dashArray: '6 4' }, wild: { color: '#2e7d32', fillOpacity: 0.08, weight: 1.5, dashArray: '3 4' } };
const AIR_RULE = { block: 'für Gleitschirme gesperrt (ohne Bewilligung)', warn: 'Gefahrengebiet: Aktivzeiten im DABS prüfen', wild: 'Wildschutz: nicht tief überfliegen, Abstand halten' };
const airOn = kind => !!store.get('ov', {})[kind === 'wild' ? 'wild' : 'air'];   // standardmässig aus, damit die Karte übersichtlich bleibt
const AIR_MAX_LO = 3000;   // höher beginnende Lufträume (CTA, obere TMA) nur antippen, nicht zeichnen
async function airData() {
  if (AIR.list) return AIR.list;
  AIR.req ??= fetch('/api/airspace').then(r => (r.status === 200 ? r.json() : null)).then(j => {
    AIR.req = null;
    if (!j?.items) return null;
    AIR.at = j.at;
    AIR.list = j.items.map(a => ({ name: a.n, cls: a.c, type: a.t, kind: a.k, freq: a.f, lo: a.lo, hi: a.hi, bbox: a.b, poly: a.p }));
    return AIR.list;
  }).catch(() => (AIR.req = null));
  return AIR.req;
}
async function updateAir() {
  if (!M.map) return;
  const n = ++AIR.n;
  const list = airOn('air') || airOn('wild') ? await airData() : null;
  if (n !== AIR.n) return;
  const btn = $('[data-act="airtoggle"]'); if (btn) btn.setAttribute('aria-pressed', String(airOn('air') || airOn('wild')));
  if (AIR.layer) { M.map.removeLayer(AIR.layer); AIR.layer = null; }
  if (!list) return;
  if (!M.map.getPane('air')) { const pn = M.map.createPane('air'); pn.style.zIndex = 430; pn.style.pointerEvents = 'none'; }
  const g = L.layerGroup();
  for (const a of list) {
    if (!AIR_STYLE[a.kind] || !airOn(a.kind)) continue;
    if (a.lo.ref === 'MSL' && a.lo.m >= AIR_MAX_LO) continue;
    // nur Lufträume ab Boden flächig, die übrigen als Umriss
    const ground = a.lo.ref === 'AGL' && a.lo.m === 0;
    L.polygon(a.poly, { pane: 'air', interactive: false, ...AIR_STYLE[a.kind], fillOpacity: ground ? AIR_STYLE[a.kind].fillOpacity : 0, weight: ground ? AIR_STYLE[a.kind].weight : 1.2 }).addTo(g);
  }
  AIR.layer = g.addTo(M.map);
}
/** Lufträume an einem Punkt als Liste für das Info-Blatt ('' = keine). */
function airHere(lat, lon) {
  if (!AIR.list || !window.AFCAir) return '';
  const g = T.grid, ground = g ? g.elev[Math.round((lat - g.la0) / g.dla) * g.nx + Math.round((lon - g.lo0) / g.dlo)] || 0 : 0;
  const here = window.AFCAir.airspaceAt(AIR.list, lat, lon, ground).filter(a => AIR_STYLE[a.kind] && airOn(a.kind));
  if (!here.length) return '';
  return `<h3 class="why-h">Luftraum hier</h3><ul class="air-list">${here.map(a => `<li style="--c:${AIR_STYLE[a.kind].color}"><b>${esc(a.name)}</b>${a.type || a.cls ? ` <span class="fine">(${esc(a.type || a.cls)})</span>` : ''}<br><span class="fine">${esc(a.lo.text)} bis ${esc(a.hi.text)} · ${AIR_RULE[a.kind]}${/\bHX\b/.test(a.name) ? ' · nur zeitweise aktiv (HX), Zeiten im DABS' : ''}${a.freq ? ' · ' + esc(a.freq) : ''}</span></li>`).join('')}</ul>`;
}
/** Raster der gesperrten Lufträume für den Routenplaner (gleiches Raster wie das Routenfeld). */
async function airRaster(F) {
  const list = await airData();
  if (!list || !window.AFCAir) return null;
  const key = `${F.nx}x${F.ny}:${AIR.at}`;
  if (AIR.rasterKey !== key) { AIR.raster = window.AFCAir.airspaceRaster(list, F); AIR.rasterKey = key; }
  return AIR.raster;
}

function initMap() {
  if (M.map) return true;
  if (typeof L === 'undefined') { mapMsg('Die Kartenbibliothek konnte nicht geladen werden. Prüfe die Verbindung und tippe auf «Aktualisieren».'); return false; }
  mapMsg('');
  M.map = L.map('map', { zoomControl: true, attributionControl: true }).setView([46.62, 7.85], 10);
  M.group = L.layerGroup().addTo(M.map);
  setBase(BASES[store.get('base')] ? store.get('base') : 'color');
  const ov = store.get('ov', {});
  for (const k of Object.keys(OVERLAYS)) if (ov[k]) setOverlay(k, true);
  syncLayerPanel();
  M.map.on('click', e => { if (RT.active) routeClick(e.latlng); else if (T.mode !== 'off' && T.data) mapSheet('thermal', e.latlng); else if (airHere(e.latlng.lat, e.latlng.lng)) mapSheet('air', e.latlng); else $('#mapSheet').hidden = true; });
  updateAir();
  return true;
}
function arrowIcon(dir, label) {
  return L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], html: `<div class="mk-s">${arrow(dir)}<span>${esc(label)}</span></div>` });
}
function renderMap() {
  syncWindBar();
  if (!initMap()) return;
  updateWind();
  updateThermal();
  setTimeout(() => M.map.invalidateSize(), 50);
  if (!S.plan) { mapMsg('Wetterdaten werden geladen …'); return; }
  if ($('#mapMsg').textContent.startsWith('Wetterdaten werden')) mapMsg('');
  M.group.clearLayers();
  const showOv = k => { const i = $(`#layerPanel input[value="${k}"]`); return i ? i.checked : true; };
  for (const s of S.plan.sites) {
    const b = s.days[S.day]?.best, c = s.blocked ? 'none' : cls(b?.score);
    const icon = L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], html: `<div class="mk s-${c}${s.blocked ? ' blocked' : ''}">${s.blocked ? '✕' : b ? b.score : '–'}</div>` });
    L.marker([s.lat, s.lon], { icon, title: `${s.name}: ${b ? b.score : 'keine Bewertung'}`, keyboard: true, zIndexOffset: b ? b.score : 0 }).on('click', () => (RT.active ? routeClick({ lat: s.lat, lng: s.lon }, s.alt) : mapSheet('site', s.id))).addTo(M.group);
  }
  if (showOv('landings')) for (const l of S.plan.landings || []) {
    L.marker([l.lat, l.lon], { icon: L.divIcon({ className: '', iconSize: [14, 14], iconAnchor: [7, 7], html: '<div class="mk-l"></div>' }), title: 'Landeplatz ' + l.name, keyboard: true }).on('click', () => (RT.active ? routeClick({ lat: l.lat, lng: l.lon }, l.alt) : mapSheet('landing', l.id))).addTo(M.group);
  }
  if (showOv('stations')) for (const st of S.plan.stations || []) {
    if (!num(st.wind)) continue;
    L.marker([st.lat, st.lon], { icon: arrowIcon(st.dir, Math.round(st.wind)), title: `${st.name}: ${Math.round(st.wind)} km/h aus ${dirLabel(st.dir)}`, keyboard: true }).on('click', () => (RT.active ? routeClick({ lat: st.lat, lng: st.lon }) : mapSheet('station', st.code))).addTo(M.group);
  }
}
/* ---- Windkarte: Partikel strömen mit dem Prognosewind (eigene Canvas-Ebene, ohne Zusatzbibliothek) */
const WIND_COLORS = [[10, '#2a7fd4'], [20, '#2fa84f'], [30, '#d9b300'], [40, '#ef8a1f'], [Infinity, '#d93a32']];
const windColor = kmh => WIND_COLORS.find(c => kmh < c[0])[1];
const W = { level: 'off', hour: 12, data: null, cache: new Map(), layer: null, req: 0 };

function windSample(d, lat, lon) {
  const g = d.grid, fx = (lon - g.lo0) / g.dlo, fy = (lat - g.la0) / g.dla;
  if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) return null;
  const x0 = Math.min(Math.floor(fx), g.nx - 2), y0 = Math.min(Math.floor(fy), g.ny - 2), tx = fx - x0, ty = fy - y0;
  const i = y0 * g.nx + x0, j = i + g.nx;
  const at = (arr) => {
    const a = arr[i], b = arr[i + 1], c = arr[j], e = arr[j + 1];
    if (a == null || b == null || c == null || e == null) return null;
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
  };
  const u = at(d.u), v = at(d.v);
  return u == null || v == null ? null : [u, v];
}

const WindLayer = typeof L === 'undefined' ? null : L.Layer.extend({
  onAdd(map) {
    this._map = map;
    if (!map.getPane('wind')) { const p = map.createPane('wind'); p.style.zIndex = 450; p.classList.add('leaflet-wind-pane'); }
    this._c = L.DomUtil.create('canvas', '', map.getPane('wind'));
    this._ctx = this._c.getContext('2d');
    this._still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    map.on('movestart zoomstart', this._stop, this);
    map.on('moveend zoomend resize', this._reset, this);
    this._reset();
  },
  onRemove(map) {
    this._stop();
    map.off('movestart zoomstart', this._stop, this);
    map.off('moveend zoomend resize', this._reset, this);
    this._c.remove();
  },
  setData(d) { this._d = d; this._reset(); },
  _stop() { cancelAnimationFrame(this._raf); this._raf = 0; if (this._ctx) this._ctx.clearRect(0, 0, this._c.width, this._c.height); },
  _reset() {
    this._stop();
    const map = this._map, size = map.getSize(), dpr = Math.min(2, window.devicePixelRatio || 1);
    L.DomUtil.setPosition(this._c, map.containerPointToLayerPoint([0, 0]));
    this._c.width = size.x * dpr; this._c.height = size.y * dpr;
    this._c.style.width = size.x + 'px'; this._c.style.height = size.y + 'px';
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._w = size.x; this._h = size.y;
    // Bildschirm -> Geo linear (bei dieser Kartengrösse genau genug)
    const nw = map.containerPointToLatLng([0, 0]), se = map.containerPointToLatLng([size.x, size.y]);
    this._geo = (x, y) => [nw.lat + (se.lat - nw.lat) * y / size.y, nw.lng + (se.lng - nw.lng) * x / size.x];
    if (!this._d) return;
    if (this._still) return this._drawArrows();
    const n = Math.round(Math.min(1800, size.x * size.y / 300));
    this._p = Array.from({ length: n }, () => this._spawn({}));
    this._last = 0;
    this._raf = requestAnimationFrame(t => this._frame(t));
  },
  _spawn(p) { p.x = Math.random() * this._w; p.y = Math.random() * this._h; p.age = Math.floor(Math.random() * 80); return p; },
  _frame(t) {
    this._raf = requestAnimationFrame(tt => this._frame(tt));
    if (t - this._last < 33 || document.hidden) return;   // ca. 30 Bilder pro Sekunde
    this._last = t;
    const ctx = this._ctx;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.9)';
    ctx.fillRect(0, 0, this._w, this._h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    const groups = new Map();
    for (const p of this._p) {
      const [lat, lon] = this._geo(p.x, p.y);
      const w = windSample(this._d, lat, lon);
      if (!w || p.age++ > 90) { this._spawn(p); p.age = 0; continue; }
      const k = 0.06;                                         // km/h -> Pixel je Bild, unabhängig vom Zoom
      const nx = p.x + w[0] * k, ny = p.y - w[1] * k;
      const col = windColor(Math.hypot(w[0], w[1]));
      if (!groups.has(col)) groups.set(col, []);
      groups.get(col).push(p.x, p.y, nx, ny);
      p.x = nx; p.y = ny;
      if (nx < 0 || ny < 0 || nx > this._w || ny > this._h) this._spawn(p);
    }
    for (const [col, seg] of groups) {
      ctx.strokeStyle = col; ctx.beginPath();
      for (let i = 0; i < seg.length; i += 4) { ctx.moveTo(seg[i], seg[i + 1]); ctx.lineTo(seg[i + 2], seg[i + 3]); }
      ctx.stroke();
    }
  },
  _drawArrows() {
    // Ruhige Darstellung bei «Bewegung reduzieren»: Pfeile im Raster
    const ctx = this._ctx, step = 46;
    ctx.lineWidth = 2;
    for (let y = step / 2; y < this._h; y += step) for (let x = step / 2; x < this._w; x += step) {
      const [lat, lon] = this._geo(x, y), w = windSample(this._d, lat, lon);
      if (!w) continue;
      const sp = Math.hypot(w[0], w[1]); if (sp < 1) continue;
      const len = Math.min(20, 6 + sp / 2), dx = w[0] / sp * len, dy = -w[1] / sp * len;
      ctx.strokeStyle = windColor(sp); ctx.beginPath();
      ctx.moveTo(x - dx / 2, y - dy / 2); ctx.lineTo(x + dx / 2, y + dy / 2);
      const a = Math.atan2(dy, dx);
      ctx.lineTo(x + dx / 2 - 6 * Math.cos(a - 0.5), y + dy / 2 - 6 * Math.sin(a - 0.5));
      ctx.moveTo(x + dx / 2, y + dy / 2);
      ctx.lineTo(x + dx / 2 - 6 * Math.cos(a + 0.5), y + dy / 2 - 6 * Math.sin(a + 0.5));
      ctx.stroke();
    }
  }
});

function windTimeIso() {
  const date = S.plan?.dates?.[S.day];
  if (!date) return new Date().toISOString();
  return new Date(`${date}T${String(W.hour).padStart(2, '0')}:00:00`).toISOString();
}
function syncWindBar() {
  $$('#windBar .wseg').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lvl === W.level)));
  $$('#windBar .tseg').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === T.mode)));
  const on = W.level !== 'off';
  $('#windBar .wind-time').hidden = !on && T.mode === 'off' && !RT.res; $('#windBar .wind-legend').hidden = !on;
  $('#windBar .thermal-legend').hidden = T.mode !== 'thermal'; $('#windBar .soar-legend').hidden = T.mode !== 'soar';
  $('#windHour').value = W.hour;
  $('#windHourT').textContent = `${W.hour} Uhr`;
  // Zusammengeklappt: nur Zusammenfassung und Uhrzeit, damit die Karte auf dem Handy frei bleibt
  const folded = store.get('barFold', innerWidth < 600);
  $('#windBar').classList.toggle('folded', folded);
  $('#windBar .bar-fold').setAttribute('aria-expanded', String(!folded));
  const parts = [W.level === 'off' ? null : 'Wind ' + ({ '10m': 'Boden', 800: '2000 m', 700: '3000 m' })[W.level], T.mode === 'thermal' ? 'Thermik' : T.mode === 'soar' ? 'Soaring' : null].filter(Boolean);
  $('#barSum').textContent = parts.length ? parts.join(' · ') : 'Wind und Aufwind: aus';
}
async function updateWind() {
  syncWindBar();
  if (!M.map || !WindLayer) return;
  if (W.level === 'off') { if (W.layer) { M.map.removeLayer(W.layer); W.layer = null; } return; }
  const key = `${W.level}|${windTimeIso()}`, req = ++W.req;
  let d = W.cache.get(key);
  if (!d) {
    try {
      const r = await fetch(`/api/wind?level=${W.level}&t=${encodeURIComponent(windTimeIso())}`);
      if (r.status === 202) { mapMsg('Windkarte wird noch geladen, bitte in einer Minute nochmals versuchen.'); setTimeout(() => mapMsg(''), 6000); return; }
      if (!r.ok) throw new Error(r.status === 404 ? 'keine Daten für diese Zeit' : 'Fehler ' + r.status);
      d = await r.json();
      W.cache.set(key, d);
      if (W.cache.size > 60) W.cache.delete(W.cache.keys().next().value);
    } catch (err) { if (req === W.req) { mapMsg('Windkarte: ' + err.message); setTimeout(() => mapMsg(''), 6000); } return; }
  }
  if (req !== W.req || W.level === 'off') return;
  if (!W.layer) W.layer = new WindLayer().addTo(M.map);
  W.layer.setData(d);
}

/* ---- Thermik-Wärmekarte: Schätzung aus Sonne auf dem Hang, Thermikhöhe, Geländeform und Wolken.
   Soaring-Ansicht: wo der Wind frontal auf einen steilen Hang trifft (Hangaufwind, auch ohne Thermik).
   Das Geländeraster (ca. 250 m) kommt einmal vom Server, die Wetterwerte je Stunde aus /api/thermal. */
const T = { mode: 'off', grid: null, gridReq: null, cache: new Map(), layer: null, data: null, req: 0 };
const D2R = Math.PI / 180;

async function thermalGrid() {
  if (T.grid) return T.grid;
  T.gridReq ??= (async () => {
    const r = await fetch('/terrain-grid.bin');
    if (!r.ok) throw new Error('Geländeraster fehlt (' + r.status + ')');
    const buf = await r.arrayBuffer(), dv = new DataView(buf), hl = dv.getUint32(0, true);
    const g = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
    const o = 4 + hl + ((4 + hl) % 2), N = g.ny * g.nx;
    const copy = (Ctor, off, n) => new Ctor(buf.slice(off, off + n * Ctor.BYTES_PER_ELEMENT));
    // Optional: Thermik aus Flügen (kk7), auf diesem Mac mit tools/calibrate-kk7.js erzeugt
    let kk7 = null;
    try {
      const rk = await fetch('/kk7-grid.bin');
      if (rk.ok) {
        const kb = await rk.arrayBuffer(), kl = new DataView(kb).getUint32(0, true), km = JSON.parse(new TextDecoder().decode(new Uint8Array(kb, 4, kl)));
        if (km.nx === g.nx && km.ny === g.ny) kk7 = new Uint8Array(kb, 4 + kl, N);
      }
    } catch {}
    T.grid = { ...g, kk7, elev: copy(Uint16Array, o, N), slope: new Uint8Array(buf, o + 2 * N, N), aspect: new Uint8Array(buf, o + 3 * N, N), form: new Int8Array(buf, o + 4 * N, N) };
    return T.grid;
  })().catch(e => { T.gridReq = null; throw e; });
  return T.gridReq;
}

/** Wetterwert am Ort (bilinear, fehlende Rasterpunkte werden übersprungen). */
function fieldAt(d, arr, lat, lon) {
  const g = d.grid, fx = Math.min(Math.max((lon - g.lo0) / g.dlo, 0), g.nx - 1), fy = Math.min(Math.max((lat - g.la0) / g.dla, 0), g.ny - 1);
  const x0 = Math.min(Math.floor(fx), g.nx - 2), y0 = Math.min(Math.floor(fy), g.ny - 2), tx = fx - x0, ty = fy - y0;
  let s = 0, w = 0;
  for (const [i, k] of [[y0 * g.nx + x0, (1 - tx) * (1 - ty)], [y0 * g.nx + x0 + 1, tx * (1 - ty)], [(y0 + 1) * g.nx + x0, (1 - tx) * ty], [(y0 + 1) * g.nx + x0 + 1, tx * ty]]) {
    if (arr[i] != null) { s += arr[i] * k; w += k; }
  }
  return w > 0 ? s / w : null;
}

/** Sonnenenergie auf dem Hang im Verhältnis zur Ebene (direkter Anteil nach Einfallswinkel, diffuser Anteil gleichmässig). */
function slopeSun(sw, pos, slopeDeg, aspectDeg) {
  if (!(sw > 0) || !(pos.elev > 0)) return 0;
  const s = slopeDeg * D2R, e = pos.elev * D2R;
  const cosi = Math.cos(s) * Math.sin(e) + Math.sin(s) * Math.cos(e) * Math.cos((pos.az - aspectDeg) * D2R);
  return sw * (0.28 + 0.72 * Math.min(3, Math.max(0, cosi) / Math.max(Math.sin(e), 0.15)));
}

/** Thermikwert 0–1 einer Rasterzelle mit Begründung. */
function thermalCell(d, g, k, lat, lon) {
  const elev = g.elev[k], slope = g.slope[k], aspect = g.aspect[k] * 360 / 256, form = g.form[k] * 2;
  const top = fieldAt(d, d.top, lat, lon), wstar = fieldAt(d, d.wstar, lat, lon) ?? 0;
  const low = fieldAt(d, d.low, lat, lon) ?? 0, rain = fieldAt(d, d.rain, lat, lon) ?? 0;
  // Der Boden braucht Zeit zum Aufheizen: diese und die vorherige Stunde zählen
  const heatNow = slopeSun(fieldAt(d, d.sun, lat, lon), d.sunPos, slope, aspect);
  const heatBefore = slopeSun(fieldAt(d, d.sunBefore, lat, lon), d.sunPrev, slope, aspect);
  const heat = Math.min(1.2, (0.6 * heatNow + 0.4 * heatBefore) / 750);
  const reach = top == null ? 0 : top - elev;
  const fReach = Math.min(1, Math.max(0, (reach - 100) / 900));
  // Gewichtung abgeglichen mit kk7 (rund 3,8 Mio. Flüge, tools/calibrate-kk7.js, 30.10.2026):
  // Geländeform und Steilheit zählen weniger als angenommen, auch flaches Gelände liefert Thermik
  const fForm = Math.min(1.3, Math.max(0.25, 0.62 + form / 230));      // Kreten und Kuppen lösen etwas besser aus
  const fSlope = slope < 2 ? 0.6 : 0.84 + 0.16 * Math.min(1, slope / 40);
  // Wo Piloten tatsächlich Thermik gefunden haben (kk7), falls auf diesem Mac abgeglichen; sonst neutral
  const flights = g.kk7 ? g.kk7[k] / 255 : null;
  const fFlights = flights == null ? 1 : 0.4 + 0.9 * flights;
  const fStrength = Math.min(1.2, Math.max(0.2, wstar / 2));
  const fCloud = (1 - 0.7 * Math.min(100, low) / 100) * (rain >= 0.3 ? 0 : rain >= 0.1 ? 0.5 : 1);
  const v = Math.min(1, (heat * fReach * fForm * fSlope * fStrength * fCloud * fFlights) ** 1.4);   // nur die besten Stellen leuchten
  return { v, elev, slope, aspect, form, top, reach, wstar, low, rain, flights, heat: Math.round(0.6 * heatNow + 0.4 * heatBefore) };
}

const THERMAL_RAMP = [[0.2, [255, 230, 90, 0]], [0.3, [255, 210, 60, 110]], [0.5, [255, 140, 30, 170]], [0.7, [235, 60, 30, 200]], [1, [180, 0, 60, 220]]];
const SOAR_RAMP = [[0.2, [80, 200, 220, 0]], [0.35, [80, 200, 220, 110]], [0.6, [30, 150, 230, 170]], [1, [20, 70, 200, 215]]];
const SOAR_STRONG = [200, 40, 200, 190];
function rampRgba(ramp, v) {
  if (v <= ramp[0][0]) return null;
  for (let i = 1; i < ramp.length; i++) {
    const [b, cb] = ramp[i], [a, ca] = ramp[i - 1];
    if (v <= b) { const t = (v - a) / (b - a); return ca.map((c, j) => Math.round(c + (cb[j] - c) * t)); }
  }
  return ramp[ramp.length - 1][1];
}

/** Wind auf Geländehöhe: Bodenwind in tiefen Lagen, darüber zwischen 2000 m und 3000 m interpoliert. */
function windAtAlt(d, lat, lon, elev) {
  const at = k => { const w = d.wind?.[k]; if (!w) return null; const u = fieldAt(d, w.u, lat, lon), v = fieldAt(d, w.v, lat, lon); return u == null || v == null ? null : [u, v]; };
  const mix = (a, b, t) => (!a ? b : !b ? a : [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  if (elev <= 1200) return at('10m');
  if (elev <= 1950) return mix(at('10m'), at('800'), (elev - 1200) / 750);
  return mix(at('800'), at('700'), Math.min(1, (elev - 1950) / 1060));
}

/** Soaringwert 0–1 einer Rasterzelle: Wind frontal auf steilen Hang, Kreten verstärken. */
function soarCell(d, g, k, lat, lon) {
  const elev = g.elev[k], slope = g.slope[k], aspect = g.aspect[k] * 360 / 256, form = g.form[k] * 2;
  const w = windAtAlt(d, lat, lon, elev);
  if (!w) return { v: 0, elev, slope, aspect, form, speed: null };
  const speed = Math.hypot(w[0], w[1]);
  // Anteil, der frontal auf den Hang strömt (der Hang schaut nach «aspect», der Wind muss von dort kommen)
  const into = -(w[0] * Math.sin(aspect * D2R) + w[1] * Math.cos(aspect * D2R));
  const from = (Math.atan2(-w[0], -w[1]) / D2R + 360) % 360;
  const fWind = into < 8 ? 0 : into < 15 ? (into - 8) / 7 : into <= 28 ? 1 : Math.max(0.6, 1 - (into - 28) / 17);
  const fSlope = Math.min(1, Math.max(0, (slope - 10) / 15));
  const fForm = Math.min(1.3, Math.max(0.3, 0.6 + form / 100));
  const strong = speed > 35 && into > 20 && slope >= 10;
  return { v: Math.min(1, fWind * fSlope * fForm), strong, elev, slope, aspect, form, speed, into, from };
}

function thermalImage(d, g, mode) {
  const c = document.createElement('canvas'); c.width = g.nx; c.height = g.ny;
  const ctx = c.getContext('2d'), img = ctx.createImageData(g.nx, g.ny);
  for (let y = 0; y < g.ny; y++) {
    const lat = g.la0 + y * g.dla, row = (g.ny - 1 - y) * g.nx;      // Bild beginnt im Norden
    for (let x = 0; x < g.nx; x++) {
      let col;
      if (mode === 'soar') { const c = soarCell(d, g, y * g.nx + x, lat, g.lo0 + x * g.dlo); col = c.strong ? SOAR_STRONG : rampRgba(SOAR_RAMP, c.v); }
      else col = rampRgba(THERMAL_RAMP, thermalCell(d, g, y * g.nx + x, lat, g.lo0 + x * g.dlo).v);
      if (col) img.data.set(col, (row + x) * 4);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL();
}

/** Kurze Begründung beim Antippen der Karte. */
function thermalWhy(lat, lon) {
  const g = T.grid, d = T.data;
  if (!g || !d) return null;
  const x = Math.round((lon - g.lo0) / g.dlo), y = Math.round((lat - g.la0) / g.dla);
  if (x < 0 || y < 0 || x >= g.nx || y >= g.ny) return null;
  if (T.mode === 'soar') return soarWhy(soarCell(d, g, y * g.nx + x, lat, lon));
  const c = thermalCell(d, g, y * g.nx + x, lat, lon);
  const level = c.v >= 0.6 ? 'stark' : c.v >= 0.35 ? 'mittel' : c.v > 0.2 ? 'schwach' : 'kaum';
  const why = [];
  why.push(c.slope >= 8 ? `${dirLabel(c.aspect)}-Hang, ${c.slope}° steil, ${c.heat} W/m² Sonne auf dem Hang` : `flaches Gelände, ${c.heat} W/m² Sonne`);
  if (c.top == null) why.push('keine Daten zur Thermikhöhe');
  else if (c.reach <= 100) why.push(`Thermik endet bei ca. ${Math.round(c.top / 100) * 100} m, also unter diesem Gelände`);
  else why.push(`Thermik bis ca. ${Math.round(c.top / 100) * 100} m (${Math.round(c.reach / 100) * 100} m über Gelände), Steigen um ${c.wstar.toFixed(1)} m/s`);
  if (c.form >= 25) why.push('Krete oder Kuppe: hier lösen Thermikblasen ab');
  else if (c.form <= -25) why.push('Mulde oder Tal: Thermik löst eher weiter oben ab');
  if (c.flights != null && c.flights !== 0.5) {
    if (c.flights >= 0.9) why.push('Bekannter Thermikspot: hier fanden Piloten besonders oft Thermik (kk7, 3,8 Mio. Flüge)');
    else if (c.flights >= 0.7) why.push('In Flügen häufig Thermik an dieser Stelle (kk7)');
    else if (c.flights <= 0.15) why.push('In Flügen selten Thermik an dieser Stelle (kk7)');
  }
  if (c.rain >= 0.1) why.push('Regen dämpft die Thermik');
  else if (c.low >= 40) why.push(`tiefe Wolken (${Math.round(c.low)} %) beschatten den Hang`);
  return { title: 'Thermik ' + level, elev: c.elev, why };
}
function soarWhy(c) {
  const why = [];
  if (c.speed == null) return { title: 'Soaring', elev: c.elev, why: ['keine Winddaten'] };
  const level = c.strong ? 'zu starker Wind' : c.v >= 0.6 ? 'gut' : c.v >= 0.35 ? 'möglich' : c.v > 0.2 ? 'schwach' : 'kaum';
  why.push(`Wind ${Math.round(c.speed)} km/h aus ${dirLabel(c.from)} auf ca. ${Math.round(c.elev / 100) * 100} m`);
  why.push(c.slope >= 8 ? `${dirLabel(c.aspect)}-Hang, ${c.slope}° steil` : 'flaches Gelände: kein Hangaufwind');
  if (c.slope >= 8) {
    if (c.into < 8) why.push(c.into < -5 ? 'Wind kommt von hinten über den Hang: Lee, Turbulenz' : 'Wind streicht seitlich oder zu schwach auf den Hang');
    else why.push(`${Math.round(c.into)} km/h strömen frontal auf den Hang${c.into > 28 ? ': kräftig' : ''}`);
  }
  if (c.form >= 25 && c.into >= 8) why.push('Krete: der Aufwind ist hier am stärksten');
  if (c.strong) why.push('Über 35 km/h: für Gleitschirme zu stark');
  return { title: 'Soaring ' + level, elev: c.elev, why };
}

/** Thermik- und Winddaten einer Stunde (zwischengespeichert); null, solange der Server noch lädt. */
async function thermalData(iso) {
  let d = T.cache.get(iso);
  if (d) return d;
  const r = await fetch(`/api/thermal?t=${encodeURIComponent(iso)}`);
  if (r.status === 202) return null;
  if (!r.ok) throw new Error(r.status === 404 ? 'keine Daten für diese Zeit' : 'Fehler ' + r.status);
  d = await r.json();
  d.url = {};
  T.cache.set(iso, d);
  if (T.cache.size > 30) T.cache.delete(T.cache.keys().next().value);
  return d;
}

/* ---- XC-Routenplaner (lib/route.js): A und B auf der Karte antippen */
const RT = { active: false, a: null, b: null, mode: 'safe', layer: null, res: null, req: 0, fields: new Map() };
const LAND_RESERVE = 300;   // Reserve über dem Landeplatz
// vorsichtige Gleitzahl und Trimmgeschwindigkeit je Schirmklasse (eher tiefer als Herstellerangaben, mit Kurbeln und Sinken)
const GLIDER_PERF = { A: { glide: 6.5, airspeed: 34 }, B: { glide: 7, airspeed: 36 }, C: { glide: 7.5, airspeed: 38 }, D: { glide: 8, airspeed: 40 } };
function gliderPerf() { const k = store.get('pilot')?.glider; return { key: GLIDER_PERF[k] ? k : 'B', ...(GLIDER_PERF[k] || GLIDER_PERF.B) }; }

/** Raster ca. 500 m für die Routensuche aus Gelände- und Wetterdaten. */
function routeField(g, d, glide) {
  const B = 2, nx = Math.floor(g.nx / B), ny = Math.floor(g.ny / B), N = nx * ny;
  const F = { la0: g.la0 + (B - 1) * g.dla / 2, lo0: g.lo0 + (B - 1) * g.dlo / 2, dla: g.dla * B, dlo: g.dlo * B, nx, ny,
    q: new Float32Array(N), top: new Float32Array(N), ground: new Float32Array(N), u: new Float32Array(N), v: new Float32Array(N), wstar: new Float32Array(N), needH: new Float32Array(N) };
  const lands = (S.plan?.landings || []).filter(l => num(l.lat) && num(l.alt));
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const k = y * nx + x, lat = F.la0 + y * F.dla, lon = F.lo0 + x * F.dlo;
    let qs = [], gmax = 0, gsum = 0;
    for (let yy = 0; yy < B; yy++) for (let xx = 0; xx < B; xx++) {
      const gy = y * B + yy, gx = x * B + xx, gk = gy * g.nx + gx;
      gmax = Math.max(gmax, g.elev[gk]); gsum += g.elev[gk];
      qs.push(thermalCell(d, g, gk, g.la0 + gy * g.dla, g.lo0 + gx * g.dlo).v);
    }
    qs.sort((a, b) => b - a);
    F.q[k] = (qs[0] + qs[1]) / 2;                                // die besten Stellen der Zelle zählen
    F.ground[k] = (gmax + gsum / (B * B)) / 2;                  // zwischen höchstem und mittlerem Gelände der Zelle
    F.top[k] = fieldAt(d, d.top, lat, lon) ?? NaN;
    F.wstar[k] = fieldAt(d, d.wstar, lat, lon) ?? 0;
    const w = windAtAlt(d, lat, lon, Math.max(gmax, (F.top[k] || 2500) - 500));   // Wind auf Flughöhe
    F.u[k] = w ? w[0] : 0; F.v[k] = w ? w[1] : 0;
    // Mindesthöhe, um den nächsten Landeplatz mit Reserve zu erreichen
    F.needH[k] = lands.reduce((m, l) => Math.min(m, l.alt + LAND_RESERVE + haversineKm(lat, lon, l.lat, l.lon) * 1000 / glide), Infinity);
  }
  return F;
}
function haversineKm(a, b, c, e) {
  const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((e - b) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}
function nearName(p) {
  let best = null, bd = 2.5;
  for (const s of [...(S.plan?.sites || []), ...(S.plan?.landings || [])]) { const dd = haversineKm(p[0], p[1], s.lat, s.lon); if (dd < bd) { bd = dd; best = s.name; } }
  return best;
}
function routeStart() {
  RT.active = true; RT.a = RT.b = RT.res = null; clearRoute();
  $('#mapSheet').hidden = true;
  mapMsg('Route: tippe auf den Startpunkt A');
}
function clearRoute() { if (RT.layer) { M.map.removeLayer(RT.layer); RT.layer = null; } }
function routeClick(ll, alt) {
  if (!RT.a) { RT.a = [ll.lat, ll.lng]; RT.alt = num(alt) ? alt : null; drawRoute(); mapMsg('Route: tippe auf das Ziel B'); return; }
  RT.b = [ll.lat, ll.lng]; RT.active = false; mapMsg(''); computeRoute();
}
async function computeRoute() {
  if (!RT.a || !RT.b) return;
  const req = ++RT.req, iso = windTimeIso();
  mapMsg('Route wird berechnet …');
  try {
    const g = await thermalGrid(), d = await thermalData(iso);
    if (!d) throw new Error('Wetterdaten werden noch geladen, bitte in ein paar Minuten nochmals versuchen');
    const perf = gliderPerf();
    const field = (key, dd) => {
      let F = RT.fields.get(key);
      if (!F) { F = routeField(g, dd, perf.glide); RT.fields.set(key, F); if (RT.fields.size > 12) RT.fields.delete(RT.fields.keys().next().value); }
      return F;
    };
    const F = field(iso + perf.key, d);
    // folgende Stunden (bis 20 Uhr), damit sich das Wetter während des Flugs mitverändert
    const date = S.plan?.dates?.[S.day], later = [];
    for (let h = W.hour + 1; date && h <= Math.min(20, W.hour + 4); h++) {
      const iso2 = new Date(`${date}T${String(h).padStart(2, '0')}:00:00`).toISOString();
      const d2 = await thermalData(iso2).catch(() => null);
      if (!d2) break;
      later.push(field(iso2 + perf.key, d2));
    }
    if (req !== RT.req) return;
    // Starthöhe: Startplatz oder Gelände am Punkt A
    const ga = Math.round((RT.a[0] - g.la0) / g.dla) * g.nx + Math.round((RT.a[1] - g.lo0) / g.dlo);
    const air = await airRaster(F);
    if (req !== RT.req) return;
    const res = window.AFCRoute.planRoute(F, RT.a, RT.b, { mode: RT.mode, startAlt: RT.alt ?? g.elev[ga] ?? null, glide: perf.glide, airspeed: perf.airspeed, later, air });
    res.perf = perf; res.laterHours = later.length; res.airOk = !!air;
    if (req !== RT.req) return;
    RT.res = res; mapMsg(''); drawRoute(); mapSheet('route'); syncWindBar();
    if (res.ok) M.map.fitBounds(L.latLngBounds(res.path), { paddingTopLeft: [40, 40], paddingBottomRight: [40, Math.min(360, $('#mapSheet').offsetHeight + 40)] });
  } catch (err) { if (req === RT.req) { mapMsg('Route: ' + err.message); setTimeout(() => mapMsg(''), 7000); } }
}
const ISSUE_COL = { weak: '#d97706', low: '#dc2626', head: '#7c3aed', land: '#b45309', air: '#c2185b' };
function drawRoute() {
  clearRoute();
  const grp = L.layerGroup();
  const pin = (p, t) => L.marker(p, { icon: L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14], html: `<div class="rt-pin">${t}</div>` }), keyboard: false }).addTo(grp);
  if (RT.res?.ok) {
    L.polyline(RT.res.path, { color: '#ffffff', weight: 8, opacity: 0.8 }).addTo(grp);
    L.polyline(RT.res.path, { color: '#0b6e99', weight: 4 }).addTo(grp);
    RT.res.issues.forEach((it, i) => L.marker(it.at, { icon: L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11], html: `<div class="rt-issue" style="--c:${ISSUE_COL[it.kind]}">${i + 1}</div>` }), title: it.text }).addTo(grp));
  }
  if (RT.a) pin(RT.a, 'A');
  if (RT.b) pin(RT.b, 'B');
  RT.layer = grp.addTo(M.map);
}
function routeSheetHtml() {
  const r = RT.res;
  const seg = `<div><div class="seg" role="group" aria-label="Routenart">${Object.entries(window.AFCRoute.ROUTE_MODES).map(([k, m]) => `<button type="button" data-act="rtmode" data-v="${k}" aria-pressed="${RT.mode === k}">${m.label}</button>`).join('')}</div></div>`;
  const from = nearName(RT.a), to = nearName(RT.b);
  const head = `<div class="sheet-top"><div><h3>Route ${esc(from || 'A')} → ${esc(to || 'B')}</h3><p class="fine" style="margin:0">${dayName(S.day)}, ${W.hour} Uhr · Uhrzeit mit dem Regler unten ändern</p></div></div>`;
  if (!r?.ok) return `${head}<p>${esc(r?.reason || 'Keine Route gefunden')}</p>${seg}`;
  const t = r.hours >= 1 ? `${Math.floor(r.hours)} h ${Math.round((r.hours % 1) * 60)} min` : `${Math.round(r.hours * 60)} min`;
  return `${head}
    <div class="kv"><div><b>${r.distKm} km</b><span>Strecke</span></div><div><b>${t}</b><span>Flugzeit (Schätzung)</span></div><div><b>${r.climbs ? r.climbs + '×' : 'Gleitflug'}</b><span>${r.climbs ? 'Thermik nötig' : 'ohne Thermik möglich'}</span></div><div><b>${r.arriveAgl} m</b><span>Ankunft über Grund</span></div></div>
    ${seg}
    ${r.issues.length ? `<h3 class="why-h">Kritische Stellen</h3><ol class="rt-issues">${r.issues.map(i => `<li style="--c:${ISSUE_COL[i.kind]}">${esc(i.text)}</li>`).join('')}</ol>` : '<p>Keine kritischen Stellen gefunden: Thermik, Arbeitshöhe, Wind und Landeplätze passen auf der ganzen Strecke.</p>'}
    <p class="fine">${RT.mode === 'safe' ? 'Sicher: bleibt bei Thermik, genug Abstand zum Gelände und Landeplätzen im Gleitbereich (300 m Reserve).' : 'Schnell: kürzeste Flugzeit, nimmt schwächere Abschnitte in Kauf.'} Gerechnet mit ${esc(window.AFCPilot?.GLIDERS?.[r.perf.key] || 'EN-B')} (Gleitzahl ${r.perf.glide}, ${r.perf.airspeed} km/h)${store.get('pilot')?.glider ? '' : ', Schirm im Profil ändern'}. ${r.laterHours ? `Wetter ab Start bis ${W.hour + r.laterHours} Uhr berücksichtigt.` : 'Schätzung für eine Uhrzeit.'} ${r.airOk ? 'Lufträume (SHV) sind berücksichtigt: Aktivzeiten und NOTAM im DABS selbst prüfen.' : '<b>Lufträume konnten nicht geladen werden</b>, vor dem Flug selbst prüfen.'}</p>`;
}

async function updateThermal() {
  syncWindBar();
  if (!M.map) return;
  if (T.mode === 'off') { if (T.layer) { M.map.removeLayer(T.layer); T.layer = null; } T.data = null; return; }
  const iso = windTimeIso(), req = ++T.req, mode = T.mode;
  try {
    const g = await thermalGrid();
    const d = await thermalData(iso);
    if (!d) { mapMsg('Thermikkarte wird noch geladen, bitte in ein paar Minuten nochmals versuchen.'); setTimeout(() => mapMsg(''), 6000); return; }
    d.url[mode] ??= thermalImage(d, g, mode);
    if (req !== T.req || T.mode !== mode) return;
    T.data = d;
    if (!M.map.getPane('thermal')) M.map.createPane('thermal').style.zIndex = 420;
    const b = [[g.la0 - g.dla / 2, g.lo0 - g.dlo / 2], [g.la0 + (g.ny - 0.5) * g.dla, g.lo0 + (g.nx - 0.5) * g.dlo]];
    if (T.layer) T.layer.setUrl(d.url[mode]);
    else T.layer = L.imageOverlay(d.url[mode], b, { pane: 'thermal', opacity: 0.75, className: 'thermal-img', interactive: false }).addTo(M.map);
  } catch (err) { if (req === T.req) { mapMsg('Thermikkarte: ' + err.message); setTimeout(() => mapMsg(''), 6000); } }
}

function mapSheet(kind, id) {
  const el = $('#mapSheet');
  let h = '';
  if (kind === 'site') {
    const s = siteById(id), b = s.days[S.day]?.best;
    h = `<div class="sheet-top"><div><h3>${esc(s.name)}</h3><p class="fine" style="margin:0">${s.alt} m · ${esc(aspectText(s))} · ${b ? winText(b) : 'kein Fenster'}</p></div>${pill(s.blocked ? null : b?.score)}</div><div class="sheet-act"><button class="btn" type="button" data-act="site" data-id="${esc(id)}">Details</button>${starBtn(id)}<button class="btn sec" type="button" data-act="closesheet">Schliessen</button></div>`;
  } else if (kind === 'landing') {
    const l = S.plan.landings.find(x => x.id === id);
    h = `<div class="sheet-top"><div><h3>Landeplatz ${esc(l.name)}</h3><p class="fine" style="margin:0">${l.alt ?? '–'} m${l.status ? ' · ' + esc(l.status) : ''}</p></div></div><div class="sheet-act"><button class="btn sec" type="button" data-act="closesheet">Schliessen</button></div>`;
  } else if (kind === 'route') {
    h = routeSheetHtml() + `<div class="sheet-act"><button class="btn sec" type="button" data-act="route">Neue Route</button><button class="btn sec" type="button" data-act="routeoff">Schliessen</button></div>`;
  } else if (kind === 'air') {
    h = `<div class="sheet-top"><div><h3>Luftraum</h3><p class="fine" style="margin:0">Quelle SHV/FSVL${AIR.at ? ', geladen ' + new Date(AIR.at).toLocaleDateString('de-CH') : ''}</p></div></div>${airHere(id.lat, id.lng)}<p class="fine">Aktivzeiten (z.B. Militär) und NOTAM vor dem Flug im DABS prüfen.</p><div class="sheet-act"><button class="btn sec" type="button" data-act="closesheet">Schliessen</button></div>`;
  } else if (kind === 'thermal') {
    const t = thermalWhy(id.lat, id.lng);
    if (!t) { el.hidden = true; return; }
    h = `<div class="sheet-top"><div><h3>${esc(t.title)}</h3><p class="fine" style="margin:0">${t.elev} m · ${W.hour} Uhr · Schätzung</p></div></div><ul class="why-list">${t.why.map(x => `<li>${esc(x)}</li>`).join('')}</ul>${airHere(id.lat, id.lng)}<div class="sheet-act"><button class="btn sec" type="button" data-act="closesheet">Schliessen</button></div>`;
  } else {
    const st = S.plan.stations.find(x => x.code === id);
    h = `<div class="sheet-top"><div><h3>${esc(st.name)}</h3><p class="fine" style="margin:0">${st.alt ?? '–'} m · vor ${st.age} min</p></div></div><div class="kv"><div><b>${Math.round(st.wind)} ${arrow(st.dir)}</b><span>Wind km/h aus ${dirLabel(st.dir)}</span></div><div><b>${num(st.gust) ? Math.round(st.gust) : '–'}</b><span>Böen km/h</span></div><div><b>${num(st.temp) ? st.temp.toFixed(1) + '°' : '–'}</b><span>Temperatur</span></div></div><div class="sheet-act"><button class="btn sec" type="button" data-act="closesheet">Schliessen</button></div>`;
  }
  el.innerHTML = h; el.hidden = false;
}
function locate() {
  if (!navigator.geolocation) return toast('Standort wird von diesem Gerät nicht unterstützt');
  navigator.geolocation.getCurrentPosition(pos => {
    if (!initMap()) return;
    const ll = [pos.coords.latitude, pos.coords.longitude];
    if (M.me) M.group.removeLayer(M.me);
    M.me = L.marker(ll, { icon: L.divIcon({ className: '', iconSize: [16, 16], iconAnchor: [8, 8], html: '<div class="mk-me"></div>' }), title: 'Mein Standort' }).addTo(M.map);
    M.map.setView(ll, 12);
  }, err => toast(err.code === 1 ? 'Standortfreigabe verweigert' : 'Standort nicht verfügbar'), { enableHighAccuracy: true, timeout: 10000 });
}

/* ---------------------------------------------------------------- Aktionen */
function setTab(t) {
  S.tab = t; store.set('tab', t);
  render();
  if (t === 'map') setTimeout(() => M.map?.invalidateSize(), 120);
  if (t === 'profile') loadStatus();
  window.scrollTo({ top: 0 });
}
document.addEventListener('click', async e => {
  const dlgEl = e.target.closest('dialog');
  if (e.target.tagName === 'DIALOG') { closeDlg(e.target); return; }
  const tab = e.target.closest('.tabs [data-tab]');
  if (tab) return setTab(tab.dataset.tab);
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act, id = b.dataset.id;
  switch (a) {
    case 'day': S.day = Number(b.dataset.i); render(); break;
    case 'reload': loadPlan(true); break;
    case 'sources': setTab('profile'); setTimeout(() => $$('#v-profile .panel h3').find(h => h.textContent === 'Datenquellen')?.scrollIntoView({ behavior: 'smooth' }), 80); break;
    case 'toggle': S.open.has(id) ? S.open.delete(id) : S.open.add(id); store.set('open', [...S.open]); renderDecide(); break;
    case 'site': $('#mapSheet').hidden = true; openSite(id); break;
    case 'closesite': closeDlg($('#siteDlg')); break;
    case 'closemsg': closeDlg($('#msgDlg')); break;
    case 'closesheet': $('#mapSheet').hidden = true; break;
    case 'fav': {
      S.fav.has(id) ? S.fav.delete(id) : S.fav.add(id); store.set('fav', [...S.fav]);
      b.setAttribute('aria-pressed', String(S.fav.has(id)));
      if (!dlgEl) { if (S.tab === 'decide') renderDecide(); else if (S.tab === 'profile') renderProfile(); }
      else if (S.detailData) renderSite();
      break;
    }
    case 'hour': S.hour = Number(b.dataset.h); if (S.detailData) renderSite(); break;
    case 'level': if (S.level !== b.dataset.v) { S.level = b.dataset.v; store.set('level', S.level); store.set('levelManual', true); S.detail.clear(); render(); loadPlan(); } break;
    case 'theme': S.theme = b.dataset.v; store.set('theme', S.theme); render(); break;
    case 'check': {
      const key = 'check.' + todayKey(), cur = new Set(store.get(key, [])), i = Number(b.dataset.i);
      b.checked ? cur.add(i) : cur.delete(i); store.set(key, [...cur]); break;
    }
    case 'report': closeDlg($('#siteDlg')); reportForm(id); break;
    case 'showmap': closeDlg($('#siteDlg')); setTab('map'); setTimeout(() => { const s = siteById(id); if (M.map && s) { M.map.setView([s.lat, s.lon], 14); mapSheet('site', id); } }, 200); break;
    case 'layers': { const p = $('#layerPanel'); p.hidden = !p.hidden; b.setAttribute('aria-expanded', String(!p.hidden)); break; }
    case 'locate': locate(); break;
    case 'wind': W.level = b.dataset.lvl; store.set('wind', W.level); updateWind(); break;
    case 'tab': setTab(b.dataset.tab); break;
    case 'barfold': store.set('barFold', !$('#windBar').classList.contains('folded')); syncWindBar(); break;
    case 'route': routeStart(); break;
    case 'intro': showIntro(); break;
    case 'lbflight': lbLoad().then(() => flightForm(id)).catch(err => toast(err.message)); break;
    case 'lbgear': lbLoad().then(() => gearForm(id)).catch(err => toast(err.message)); break;
    case 'lbyear': LB.year = b.dataset.v; renderBook(); break;
    case 'lbdelflight': case 'lbdelgear': {
      const fid = b.closest('form')?.dataset.id, kind = a === 'lbdelflight' ? 'flight' : 'gear';
      if (!fid || !(await ask({ title: kind === 'flight' ? 'Flug löschen?' : 'Ausrüstung löschen?', text: kind === 'flight' ? 'Der Flug wird aus dem Flugbuch entfernt.' : 'Flüge mit diesem Teil bleiben erhalten. Tipp: «Ausgemustert» behält die Stunden.', ok: 'Löschen', danger: true }))) break;
      try { await lbDelete(kind, fid); toast('Gelöscht'); renderBook(); } catch (err) { toast('Nicht gelöscht: ' + err.message); }
      break;
    }
    case 'airtoggle': { const on = !(airOn('air') || airOn('wild')); store.set('ov', { ...store.get('ov', {}), air: on, wild: on }); syncLayerPanel(); updateAir(); if (on) { mapMsg('Lufträume: rot gesperrt, orange Gefahrengebiet, grün Wildschutz. Antippen für Details.'); setTimeout(() => mapMsg(''), 5000); } else $('#mapSheet').hidden = true; break; }
    case 'update': applyUpdate(); break;
    case 'updskip': store.set('updSkip', ST.data?.update?.latest?.date); renderUpdBanner(); break;
    case 'updcheck': {
      b.disabled = true; b.textContent = 'Suche …';
      try { const r = await fetch('/api/update/check', { method: 'POST', headers: { 'X-AFC-Client': clientId } }); const j = await r.json(); if (ST.data && j.update) ST.data.update = j.update; } catch {}
      store.del('updSkip'); renderUpdBanner(); const el = $('#statusPanel'); if (el) el.innerHTML = statusHtml();
      break;
    }
    case 'routeoff': RT.active = false; RT.a = RT.b = RT.res = null; RT.req++; clearRoute(); mapMsg(''); $('#mapSheet').hidden = true; break;
    case 'rtmode': RT.mode = b.dataset.v; computeRoute(); break;
    case 'thermal': T.mode = b.dataset.mode; store.set('thermal', T.mode); updateThermal(); break;
    case 'logdel': { const log = store.get('log', []); log.splice(Number(b.dataset.i), 1); store.set('log', log); renderProfile(); break; }
    case 'export': {
      try {
        const r = await fetch('/api/privacy/export', { headers: { 'X-AFC-Client': clientId } });
        const j = await r.json();
        const blob = new Blob([JSON.stringify({ server: j, lokal: { flugbuch: store.get('log', []), favoriten: [...S.fav] } }, null, 2)], { type: 'application/json' });
        const a2 = document.createElement('a'); a2.href = URL.createObjectURL(blob); a2.download = 'afc-meine-daten.json'; a2.click(); setTimeout(() => URL.revokeObjectURL(a2.href), 2000);
      } catch (err) { toast('Export fehlgeschlagen: ' + err.message); }
      break;
    }
    case 'wipe': {
      if (!(await ask({ title: 'Daten löschen?', text: 'Gemeldete Flüge auf dem Server und dein lokales Flugbuch werden gelöscht. Favoriten und Einstellungen bleiben.', ok: 'Löschen', danger: true }))) break;
      try {
        const r = await fetch('/api/privacy/delete', { method: 'DELETE', headers: { 'X-AFC-Client': clientId } });
        if (!r.ok) throw new Error('Fehler ' + r.status);
        store.del('log'); toast('Daten gelöscht'); renderProfile();
      } catch (err) { toast('Löschen fehlgeschlagen: ' + err.message); }
      break;
    }
    default: break;
  }
});
document.addEventListener('submit', e => {
  if (e.target.id === 'pilotForm') { e.preventDefault(); savePilot(e.target); }
  if (e.target.id === 'lbSettings') {
    e.preventDefault();
    const x = Object.fromEntries(new FormData(e.target));
    lbSave('settings', { ...LB.data.settings, flightsBefore: x.flightsBefore, hoursBefore: x.hoursBefore }).then(() => { toast('Gespeichert'); renderBook(); }).catch(err => toast(err.message));
  }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches('#layerPanel input[name="base"]')) setBase(t.value);
  else if (t.matches('#layerPanel input[name="ov"]')) { if (t.value in OVERLAYS) setOverlay(t.value, t.checked); else { store.set('ov', { ...store.get('ov', {}), [t.value]: t.checked }); if (t.value === 'air' || t.value === 'wild') updateAir(); else renderMap(); } }
});
document.addEventListener('input', e => {
  if (e.target.id === 'windHour') { W.hour = Number(e.target.value); $('#windHourT').textContent = `${W.hour} Uhr`; clearTimeout(W.t); W.t = setTimeout(() => { updateWind(); updateThermal(); if (RT.res) computeRoute(); }, 150); }
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-act="hour"]')) { e.preventDefault(); e.target.click(); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - S.loadedAt > 3 * 60000) loadPlan(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (S.theme === 'auto') applyTheme(); });
matchMedia('(min-width: 900px)').addEventListener?.('change', () => { if (S.tab === 'lage') renderLage(); });

/* ---------------------------------------------------------------- Start */
(function init() {
  const t = store.get('tab');
  if (['decide', 'map', 'lage', 'day', 'book', 'profile'].includes(t)) S.tab = t;
  applyTheme();
  W.level = ['off', '10m', '800', '700'].includes(store.get('wind')) ? store.get('wind') : 'off';
  W.hour = Math.min(20, Math.max(6, new Date().getHours()));
  const pl = window.AFCPilot?.pilotLevel(store.get('pilot', {}));
  if (pl && !store.get('levelManual')) { S.level = pl.level; store.set('level', S.level); }
  T.mode = ['thermal', 'soar'].includes(store.get('thermal')) ? store.get('thermal') : store.get('thermal') === true ? 'thermal' : 'off';
  render();
  loadPlan();
  lbLoad().then(() => { lbSyncProfile(); if (S.tab === 'decide') renderDecide(); }).catch(() => {});
  loadStatus(); setInterval(() => { if (!document.hidden) loadStatus(); }, 15 * 60000);
  if ((store.get('intro') ?? 0) < INTRO_VER) setTimeout(() => { if (!$('#msgDlg').open && !$('#siteDlg').open) showIntro(); }, 600);
  setInterval(() => { if (!document.hidden) loadPlan(); }, 5 * 60000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
