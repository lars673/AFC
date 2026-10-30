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
  for (const t of ['decide', 'map', 'lage', 'day', 'profile']) $('#v-' + t).hidden = S.tab !== t;
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
  if (S.tab === 'decide') renderDecide();
  else if (S.tab === 'lage') renderLage();
  else if (S.tab === 'day') renderDay();
  else if (S.tab === 'profile') renderProfile();
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

function renderDecide() {
  const el = $('#v-decide');
  if (!S.plan) { el.innerHTML = stateBox(); return; }
  const p = S.plan, h = headlineFor(S.day);
  const lvl = ['careful', 'normal', 'expert'].map(k => `<button type="button" data-act="level" data-v="${k}" aria-pressed="${S.level === k}">${LEVEL_INFO[k][0]}</button>`).join('');
  const favSites = [...S.fav].map(siteById).filter(Boolean);
  const areas = [...p.areas].sort((a, b) => (b.days[S.day]?.best.score ?? -1) - (a.days[S.day]?.best.score ?? -1));
  const nowH = nowHourToday();
  el.innerHTML = `
    <div class="headline ${h.tone}"><h2>${esc(h.title)}</h2><p>${esc(h.text)}</p></div>
    <div class="level"><span class="lbl">Erfahrung</span><div class="seg" role="group" aria-label="Erfahrungsstufe">${lvl}</div></div>
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
    <div class="panel"><h3>Mein Flugbuch</h3>
      ${flightCheck(log)}
      ${log.length ? `<div class="tw"><table class="plain"><thead><tr><th>Datum</th><th>Startplatz</th><th>Flug</th><th>Score</th><th></th></tr></thead><tbody>${log.slice().reverse().map((r, i) => `<tr><td>${new Date(r.launchTime).toLocaleDateString('de-CH')}</td><td>${esc(r.name)}</td><td>${r.launched ? '★'.repeat(r.quality) : 'nicht geflogen'}</td><td>${num(r.afcScore) ? r.afcScore : '–'}${flightMatch(r) && flightMatch(r) !== 'passt' ? ` <span class="fine" title="${flightMatch(r)}">(${flightMatch(r)})</span>` : ''}</td><td><button type="button" class="star" data-act="logdel" data-i="${log.length - 1 - i}" aria-label="Eintrag entfernen">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="fine" style="margin:0">Noch keine Einträge. Nach einem Flug über die Startplatz-Ansicht melden.</p>'}
      <p class="fine">Gemeldete Flüge werden anonym gespeichert (ohne Namen, mit zufälliger Gerätekennung).</p></div>
    <div class="panel"><h3>Datenquellen</h3>${sourcesHtml()}</div>
    <div class="panel"><h3>Datenschutz</h3>
      <div class="btn-row" style="justify-content:flex-start"><button class="btn sec" type="button" data-act="export">Meine Daten exportieren</button><button class="btn sec" type="button" data-act="wipe">Meine Daten löschen</button><a class="btn sec" href="/privacy">Datenschutzerklärung</a></div></div>
    <p class="fine">AFC ${esc(S.plan?.version || '8.0')} · ${S.plan?.siteCount ?? ''} Startplätze (DHV-Geländedatenbank) · Prognose: MeteoSchweiz, DWD, ECMWF über Open-Meteo · Messwerte: MeteoSchweiz · Karte: swisstopo. Keine Gewähr. Der Startentscheid liegt immer bei der Pilotin oder beim Piloten.</p>`;
}

/* ---- Pilotenprofil: Erfahrung und Übung bestimmen die Grenzen (lib/pilot.js) */
const P = () => window.AFCPilot;
function pilotPanel() {
  const pr = store.get('pilot', {}), pl = P()?.pilotLevel(pr);
  const n = (name, label, v, extra = '') => `<label class="fld"><span>${label}</span><input type="number" inputmode="numeric" min="0" max="20000" name="${name}" value="${num(v) ? v : ''}" ${extra}></label>`;
  return `<div class="panel"><h3>Ich als Pilot</h3>
    <form id="pilotForm" class="pilot-form">
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
  M.map.on('click', e => { if (RT.active) routeClick(e.latlng); else if (T.mode !== 'off' && T.data) mapSheet('thermal', e.latlng); else $('#mapSheet').hidden = true; });
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
    L.marker([s.lat, s.lon], { icon, title: `${s.name}: ${b ? b.score : 'keine Bewertung'}`, keyboard: true, zIndexOffset: b ? b.score : 0 }).on('click', () => (RT.active ? routeClick({ lat: s.lat, lng: s.lon }) : mapSheet('site', s.id))).addTo(M.group);
  }
  if (showOv('landings')) for (const l of S.plan.landings || []) {
    L.marker([l.lat, l.lon], { icon: L.divIcon({ className: '', iconSize: [14, 14], iconAnchor: [7, 7], html: '<div class="mk-l"></div>' }), title: 'Landeplatz ' + l.name, keyboard: true }).on('click', () => (RT.active ? routeClick({ lat: l.lat, lng: l.lon }) : mapSheet('landing', l.id))).addTo(M.group);
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
const GLIDE = 7, LAND_RESERVE = 300;   // vorsichtige Gleitzahl und Reserve über dem Landeplatz

/** Raster ca. 1 km für die Routensuche aus Gelände- und Wetterdaten. */
function routeField(g, d) {
  const B = 4, nx = Math.floor(g.nx / B), ny = Math.floor(g.ny / B), N = nx * ny;
  const F = { la0: g.la0 + (B - 1) * g.dla / 2, lo0: g.lo0 + (B - 1) * g.dlo / 2, dla: g.dla * B, dlo: g.dlo * B, nx, ny,
    q: new Float32Array(N), top: new Float32Array(N), ground: new Float32Array(N), u: new Float32Array(N), v: new Float32Array(N), wstar: new Float32Array(N), land: new Uint8Array(N) };
  const lands = (S.plan?.landings || []).filter(l => num(l.lat) && num(l.alt));
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const k = y * nx + x, lat = F.la0 + y * F.dla, lon = F.lo0 + x * F.dlo;
    let qs = [], gmax = 0;
    for (let yy = 0; yy < B; yy++) for (let xx = 0; xx < B; xx++) {
      const gy = y * B + yy, gx = x * B + xx, gk = gy * g.nx + gx;
      gmax = Math.max(gmax, g.elev[gk]);
      qs.push(thermalCell(d, g, gk, g.la0 + gy * g.dla, g.lo0 + gx * g.dlo).v);
    }
    qs.sort((a, b) => b - a);
    F.q[k] = (qs[0] + qs[1] + qs[2]) / 3;                       // die besten Stellen im Quadratkilometer zählen
    F.ground[k] = gmax;
    F.top[k] = fieldAt(d, d.top, lat, lon) ?? NaN;
    F.wstar[k] = fieldAt(d, d.wstar, lat, lon) ?? 0;
    const w = windAtAlt(d, lat, lon, Math.max(gmax, (F.top[k] || 2500) - 500));   // Wind auf Flughöhe
    F.u[k] = w ? w[0] : 0; F.v[k] = w ? w[1] : 0;
    const reach = ((F.top[k] || 0) - LAND_RESERVE);
    F.land[k] = lands.some(l => reach > l.alt && haversineKm(lat, lon, l.lat, l.lon) <= (reach - l.alt) * GLIDE / 1000) ? 1 : 0;
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
function routeClick(ll) {
  if (!RT.a) { RT.a = [ll.lat, ll.lng]; drawRoute(); mapMsg('Route: tippe auf das Ziel B'); return; }
  RT.b = [ll.lat, ll.lng]; RT.active = false; mapMsg(''); computeRoute();
}
async function computeRoute() {
  if (!RT.a || !RT.b) return;
  const req = ++RT.req, iso = windTimeIso();
  mapMsg('Route wird berechnet …');
  try {
    const g = await thermalGrid(), d = await thermalData(iso);
    if (!d) throw new Error('Wetterdaten werden noch geladen, bitte in ein paar Minuten nochmals versuchen');
    let F = RT.fields.get(iso);
    if (!F) { F = routeField(g, d); RT.fields.set(iso, F); if (RT.fields.size > 6) RT.fields.delete(RT.fields.keys().next().value); }
    const res = window.AFCRoute.planRoute(F, RT.a, RT.b, { mode: RT.mode });
    if (req !== RT.req) return;
    RT.res = res; mapMsg(''); drawRoute(); mapSheet('route'); syncWindBar();
    if (res.ok) M.map.fitBounds(L.latLngBounds(res.path), { paddingTopLeft: [40, 40], paddingBottomRight: [40, Math.min(360, $('#mapSheet').offsetHeight + 40)] });
  } catch (err) { if (req === RT.req) { mapMsg('Route: ' + err.message); setTimeout(() => mapMsg(''), 7000); } }
}
const ISSUE_COL = { weak: '#d97706', low: '#dc2626', head: '#7c3aed', land: '#b45309' };
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
    <div class="kv"><div><b>${r.distKm} km</b><span>Strecke</span></div><div><b>${t}</b><span>Flugzeit (Schätzung)</span></div><div><b>${r.avgKmh ?? '–'} km/h</b><span>Schnitt inkl. Kurbeln</span></div></div>
    ${seg}
    ${r.issues.length ? `<h3 class="why-h">Kritische Stellen</h3><ol class="rt-issues">${r.issues.map(i => `<li style="--c:${ISSUE_COL[i.kind]}">${esc(i.text)}</li>`).join('')}</ol>` : '<p>Keine kritischen Stellen gefunden: Thermik, Arbeitshöhe, Wind und Landeplätze passen auf der ganzen Strecke.</p>'}
    <p class="fine">${RT.mode === 'safe' ? 'Sicher: bleibt bei Thermik, Arbeitshöhe und Landeplätzen im Gleitbereich (Gleitzahl 7, 300 m Reserve).' : 'Schnell: kürzeste Flugzeit, nimmt schwächere Abschnitte in Kauf.'} Schätzung für eine Uhrzeit. <b>Luftraum ist noch nicht berücksichtigt</b>, vor dem Flug prüfen.</p>`;
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
  } else if (kind === 'thermal') {
    const t = thermalWhy(id.lat, id.lng);
    if (!t) { el.hidden = true; return; }
    h = `<div class="sheet-top"><div><h3>${esc(t.title)}</h3><p class="fine" style="margin:0">${t.elev} m · ${W.hour} Uhr · Schätzung</p></div></div><ul class="why-list">${t.why.map(x => `<li>${esc(x)}</li>`).join('')}</ul><div class="sheet-act"><button class="btn sec" type="button" data-act="closesheet">Schliessen</button></div>`;
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
    case 'route': routeStart(); break;
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
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches('#layerPanel input[name="base"]')) setBase(t.value);
  else if (t.matches('#layerPanel input[name="ov"]')) { if (t.value in OVERLAYS) setOverlay(t.value, t.checked); else { store.set('ov', { ...store.get('ov', {}), [t.value]: t.checked }); renderMap(); } }
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
  if (['decide', 'map', 'lage', 'day', 'profile'].includes(t)) S.tab = t;
  applyTheme();
  W.level = ['off', '10m', '800', '700'].includes(store.get('wind')) ? store.get('wind') : 'off';
  W.hour = Math.min(20, Math.max(6, new Date().getHours()));
  const pl = window.AFCPilot?.pilotLevel(store.get('pilot', {}));
  if (pl && !store.get('levelManual')) { S.level = pl.level; store.set('level', S.level); }
  T.mode = ['thermal', 'soar'].includes(store.get('thermal')) ? store.get('thermal') : store.get('thermal') === true ? 'thermal' : 'off';
  render();
  loadPlan();
  setInterval(() => { if (!document.hidden) loadPlan(); }, 5 * 60000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
