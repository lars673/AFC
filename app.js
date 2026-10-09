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
    <div class="panel"><h3>Erfahrung</h3>
      <div class="seg" role="group" aria-label="Erfahrungsstufe">${['careful', 'normal', 'expert'].map(k => `<button type="button" data-act="level" data-v="${k}" aria-pressed="${S.level === k}">${LEVEL_INFO[k][0]}</button>`).join('')}</div>
      <p class="fine">${esc(LEVEL_INFO[S.level][1])}</p></div>
    <div class="panel"><h3>Darstellung</h3>
      <div class="seg" role="group" aria-label="Darstellung">${[['auto', 'Automatisch'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([k, n]) => `<button type="button" data-act="theme" data-v="${k}" aria-pressed="${S.theme === k}">${n}</button>`).join('')}</div></div>
    <div class="panel"><h3>Favoriten</h3>
      ${favs.length ? favs.map(s => `<div class="srow" style="padding-left:0;padding-right:0"><button type="button" class="srow-main" data-act="site" data-id="${esc(s.id)}"><span class="srow-name">${esc(s.name)}</span><span class="srow-sub">${s.alt} m · ${esc(aspectText(s))}</span></button>${starBtn(s.id)}</div>`).join('') : '<p class="fine" style="margin:0">Noch keine Favoriten. Tippe in der Startplatz-Ansicht auf den Stern.</p>'}</div>
    <div class="panel"><h3>Mein Flugbuch</h3>
      ${log.length ? `<div class="tw"><table class="plain"><thead><tr><th>Datum</th><th>Startplatz</th><th>Flug</th><th>Score</th><th></th></tr></thead><tbody>${log.slice().reverse().map((r, i) => `<tr><td>${new Date(r.launchTime).toLocaleDateString('de-CH')}</td><td>${esc(r.name)}</td><td>${r.launched ? '★'.repeat(r.quality) : 'nicht geflogen'}</td><td>${num(r.afcScore) ? r.afcScore : '–'}</td><td><button type="button" class="star" data-act="logdel" data-i="${log.length - 1 - i}" aria-label="Eintrag entfernen">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="fine" style="margin:0">Noch keine Einträge. Nach einem Flug über die Startplatz-Ansicht melden.</p>'}
      <p class="fine">Gemeldete Flüge werden anonym gespeichert (ohne Namen, mit zufälliger Gerätekennung).</p></div>
    <div class="panel"><h3>Datenquellen</h3>${sourcesHtml()}</div>
    <div class="panel"><h3>Datenschutz</h3>
      <div class="btn-row" style="justify-content:flex-start"><button class="btn sec" type="button" data-act="export">Meine Daten exportieren</button><button class="btn sec" type="button" data-act="wipe">Meine Daten löschen</button><a class="btn sec" href="/privacy">Datenschutzerklärung</a></div></div>
    <p class="fine">AFC ${esc(S.plan?.version || '8.0')} · ${S.plan?.siteCount ?? ''} Startplätze (DHV-Geländedatenbank) · Prognose: MeteoSchweiz, DWD, ECMWF über Open-Meteo · Messwerte: MeteoSchweiz · Karte: swisstopo. Keine Gewähr. Der Startentscheid liegt immer bei der Pilotin oder beim Piloten.</p>`;
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
      ${hr.hard.length ? `<ul class="ko">${hr.hard.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${hr.reasons.length ? `<ul class="rs">${hr.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="fine">Keine Auffälligkeiten.</p>'}
      <div class="kv">
        <div><b>${hr.speed ?? '–'} ${arrow(hr.dir)}</b><span>Wind km/h aus ${dirLabel(hr.dir)} (${hr.dir ?? '–'}°)</span></div>
        <div><b>${hr.gust ?? '–'}</b><span>Böen km/h</span></div>
        <div><b>${hr.head ?? '–'} / ${hr.tail ?? '–'}</b><span>Gegenwind / Rückenwind${hr.wd != null ? ', ' + hr.wd + '° neben dem Hang' : ''}</span></div>
        <div><b>${hr.cloudMargin ?? '–'} m</b><span>Wolkenbasis über Start${hr.cloudBase ? ' (Basis ' + hr.cloudBase + ' m)' : ''}</span></div>
        <div><b>${hr.pop ?? '–'} %</b><span>Regenrisiko, CAPE ${hr.cape ?? '–'}</span></div>
        <div><b>${hr.thermal}</b><span>Thermikindex (0–100)</span></div>
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
const OVERLAYS = {
  slope: { url: SWT('ch.swisstopo.hangneigung-ueber_30', 'png'), name: 'Hangneigung', opacity: 0.55 },
  obst: { url: SWT('ch.bazl.luftfahrthindernis', 'png'), name: 'Hindernisse', opacity: 0.9 }
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
  const l = L.tileLayer(o.url, { opacity: o.opacity, maxZoom: 18, attribution: '© swisstopo, BAZL' });
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
  M.map.on('click', () => { $('#mapSheet').hidden = true; });
  return true;
}
function arrowIcon(dir, label) {
  return L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], html: `<div class="mk-s">${arrow(dir)}<span>${esc(label)}</span></div>` });
}
function renderMap() {
  if (!initMap()) return;
  setTimeout(() => M.map.invalidateSize(), 50);
  if (!S.plan) { mapMsg('Wetterdaten werden geladen …'); return; }
  M.group.clearLayers();
  const showOv = k => { const i = $(`#layerPanel input[value="${k}"]`); return i ? i.checked : true; };
  for (const s of S.plan.sites) {
    const b = s.days[S.day]?.best, c = s.blocked ? 'none' : cls(b?.score);
    const icon = L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], html: `<div class="mk s-${c}${s.blocked ? ' blocked' : ''}">${s.blocked ? '✕' : b ? b.score : '–'}</div>` });
    L.marker([s.lat, s.lon], { icon, title: `${s.name}: ${b ? b.score : 'keine Bewertung'}`, keyboard: true, zIndexOffset: b ? b.score : 0 }).on('click', () => mapSheet('site', s.id)).addTo(M.group);
  }
  if (showOv('landings')) for (const l of S.plan.landings || []) {
    L.marker([l.lat, l.lon], { icon: L.divIcon({ className: '', iconSize: [14, 14], iconAnchor: [7, 7], html: '<div class="mk-l"></div>' }), title: 'Landeplatz ' + l.name, keyboard: true }).on('click', () => mapSheet('landing', l.id)).addTo(M.group);
  }
  if (showOv('stations')) for (const st of S.plan.stations || []) {
    if (!num(st.wind)) continue;
    L.marker([st.lat, st.lon], { icon: arrowIcon(st.dir, Math.round(st.wind)), title: `${st.name}: ${Math.round(st.wind)} km/h aus ${dirLabel(st.dir)}`, keyboard: true }).on('click', () => mapSheet('station', st.code)).addTo(M.group);
  }
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
    case 'level': if (S.level !== b.dataset.v) { S.level = b.dataset.v; store.set('level', S.level); S.detail.clear(); render(); loadPlan(); } break;
    case 'theme': S.theme = b.dataset.v; store.set('theme', S.theme); render(); break;
    case 'check': {
      const key = 'check.' + todayKey(), cur = new Set(store.get(key, [])), i = Number(b.dataset.i);
      b.checked ? cur.add(i) : cur.delete(i); store.set(key, [...cur]); break;
    }
    case 'report': closeDlg($('#siteDlg')); reportForm(id); break;
    case 'showmap': closeDlg($('#siteDlg')); setTab('map'); setTimeout(() => { const s = siteById(id); if (M.map && s) { M.map.setView([s.lat, s.lon], 14); mapSheet('site', id); } }, 200); break;
    case 'layers': { const p = $('#layerPanel'); p.hidden = !p.hidden; b.setAttribute('aria-expanded', String(!p.hidden)); break; }
    case 'locate': locate(); break;
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
document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches('#layerPanel input[name="base"]')) setBase(t.value);
  else if (t.matches('#layerPanel input[name="ov"]')) { if (t.value in OVERLAYS) setOverlay(t.value, t.checked); else { store.set('ov', { ...store.get('ov', {}), [t.value]: t.checked }); renderMap(); } }
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
  render();
  loadPlan();
  setInterval(() => { if (!document.hidden) loadPlan(); }, 5 * 60000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
