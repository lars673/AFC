/* AFC 8.0 – App. Der Server rechnet, die App zeigt an und merkt sich Favoriten, Erfahrungsstufe und Flugbuch. */
'use strict';

/* ---------------------------------------------------------------- Helfer */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => typeof v === 'number' && Number.isFinite(v);
// Persönliche Einstellungen, die mit dem Konto auf dem Mac gespeichert werden (gleich auf jedem Gerät)
const SYNC_KEYS = new Set(['fav', 'level', 'levelManual', 'pilot']);
const store = {
  get(k, d) { try { const v = localStorage.getItem('afc.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('afc.' + k, JSON.stringify(v)); } catch { /* privat/voll */ } if (SYNC_KEYS.has(k)) store.changed?.(); },
  del(k) { try { localStorage.removeItem('afc.' + k); } catch { /* egal */ } if (SYNC_KEYS.has(k)) store.changed?.(); },
  changed: null
};
const APP_VER = '10.2';
// Testphase: JavaScript-Fehler an den Mac melden (gleiche Meldung nur einmal, höchstens 8 pro Sitzung)
const rawFetch = window.fetch.bind(window);
const ERR = { n: 0, seen: new Set() };
function reportError(msg, src, line, stack) {
  const sig = `${msg}|${src}|${line}`;
  if (!msg || ERR.n >= 8 || ERR.seen.has(sig) || /ResizeObserver|Script error\.?$/.test(msg)) return;
  ERR.seen.add(sig); ERR.n++;
  rawFetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg: String(msg).slice(0, 300), src: String(src || '').replace(location.origin, ''), line, stack: String(stack || '').slice(0, 1500), page: typeof S === 'undefined' ? '' : S.tab, ver: APP_VER, device: navigator.userAgent.slice(0, 160) }) }).catch(() => {});
}
window.addEventListener('error', e => { if (e.message) reportError(e.message, e.filename, e.lineno, e.error?.stack); });
window.addEventListener('unhandledrejection', e => reportError('Promise: ' + (e.reason?.message || e.reason), '', 0, e.reason?.stack));
// Sagt der Mac «Bitte anmelden», erscheint die Anmeldung (z.B. nach 90 Tagen oder wenn Lars das Konto entfernt hat)
window.fetch = async (input, init) => {
  const r = await rawFetch(input, init);
  const url = typeof input === 'string' ? input : input?.url || '';
  if (r.status === 401 && /^\/api\/(?!auth\/)/.test(url) && typeof ME !== 'undefined' && !ME.gate) r.clone().json().then(j => { if (j?.login) showGate('login'); }).catch(() => {});
  return r;
};
/** Alter einer Messung in Minuten, ab dem Messzeitpunkt gerechnet (stimmt auch bei gespeicherten Daten ohne Empfang). */
const ageMin = (time, fallback) => { const t = Date.parse(time || ''); return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60000)) : fallback; };
const ageTxt = m => (!Number.isFinite(m) ? '' : m < 60 ? `vor ${m} min` : m < 1440 ? `vor ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `vor ${Math.floor(m / 1440)} Tagen`);
/** «07:12 Uhr» heute, sonst «01.11. 07:12 Uhr». */
const whenTxt = t => { const d = new Date(t); return (d.toDateString() === new Date().toDateString() ? '' : d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' }) + ' ') + d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }) + ' Uhr'; };
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
  plan: null, day: 0, tab: 'decide', warming: false, offline: false, err: null, loadedAt: 0, sort: 'best', pos: null, locating: false,
  level: ['careful', 'normal', 'expert'].includes(store.get('level')) ? store.get('level') : 'normal',
  theme: ['auto', 'light', 'dark', 'sun'].includes(store.get('theme')) ? store.get('theme') : 'auto',
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
  $('#metaTheme').content = S.theme === 'sun' ? '#000000' : dark ? '#08100b' : '#0f1a14';
  $('#sunBtn')?.setAttribute('aria-pressed', String(S.theme === 'sun'));
}

/* ---------------------------------------------------------------- Laden */
let loadTimer = null;
async function loadPlan(manual) {
  clearTimeout(loadTimer);
  $('.stamp-btn')?.classList.add('spin');
  // Beim Öffnen sofort den letzten Stand zeigen (schlechter Empfang am Startplatz), deutlich als alt markiert
  if (!S.plan) {
    const c = store.get('plan');
    if (c?.plan && c.level === S.level) { S.plan = c.plan; S.cachedAt = c.at; S.refreshing = true; S.day = defaultDay(c.plan); render(); }
  }
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(`/api/plan?level=${S.level}`, { cache: 'no-cache', signal: ctl.signal }).catch(e => { throw e.name === 'AbortError' ? new Error('keine Antwort nach 15 s, schlechter Empfang?') : e; });
    if (r.status === 202) {
      S.warming = true;
      loadTimer = setTimeout(() => loadPlan(), 4000);
    } else if (!r.ok) {
      throw new Error(r.status === 429 ? 'Zu viele Anfragen, bitte kurz warten' : `Server antwortet mit ${r.status}`);
    } else {
      const p = await r.json();
      if (!p.ok) throw new Error('Keine Prognosedaten');
      S.plan = p; S.warming = false; S.offline = false; S.err = null; S.loadedAt = Date.now(); S.cachedAt = null;
      store.set('plan', { level: S.level, at: Date.now(), plan: p });
      if (manual) toast('Aktualisiert');
      setTimeout(prefetchDetails, 1500);
    }
  } catch (e) {
    S.offline = true; S.err = e.message || 'Netzwerkfehler';
    if (!S.plan) {
      const c = store.get('plan');
      if (c?.plan && c.level === S.level) { S.plan = c.plan; S.cachedAt = c.at; }
    }
  } finally {
    clearTimeout(to); S.refreshing = false;
    $('.stamp-btn')?.classList.remove('spin');
    if (S.plan) S.day = S.dayPicked ? Math.min(S.day, S.plan.dates.length - 1) : defaultDay(S.plan);
    render();
    pushSync();
  }
}
/** Welcher Tag beim Öffnen: heute, am Abend (kein Fenster mehr) morgen. Sobald man selbst einen Tag wählt, bleibt er. */
function defaultDay(p) {
  const t = Math.max(0, p.dates.indexOf(todayKey()));
  return !p.days[t]?.top && t + 1 < p.dates.length ? t + 1 : t;
}
// Startplatz-Details bleiben für Favoriten, Wächter-Plätze und zuletzt geöffnete Plätze gespeichert,
// damit sie am Startplatz auch ohne Empfang da sind (deutlich als alter Stand markiert).
const DET_MAX = 12;
function detStoreGet(key) { return store.get('det', {})[key] || null; }
function detStorePut(key, data) {
  const all = store.get('det', {}); all[key] = { at: Date.now(), data };
  const keep = new Set([...S.fav, ...WT.list.map(w => w.siteId)].map(id => `${S.level}:${id}`));
  const keys = Object.keys(all).sort((a, b) => (keep.has(b) - keep.has(a)) || all[b].at - all[a].at);
  for (const k of keys.slice(DET_MAX)) delete all[k];
  store.set('det', all);
  if (localStorage.getItem('afc.det') == null && keys.length > 1) store.set('det', { [key]: all[key] }); // Speicher voll: nur diesen behalten
}
async function loadDetail(id, { quiet = false } = {}) {
  const key = `${S.level}:${id}`;
  const c = S.detail.get(key);
  if (c && Date.now() - c.at < 3 * 60000) return c.data;
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), quiet ? 30000 : 10000);
  try {
    const r = await fetch(`/api/site/${encodeURIComponent(id)}?level=${S.level}`, { cache: 'no-cache', signal: ctl.signal });
    if (r.status === 202) throw new Error('Daten werden noch geladen, bitte gleich nochmals versuchen');
    if (!r.ok) throw new Error(`Server antwortet mit ${r.status}`);
    const data = await r.json();
    S.detail.set(key, { at: Date.now(), data });
    detStorePut(key, data);
    return data;
  } catch (e) {
    const old = detStoreGet(key);
    if (old) {
      // Tage an die Daten des Plans anpassen: ein Stand von gestern darf nicht als «heute» erscheinen
      const byDate = new Map(old.data.days.map(d => [d.date, d]));
      const days = (S.plan?.dates || []).map(dt => byDate.get(dt) || { date: dt, hours: [], best: null });
      return { ...old.data, days, _savedAt: old.at };
    }
    throw e.name === 'AbortError' ? new Error('keine Antwort, schlechter Empfang?') : e;
  } finally { clearTimeout(to); }
}
/** Nach dem Laden des Plans: Details der Favoriten und Wächter-Plätze im Hintergrund speichern. */
async function prefetchDetails() {
  if (S.offline || navigator.connection?.saveData) return;
  const ids = [...new Set([...S.fav, ...WT.list.map(w => w.siteId)])].filter(id => S.plan && siteById(id)).slice(0, 8);
  for (const id of ids) {
    const k = `${S.level}:${id}`, old = detStoreGet(k);
    if (old && Date.now() - old.at < 20 * 60000) continue;
    S.detail.delete(k);
    try { await loadDetail(id, { quiet: true }); } catch { break; }
  }
}

/* ---------------------------------------------------------------- Bausteine */
const siteById = id => S.plan.sites.find(s => s.id === id);
const areaById = id => S.plan.areas.find(a => a.id === id);
function dayName(i) {
  // nach dem Datum, nicht nach der Position: ein gespeicherter Plan von gestern beginnt mit «Gestern»
  const diff = Math.round((Date.parse(S.plan.dates[i] + 'T12:00:00Z') - Date.parse(todayKey() + 'T12:00:00Z')) / 86400000);
  if (diff === 0) return 'Heute'; if (diff === 1) return 'Morgen'; if (diff === -1) return 'Gestern';
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
const isToday = () => S.plan?.dates[S.day] === todayKey();
const nowHourToday = () => (isToday() ? Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Zurich' })) : null);

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
  for (const t of ['decide', 'map', 'lage', 'day', 'book', 'group', 'profile']) $('#v-' + t).hidden = S.tab !== t;
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)));
  if (S.tab === 'decide') renderDecide();
  else if (S.tab === 'lage') renderLage();
  else if (S.tab === 'day') renderDay();
  else if (S.tab === 'profile') renderProfile();
  else if (S.tab === 'book') renderBook();
  else if (S.tab === 'map') renderMap();
  else if (S.tab === 'group') renderGroup();
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
  $('#srcDotT').hidden = st[0] === 'ok';
  $('#srcDot').setAttribute('aria-label', `Datenquellen: ${st[1]}`);
  const old = p && Date.now() - Date.parse(p.fetchedAt) > 90 * 60000;
  $('#stamp').textContent = p ? `Prognose ${old ? whenTxt(p.fetchedAt).replace(' Uhr', '') + ' (' + ageTxt(ageMin(p.fetchedAt)) + ')' : timeOf(p.fetchedAt)}` : 'Lade Daten …';
}
function renderBanner() {
  const b = $('#banner');
  let msg = '', bad = false;
  const at = S.plan && (S.plan.fetchedAt || (S.cachedAt && new Date(S.cachedAt).toISOString()));
  const when = at ? (new Date(at).toDateString() === new Date().toDateString() ? `${timeOf(at)} Uhr` : `${new Date(at).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })} ${timeOf(at)} Uhr`) : 'früher';
  if (S.refreshing && S.plan) msg = `Zeige letzten Stand von ${when}, neue Daten werden geladen …`;
  else if (S.offline && S.plan) {
    msg = `Keine Verbindung (${S.err}). Letzter Stand von ${when} – nicht für den Startentscheid verwenden.`; bad = true;
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
  const today = todayKey();
  $('#daybar').innerHTML = p.dates.map((_, i) => {
    const top = p.days[i].top, site = top && siteById(top.siteId);
    const sc = top?.best.score, past = p.dates[i] < today || (p.dates[i] === today && !top);
    return `<button type="button" class="day${past ? ' past' : ''}" data-act="day" data-i="${i}" aria-pressed="${i === S.day}">
      <span class="day-n">${dayName(i)}</span>
      <span class="day-h"><span class="day-d">${dayDate(i)}</span><span class="day-s t-${cls(sc)}">${num(sc) ? sc : past ? 'vorbei' : '–'}</span></span>
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
  if (!t) {
    const later = p.days.findIndex((x, i) => i > d && x.top);
    const next = later > 0 ? ` ${dayName(later)} sieht ${p.days[later].top.best.score >= 80 ? 'gut' : p.days[later].top.best.score >= 55 ? 'durchzogen' : 'schwierig'} aus (bester Score ${p.days[later].top.best.score}).` : '';
    if (S.plan.dates[d] <= todayKey()) return { tone: 'none', title: `${dayName(d)}: kein Flugfenster mehr`, text: `Der Flugtag ist vorbei.${next}`, next: later };
    return { tone: 'none', title: `${dayName(d)}: noch keine Bewertung`, text: 'Für diesen Tag liegen noch keine auswertbaren Daten vor.' };
  }
  const site = siteById(t.siteId), area = areaById(t.areaId), sc = t.best.score;
  const tone = sc >= 80 ? 'ok' : sc >= 55 ? 'warn' : 'danger';
  const title = sc >= 80 ? `${dayName(d)} sieht gut aus` : sc >= 55 ? `${dayName(d)} nur mit Vorsicht` : `${dayName(d)} besser am Boden bleiben`;
  let text = sc >= 55 ? `Bester Start: ${site.name}${site.name.startsWith(area.name) ? '' : ' (' + area.name + ')'}, ${winText(t.best)}, Score ${sc}.` : `Der beste Startplatz (${site.name}) erreicht nur ${sc} von 100.`;
  const dd = p.days[d];
  if (dd.regionStatus && dd.regionStatus !== 'ok') text += ` Regional: ${({ front: 'Kaltfront', storm: 'Gewitterrisiko', foehn: 'Föhn', bise: 'Bise', valley: 'Talwind', upper: 'starker Höhenwind' })[dd.regionWorst] || 'Lage'} ${dd.regionStatus === 'danger' ? '(K.-o.)' : '(Vorsicht)'}.`;
  if (d > 2) text += ' Je weiter in der Zukunft, desto unsicherer.';
  return { tone, title, text };
}

/** Kompakte Zeile pro Gebiet: Name, bester Start mit Fenster, Score; aufklappbar für alle Startplätze. */
function areaRow(a) {
  const d = a.days[S.day];
  const sites = a.sites.map(siteById).filter(Boolean);
  const open = S.open.has(a.id), hasFav = sites.some(s => S.fav.has(s.id));
  const best = d && siteById(d.siteId), nowH = nowHourToday();
  const km = S.pos ? Math.round(Math.min(...sites.map(s => haversineKm(S.pos[0], S.pos[1], s.lat, s.lon)))) : null;
  const sub = d ? `${esc(best.name)} · ${winText(d.best)}` : (isToday() ? 'Heute kein Flugfenster mehr' : 'Kein auswertbares Fenster');
  const score = x => (x.blocked ? -1 : x.days[S.day].best?.score ?? -1);
  const srow = (s, inGroup) => {
    const b = s.days[S.day].best;
    return `<div class="srow${inGroup ? ' in-grp' : ''}"><button type="button" class="srow-main" data-act="site" data-id="${esc(s.id)}" aria-label="${esc(s.name)} öffnen"><span class="srow-name">${esc(inGroup ? shortName(s.name, inGroup) : s.name)}</span><span class="srow-sub">${s.alt} m · ${esc(aspectText(s))} · ${b ? winText(b) : 'kein Fenster'}${s.blocked ? ' · gesperrt' : ''}</span>${ribbon(s.days[S.day].scores, b, { now: nowH })}</button><div style="display:grid;justify-items:center">${starBtn(s.id)}<div class="mini-pill s-${s.blocked ? 'none' : cls(b?.score)}">${s.blocked ? '✕' : b ? b.score : '–'}</div></div></div>`;
  };
  // Startplätze am selben Berg (höchstens 1.5 km auseinander) zusammen, beste Richtung zuerst
  const rows = mountainGroups(sites).map(g => g.sites.sort((x, y) => score(y) - score(x)))
    .sort((x, y) => score(y[0]) - score(x[0]))
    .map(g => {
      if (g.length === 1) return srow(g[0]);
      const name = mountainName(g), top = g[0], tb = top.days[S.day].best;
      return `<div class="grp-h"><b>${esc(name)}</b><span>${g.length} Startrichtungen${tb ? ` · am besten ${esc(aspectText(top))} (${tb.score})` : ''}</span></div>${g.map(x => srow(x, name)).join('')}`;
    }).join('');
  return `<div class="arow${open ? ' open' : ''}">
    <button type="button" class="arow-main" data-act="${d ? 'site' : 'toggle'}" data-id="${d ? esc(d.siteId) : esc(a.id)}" aria-label="${esc(a.name)}${d ? ', Score ' + d.best.score + ', bester Start ' + esc(best.name) + ' öffnen' : ', aufklappen'}">
      <span class="arow-txt"><span class="arow-name">${esc(a.name)}${hasFav ? ' <span class="arow-fav" aria-label="Favorit">★</span>' : ''}${km !== null ? ` <span class="arow-km">${km} km</span>` : ''}</span><span class="arow-sub">${sub}</span>${d ? ribbon(best.days[S.day].scores, d.best, { now: nowH }) : ''}</span>
      <span class="mini-pill s-${d ? cls(d.best.score) : 'none'}">${d ? d.best.score : '–'}</span></button>
    <button type="button" class="arow-exp" data-act="toggle" data-id="${esc(a.id)}" aria-expanded="${open}" aria-label="${sites.length} ${sites.length === 1 ? 'Startplatz' : 'Startplätze'} ${open ? 'zuklappen' : 'zeigen'}"><span>${sites.length}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    ${open ? `<div class="rows arow-rows">${rows}</div>` : ''}
  </div>`;
}
/** Startplätze gruppieren, die höchstens 1.5 km auseinander liegen (gleicher Berg, verschiedene Richtungen). */
function mountainGroups(sites) {
  const gs = [];
  for (const s of sites) {
    const hit = gs.filter(g => g.sites.some(x => haversineKm(x.lat, x.lon, s.lat, s.lon) <= 1.5));
    if (!hit.length) gs.push({ sites: [s] });
    else { const g = hit[0]; g.sites.push(s); for (const o of hit.slice(1)) { g.sites.push(...o.sites); gs.splice(gs.indexOf(o), 1); } }
  }
  return gs;
}
/** Gemeinsamer Namensanfang («Amisbühl Start 1 (Chalet)», «Amisbühl Start 5» → «Amisbühl»). */
function mountainName(g) {
  const w = g.map(x => x.name.split(/\s+/));
  const out = [];
  for (let i = 0; i < w[0].length; i++) { if (w.every(x => x[i] === w[0][i])) out.push(w[0][i]); else break; }
  const n = out.join(' ').replace(/\s+(Start|Startplatz)$/i, '').trim();
  return n.length >= 3 ? n : g[0].name;
}
const shortName = (name, group) => { const r = name.startsWith(group) ? name.slice(group.length).trim() : name; return r.length >= 2 ? r : name; };
/** Standort für «In der Nähe» (nur im Browser, wird nirgends gespeichert). */
function locateNear() {
  if (!navigator.geolocation) { toast('Dieses Gerät gibt keinen Standort an.'); return; }
  S.locating = true; renderDecide();
  navigator.geolocation.getCurrentPosition(p => {
    S.pos = [p.coords.latitude, p.coords.longitude]; S.locating = false; S.sort = 'near'; store.set('sort', 'near'); renderDecide();
  }, () => { S.locating = false; S.sort = 'best'; store.set('sort', 'best'); renderDecide(); toast('Standort nicht freigegeben. Auf dem iPhone: Einstellungen › Datenschutz › Ortungsdienste › Safari-Websites.'); }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 15 * 60000 });
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
  const near = S.sort === 'near' && S.pos;
  const dist = a => Math.min(...a.sites.map(siteById).filter(Boolean).map(x => haversineKm(S.pos[0], S.pos[1], x.lat, x.lon)));
  const areas = [...p.areas].sort((a, b) => near ? dist(a) - dist(b) : (b.days[S.day]?.best.score ?? -1) - (a.days[S.day]?.best.score ?? -1));
  const nowH = nowHourToday();
  el.innerHTML = `
    ${watchLineHtml()}
    ${surveyCard()}
    <div class="headline ${h.tone}"><h2>${esc(h.title)}</h2><p>${esc(h.text)}</p>${h.next > 0 ? `<button type="button" class="btn sec hl-next" data-act="day" data-i="${h.next}">${esc(dayName(h.next))} ansehen</button>` : ''}</div>
    ${feedbackHtml()}
    ${gearAlertHtml(gearAlerts().filter(x => x.level === 'due'))}
    ${favSites.length ? `<h2 class="sec-h">Meine Startplätze</h2><div class="cards"><article class="card"><div class="rows" style="border-top:0">${favSites.map(s => {
      const b = s.days[S.day].best;
      return `<div class="srow"><button type="button" class="srow-main" data-act="site" data-id="${esc(s.id)}"><span class="srow-name">${esc(s.name)}</span><span class="srow-sub">${s.alt} m · ${b ? winText(b) : 'kein Fenster'}</span>${ribbon(s.days[S.day].scores, b, { now: nowH })}</button><div style="display:grid;justify-items:center">${starBtn(s.id)}<div class="mini-pill s-${cls(b?.score)}">${b ? b.score : '–'}</div></div></div>`;
    }).join('')}</div></article></div>` : ''}
    <div class="sec-row"><h2 class="sec-h">Gebiete ${isToday() ? 'heute' : dayName(S.day) === 'Morgen' ? 'morgen' : 'am ' + dayName(S.day)}</h2>
      <div class="sec-tools"><div class="seg seg-sm" role="group" aria-label="Sortierung"><button type="button" data-act="sort" data-v="best" aria-pressed="${!near}">Beste</button><button type="button" data-act="sort" data-v="near" aria-pressed="${!!near}" ${S.locating ? 'disabled' : ''}>${S.locating ? 'Suche …' : 'Nähe'}</button></div>
      <button type="button" class="ico-btn" data-act="week" aria-label="Wochenblick" title="Wochenblick"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 10h18M8 3v4M16 3v4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button><button type="button" class="ico-btn" data-act="compare" aria-label="Startplätze vergleichen" title="Vergleichen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V10M12 20V4M19 20v-7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button></div></div>
    <div class="card alist">${areas.map(areaRow).join('')}</div>
    <p class="fine">Der Score ist eine Entscheidungshilfe, keine Freigabe. K.-o.-Kriterien (Kaltfront, Gewitter, Föhn, zu starker Wind, Regen, Wolke am Start, Rückenwind) deckeln den Score. Die Entscheidung trifft immer die Pilotin oder der Pilot vor Ort.</p>`;
}

/* ---- Wochenblick: bestes Fenster je Favorit und Gebiet für alle Prognosetage */
function weekHtml() {
  const p = S.plan, nd = p.dates.length;
  const favs = [...S.fav].map(siteById).filter(Boolean);
  const cell = (b, d, act, id) => `<td><button type="button" class="wk-c s-${cls(b?.score)}" data-act="${act}" data-id="${esc(id)}" data-d="${d}" aria-label="${esc(dayName(d))}: ${b ? b.score + ', ' + winText(b) : 'kein Fenster'}"><b>${b ? b.score : '–'}</b><small>${b ? b.from + '–' + b.to : ''}</small></button></td>`;
  const head = `<tr><th></th>${p.dates.map((_, d) => `<th scope="col" class="${d === S.day ? 'sel' : ''}">${esc(dayName(d))}<small>${dayDate(d)}</small></th>`).join('')}</tr>`;
  const favRows = favs.map(x => `<tr><th scope="row">${esc(x.name)}</th>${x.days.slice(0, nd).map((dd, d) => cell(dd.best, d, 'wksite', x.id)).join('')}</tr>`).join('');
  const areas = [...p.areas].sort((a, b) => {
    const sum = z => z.days.reduce((t, x) => t + (x?.best.score ?? 0), 0);
    return sum(b) - sum(a);
  });
  const areaRows = areas.map(a => `<tr><th scope="row">${esc(a.name)}</th>${a.days.slice(0, nd).map((x, d) => cell(x?.best, d, x ? 'wksite' : 'wkday', x?.siteId || '')).join('')}</tr>`).join('');
  // Bester Tag der Woche (nach dem besten Gebiet)
  let top = null;
  p.dates.forEach((_, d) => { const t = p.days[d]?.top; if (t && (!top || t.best.score > top.t.best.score)) top = { d, t }; });
  return `<div class="dlg-in"><div class="dlg-h"><div><h2 id="siteDlgT">Wochenblick</h2><p class="fine" style="margin:2px 0 0">Bester Score und bestes Fenster je Tag. Antippen öffnet den Startplatz an diesem Tag.</p></div><button class="x-btn" type="button" data-act="closesite" aria-label="Schliessen">×</button></div>
    ${top ? `<div class="wk-top t-${cls(top.t.best.score)}"><b>${esc(dayName(top.d))} ${dayDate(top.d)}</b> sieht am besten aus: ${esc(areaById(top.t.areaId)?.name || '')}, ${esc(siteById(top.t.siteId)?.name || '')} ${top.t.best.score}, ${winText(top.t.best)}.</div>` : ''}
    <div class="wk-wrap"><table class="wk"><thead>${head}</thead>
      ${favRows ? `<tbody><tr class="wk-sec"><th colspan="${nd + 1}">Meine Startplätze</th></tr>${favRows}</tbody>` : ''}
      <tbody><tr class="wk-sec"><th colspan="${nd + 1}">Gebiete (bester Startplatz)</th></tr>${areaRows}</tbody></table></div>
    <p class="fine">Je weiter voraus, desto unsicherer: ab dem dritten Tag ist der Score eher eine Tendenz.</p></div>`;
}

/* ---- Startplätze vergleichen: bis zu drei Plätze Stunde für Stunde */
function cmpIds() {
  const p = S.plan, ok = id => siteById(id) && !siteById(id).blocked;
  let ids = store.get('cmp', []).filter(ok);
  if (ids.length < 2) {
    const fav = [...S.fav].filter(ok);
    // sonst die besten Plätze aus verschiedenen Gebieten
    const top = p.areas.map(a => a.days[S.day]).filter(Boolean).sort((a, b) => b.best.score - a.best.score).map(x => x.siteId);
    ids = [...new Set([...ids, ...fav, ...top])].slice(0, 3);
  }
  return ids.slice(0, 3);
}
function compareHtml() {
  const p = S.plan, ids = cmpIds(), sites = ids.map(siteById);
  const opts = sel => p.areas.map(a => `<optgroup label="${esc(a.name)}">${a.sites.map(siteById).filter(x => x && !x.blocked).map(x => `<option value="${esc(x.id)}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>`).join('');
  const hours = [];
  for (let i = 0; i < 16; i++) if (sites.some(x => num(x.days[S.day]?.scores?.[i]))) hours.push(i);
  const nowH = nowHourToday();
  const bestOf = x => x.days[S.day]?.best;
  const winner = sites.reduce((w, x) => (bestOf(x) && (!w || bestOf(x).score > bestOf(w).score) ? x : w), null);
  return `<div class="dlg-in"><div class="dlg-h"><div><h2 id="siteDlgT">Vergleichen</h2></div><button class="x-btn" type="button" data-act="closesite" aria-label="Schliessen">×</button></div>
    <div class="seg seg-sm cmp-days" role="group" aria-label="Tag">${p.dates.map((_, d) => `<button type="button" data-act="cmpday" data-d="${d}" aria-pressed="${d === S.day}">${esc(dayName(d))}</button>`).join('')}</div>
    <div class="cmp-sel">${[0, 1, 2].map(i => `<label><span class="fine">Platz ${i + 1}</span><select data-cmp="${i}">${i === 2 ? `<option value="">– keiner –</option>` : ''}${opts(ids[i])}</select></label>`).join('')}</div>
    ${winner ? `<div class="wk-top t-${cls(bestOf(winner).score)}"><b>${esc(winner.name)}</b> ist ${esc(dayName(S.day).toLowerCase() === 'heute' ? 'heute' : 'an diesem Tag')} am besten: ${bestOf(winner).score}, ${winText(bestOf(winner))}.</div>` : ''}
    <div class="wk-wrap"><table class="cmp"><thead><tr><th>Uhr</th>${sites.map(x => `<th scope="col"><button type="button" class="linkish" data-act="site" data-id="${esc(x.id)}">${esc(x.name)}</button><small>${x.alt} m</small></th>`).join('')}</tr></thead>
      <tbody><tr class="cmp-best"><th scope="row">Fenster</th>${sites.map(x => `<td>${bestOf(x) ? winText(bestOf(x)).replace(' Uhr', '') : '–'}</td>`).join('')}</tr>
      ${hours.map(i => { const h = p.h0 + i; return `<tr class="${h === nowH ? 'now' : ''}"><th scope="row">${h === nowH ? 'jetzt' : h}</th>${sites.map(x => { const v = x.days[S.day]?.scores?.[i]; return `<td><span class="mini-pill s-${cls(v)}">${num(v) ? v : '–'}</span></td>`; }).join('')}</tr>`; }).join('')}</tbody></table></div>
    <p class="fine">Name antippen für Details und Gründe.</p></div>`;
}
function openCompare() { S.panel = 'compare'; dlg('#siteDlg', compareHtml()); }
function openWeek() { S.panel = 'week'; dlg('#siteDlg', weekHtml()); }

/* ---- Lage */
function regionSummary(d) {
  const hours = S.plan.region.days[d]?.hours || [];
  const day = hours.filter(h => h.h >= 8 && h.h <= 18);
  const parts = [];
  for (const [k, name] of [['front', 'Kaltfront'], ['storm', 'Gewitterrisiko'], ['foehn', 'Föhn'], ['bise', 'Bise']]) {
    const hit = day.find(h => h[k] === 'danger') || day.find(h => h[k] === 'warn');
    if (hit) parts.push(k === 'bise' ? `Bise ab ${hit.h} Uhr (${hit.bise === 'danger' ? 'stark: Lee-Hänge am Thuner- und Brienzersee meiden' : 'Vorsicht'})` : `${name} ab ${hit.h} Uhr (${hit[k] === 'danger' ? 'K.-o.' : 'Vorsicht'})`);
  }
  const up = day.filter(h => h.up800 && h.up800[0] >= 40);
  if (up.length) parts.push(`Höhenwind bis ${Math.max(...up.map(h => h.up800[0]))} km/h auf 2000 m`);
  if (!parts.length) return 'Keine K.-o.-Faktoren in der Region. Kaltfront, Gewitter, Föhn und Bise sind unauffällig.';
  return parts.join('. ') + '.';
}
const LVL_SYM = { ok: '✓', warn: '!', danger: '✕' };
const LVL_TXT = { ok: 'unauffällig', warn: 'Vorsicht', danger: 'K.-o.' };
function renderLage() {
  const el = $('#v-lage');
  if (!S.plan) { el.innerHTML = stateBox(); return; }
  const p = S.plan, day = p.region.days[S.day];
  // Breiter Bildschirm: jede Stunde. Tablet: alle 2 Stunden. Handy: alle 3 Stunden, damit die Tabelle ohne Wischen passt.
  const phone = !matchMedia('(min-width: 560px)').matches;
  const step = matchMedia('(min-width: 900px)').matches ? 1 : phone ? 3 : 2;
  const hrs = (day?.hours || []).filter(h => h.h >= 7 && h.h <= 20 && (h.h - 7) % step === 0);
  const nowH = nowHourToday();
  const lc = (lvl, tip) => `<div class="bc ${lvl}" title="${esc(tip || LVL_TXT[lvl])}" aria-label="${LVL_TXT[lvl]}${tip ? ': ' + esc(tip) : ''}">${LVL_SYM[lvl]}</div>`;
  const wc = (w, lim) => (w ? `<div class="bc ${w[0] >= lim ? 'warn' : 'ok'}" aria-label="${w[0]} km/h aus ${dirLabel(w[1])}">${w[0]}<span style="margin-left:2px">${arrow(w[1])}</span></div>` : '<div class="bc mut">–</div>');
  // [Name, Zelle, auffällig?(Stunde), immer zeigen]: in der Übersicht nur, was heute zählt; alles unter «Für Profis»
  const rows = [
    ['Urteil', h => `<div class="bc v s-${cls(h.v)}" aria-label="Regionsurteil ${h.v}">${h.v}</div>`, null, true],
    ['Kaltfront', h => lc(h.front, h.frontWhy?.[0]), h => h.front !== 'ok'],
    ['Gewitter', h => lc(h.storm, `CAPE ${h.cape} J/kg, Regen ${h.pop} %`), h => h.storm !== 'ok'],
    ['Föhn', h => lc(h.foehn), h => h.foehn !== 'ok'],
    ['Bise', h => lc(h.bise || 'ok', h.biseWhy?.[0]), h => h.bise && h.bise !== 'ok'],
    [phone ? 'Föhn hPa' : 'Föhndruck hPa', h => (num(h.dp) ? `<div class="bc ${h.dp >= 8 ? 'danger' : h.dp >= 4 ? 'warn' : 'mut'}" aria-label="Druck Lugano minus Zürich ${h.dp} hPa">${h.dp > 0 ? '+' : ''}${h.dp.toFixed(1)}</div>` : '<div class="bc mut">–</div>'), h => h.dp >= 4],
    [phone ? 'Bise hPa' : 'Bisedruck hPa', h => (num(h.bdp) ? `<div class="bc ${h.bdp >= 4 ? 'danger' : h.bdp >= 2 ? 'warn' : 'mut'}" aria-label="Druck Zürich minus Genf ${h.bdp} hPa">${h.bdp > 0 ? '+' : ''}${h.bdp.toFixed(1)}</div>` : '<div class="bc mut">–</div>'), h => h.bdp >= 2],
    [phone ? 'Wind 2000' : 'Wind 2000 m', h => wc(h.up800, 40), h => h.up800?.[0] >= 40],
    [phone ? 'Wind 3000' : 'Wind 3000 m', h => wc(h.up700, 60), h => h.up700?.[0] >= 60],
    [phone ? 'Basis km' : 'Basis in km', h => (num(h.cb) ? `<div class="bc mut" aria-label="Basis ${h.cb} m">${(h.cb / 1000).toFixed(1)}</div>` : '<div class="bc mut">–</div>'), null, true],
    [phone ? 'Thermik km' : 'Thermik bis km', h => (num(h.top) ? `<div class="bc mut" aria-label="Thermik bis ${h.top} m${h.inv ? ', Inversion ab ' + h.inv + ' m' : ''}">${(h.top / 1000).toFixed(1)}</div>` : '<div class="bc mut">–</div>'), null, true],
    ['Thermik', h => `<div class="bc mut" aria-label="Thermikindex ${h.therm}">${h.therm >= 60 ? '●●●' : h.therm >= 30 ? '●●○' : h.therm > 8 ? '●○○' : '○○○'}</div>`, null, true]
  ];
  const short = rows.filter(([, , flag, always]) => always || hrs.some(flag));
  const quiet = [...new Set(rows.filter(r => !short.includes(r) && !/hPa$/.test(r[0])).map(r => r[0].replace(/^Wind (\d+).*/, 'Höhenwind $1 m')))];
  const table = list => `<div class="gridwrap" tabindex="0" role="region" aria-label="Briefing-Raster, seitlich scrollbar"><table class="brief">
      <thead><tr><th class="rl" scope="col">Uhr</th>${hrs.map(h => `<th scope="col">${h.h === nowH ? 'jetzt' : h.h}</th>`).join('')}</tr></thead>
      <tbody>${list.map(([name, f]) => `<tr><th class="rl" scope="row">${name}</th>${hrs.map(h => `<td>${f(h)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
  const whyAll = [];
  for (const h of day?.hours || []) for (const w of h.frontWhy || []) if (!whyAll.includes(w)) whyAll.push(w);
  const nowS = p.region.now;
  el.innerHTML = `
    <div class="headline ${p.days[S.day].regionStatus === 'danger' ? 'danger' : p.days[S.day].regionStatus === 'warn' ? 'warn' : 'ok'}">
      <h2>Lage ${isToday() ? 'heute' : dayName(S.day) === 'Morgen' ? 'morgen' : 'am ' + dayName(S.day)}</h2>
      <p>${esc(regionSummary(S.day))}</p>
    </div>
    ${table(short)}
    ${quiet.length ? `<p class="fine lage-quiet">Unauffällig: ${esc(quiet.join(', '))}.</p>` : ''}
    <details class="pro-more" data-k="lageOpen" ${store.get('lageOpen') ? 'open' : ''}><summary>Für Profis: alle Werte Stunde für Stunde</summary>
    ${table(rows)}
    <div class="legend"><span><i style="background:var(--wait)"></i>Vorsicht</span><span><i style="background:var(--no)"></i>K.-o. (Kaltfront, Gewitter, Föhn; starke Bise an Lee-Hängen)</span><span>Höhenwind färbt nur leicht: er verschlechtert, verbietet aber nichts.</span></div>
    <p class="fine" style="margin:4px 0 0">Föhndruck = Luftdruck Lugano minus Zürich (Prognose): ab +4 hPa Föhn möglich, ab +8 hPa Föhn. Bisedruck = Zürich minus Genf: ab +2 hPa Bise, ab +4 hPa starke Bise.</p>
    </details>
    ${whyAll.length ? `<div class="panel" style="margin-top:12px"><h3>Warum die Frontwarnung?</h3><ul class="why">${whyAll.map(w => `<li>${esc(w)}</li>`).join('')}</ul><p class="fine">Eine Warnung braucht mindestens zwei Signale (Druck, Windsprung, Temperatursturz, Schauer).</p></div>` : ''}
    ${isToday() && nowS ? `<div class="panel" style="margin-top:12px"><h3>Jetzt gemessen</h3><div class="kv">
      <div><b>${nowS.foehnScore}</b><span>Föhn-Signal${nowS.foehn !== 'ok' ? ' (' + LVL_TXT[nowS.foehn] + ')' : ''}</span></div>
      <div><b>${nowS.bise}</b><span>Bise im Vorland</span></div>
      ${num(nowS.dpFoehn) ? `<div class="${nowS.dpFoehn >= 8 ? 'kv-bad' : nowS.dpFoehn >= 4 ? 'kv-warn' : ''}"><b>${nowS.dpFoehn > 0 ? '+' : ''}${nowS.dpFoehn.toFixed(1)} hPa</b><span>Föhndruck Lugano–Kloten</span></div>` : ''}
      ${num(nowS.dpBise) ? `<div class="${nowS.dpBise >= 4 ? 'kv-bad' : nowS.dpBise >= 2 ? 'kv-warn' : ''}"><b>${nowS.dpBise > 0 ? '+' : ''}${nowS.dpBise.toFixed(1)} hPa</b><span>Bisedruck Kloten–Genf</span></div>` : ''}
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
/** Messwerte als Karten: nahe deinen Favoriten (sonst bei dir, sonst die hohen Stationen) zuerst, starker Wind farbig. */
const WIND_LIM = { careful: [22, 30], normal: [25, 35], expert: [30, 40] };
function stationCards(list) {
  if (!list.length) return '<div class="empty">Keine aktuellen Messwerte. Wetterstationen liefern derzeit keine Daten.</div>';
  const favs = [...S.fav].map(siteById).filter(Boolean);
  const ref = favs.length ? favs : S.pos ? [{ lat: S.pos[0], lon: S.pos[1], name: 'dir' }] : null;
  const near = x => {
    if (!ref || !num(x.lat)) return null;
    let best = null;
    for (const r of ref) { const d = haversineKm(x.lat, x.lon, r.lat, r.lon); if (!best || d < best.d) best = { d, r }; }
    return best;
  };
  const rows = list.map(x => ({ x, n: near(x) }));
  rows.sort((a, b) => (a.n && b.n ? a.n.d - b.n.d : (b.x.alt ?? 0) - (a.x.alt ?? 0)));
  const [warn, bad] = WIND_LIM[S.level] || WIND_LIM.normal;
  const how = favs.length ? 'Nächste zu deinen Favoriten zuerst' : S.pos ? 'Nächste zu dir zuerst' : 'Hohe Stationen zuerst';
  const card = ({ x, n }) => {
      const g = num(x.gust) ? Math.round(x.gust) : null, w = num(x.wind) ? Math.round(x.wind) : null, top = Math.max(g ?? 0, w ?? 0);
      const age = ageMin(x.time, x.age), lvl = top >= bad ? 'bad' : top >= warn ? 'warn' : 'ok', old = age > 40;
      return `<div class="stc stc-${lvl}${old ? ' old' : ''}"><div class="stc-h"><b>${esc(x.name)}</b><span>${x.alt ?? '–'} m${n && n.r.name !== 'dir' ? ` · ${Math.round(n.d)} km zu ${esc(n.r.name.split(' ')[0])}` : n ? ` · ${Math.round(n.d)} km` : ''}</span></div>
        <div class="stc-v"><span class="stc-w"><b>${w ?? '–'}</b><small>Wind</small></span><span class="stc-w"><b>${g ?? '–'}</b><small>Böen</small></span><span class="stc-d">${num(x.dir) ? arrow(x.dir) + ' ' + dirLabel(x.dir) : '–'}</span></div>
        <div class="stc-f">${num(x.temp) ? x.temp.toFixed(1) + '° · ' : ''}${old ? '<b>' + ageTxt(age) + '</b>' : ageTxt(age)}</div></div>`;
  };
  const first = rows.slice(0, 6), rest = rows.slice(6);
  return `<p class="fine" style="margin:0 0 8px">${how}. Farbig ab Böen ${warn} km/h, rot ab ${bad} km/h.</p>
    <div class="stc-grid">${first.map(card).join('')}</div>
    ${rest.length ? `<details class="stc-more"><summary>Alle ${rows.length} Stationen zeigen</summary><div class="stc-grid">${rest.map(card).join('')}</div></details>` : ''}
    <p class="fine">Wind in km/h, 10-Minuten-Mittel der MeteoSchweiz (SwissMetNet).</p>`;
}
function renderDay() {
  const el = $('#v-day');
  const key = 'check.' + todayKey();
  const done = store.get(key, []);
  const st = S.plan?.stations || [];
  const q = S.plan?.quality?.stations || [];
  const n = done.length, all = n >= CHECKS.length;
  el.innerHTML = `
    ${dayAskHtml()}
    <div class="panel"><h3>Messwerte jetzt</h3>
      ${stationCards(st)}
    </div>
    <details class="panel chk-box" ${all ? '' : 'open'}><summary><span class="chk-h"><b>Vor dem Start</b><span class="chk-n${all ? ' ok' : ''}">${all ? '✓ alles erledigt' : `${n} von ${CHECKS.length}`}</span></span><span class="chk-bar" aria-hidden="true"><i style="width:${Math.round(n / CHECKS.length * 100)}%"></i></span></summary>
      ${CHECKS.map((c, i) => `<label class="chk"><input type="checkbox" data-act="check" data-i="${i}" ${done.includes(i) ? 'checked' : ''}><span>${esc(c)}</span></label>`).join('')}
      <p class="fine">Die Liste gilt für heute und wird morgen zurückgesetzt. <a href="https://www.skybriefing.com/" target="_blank" rel="noopener">Skybriefing</a> · <a href="https://map.geo.admin.ch/" target="_blank" rel="noopener">Karte des Bundes</a></p>
    </details>
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
  if (S.tab === 'profile') refreshStatus();
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
/** Was AFC an den Bergstationen selbst gelernt hat (Böenfehler der letzten 14 Tage). */
const LEARN_WHEN = k => { const [b, sec] = k.split('|'); return `${{ am: 'Vormittag', mid: 'Mittag', pm: 'Nachmittag' }[b] || ''}${sec === 'ruhig' ? ', wenig Wind' : sec ? ', ' + sec + '-Wind' : ''}`; };
const sgn = v => (v > 0 ? '+' : '') + v;
function thermalHtml(t) {
  const list = Object.entries(t || {});
  const areaName = id => S.plan?.areas?.find(a => a.id === id)?.name || id;
  const climb = c => (c && c.factor !== 1 ? `, Steigen <b>×${c.factor.toFixed(2)}</b> (${c.n} Flüge)` : c?.n ? `, Steigen: ${c.n} Flüge, noch keine sichere Korrektur` : '');
  return `<div style="margin-top:12px"><b>Aus IGC-Flügen gelernt</b> <span class="fine">Thermik-Obergrenze und Steigen gegen die Prognose zur Flugzeit, je Gebiet ab 3 Flügen. Übernommen wird nur, was die bisherigen Flüge besser erklärt hätte.</span>
    ${list.length ? `<ul class="fine" style="margin:4px 0 0;padding-left:18px">${list.map(([a, x]) => `<li>${esc(areaName(a))}: ${x.add ? `<b>${x.add > 0 ? '+' : ''}${x.add} m</b>, ` : ''}${esc(x.why)}${climb(x.climb)}</li>`).join('')}</ul>` : '<p class="fine" style="margin:4px 0 0">Noch keine IGC-Flüge mit Thermik, für die AFC die Prognose kennt. Ab jetzt merkt sich AFC die Prognose jeder Stunde, damit neue Flüge verglichen werden können.</p>'}</div>`;
}
function pressureHtml(p, models, bf) {
  if (!p) return '';
  const dd = d => { const [, m, t] = d.split('-'); return `${+t}.${+m}.`; };
  const ev = (xs, w) => xs?.length ? `${w} an ${xs.length} ${xs.length === 1 ? 'Tag' : 'Tagen'} (${xs.slice(-6).map(x => dd(x.day)).join(', ')}${xs.length > 6 ? ' …' : ''})` : `kein ${w}`;
  const back = bf?.ok ? `<p class="fine" style="margin:6px 0 0">Nachgelernt aus den letzten ${bf.days} Tagen (Messungen der MeteoSchweiz und Prognose-Archiv, Stand ${new Date(bf.at).toLocaleDateString('de-CH')}): ${ev(bf.bise, 'Bise')}, ${ev(bf.foehn, 'Föhn')}.</p>` : '';
  const row = (name, x) => x ? `<li><b>${name}</b>: ${x.n ? `${x.days} Tage verglichen` : 'noch keine Daten'}${x.bias ? ` · Druckunterschied ${sgn(x.bias)} hPa korrigiert` : ''} · Warngrenze ${x.warn} hPa${x.warn < x.defaultWarn ? ` (statt ${x.defaultWarn}, ${esc(x.why)})` : ''}</li>` : '';
  const ms = (models || []).filter(m => m.n);
  return `<div style="margin-top:12px"><b>Föhn, Bise und Wettermodell</b> <span class="fine">Jede Stunde vergleicht AFC den prognostizierten Druckunterschied mit dem gemessenen und prüft, ob Föhn oder Bise unter der Warngrenze kam. Grenzen werden nur gesenkt, nie automatisch angehoben.</span>
    <ul class="fine" style="margin:4px 0 0;padding-left:18px">${row('Föhn (Lugano–Kloten)', p.foehn)}${row('Bise (Kloten–Genf)', p.bise)}</ul>${back}
    ${ms.length ? `<p class="fine" style="margin:6px 0 0">ICON gegen ECMWF (Böen, Fehler in km/h): ${ms.map(m => `${esc(m.name)} ${m.maeIcon} / ${m.maeEc}${m.weight ? ` → ECMWF zählt ${Math.round(m.weight * 100)} %` : ''}`).join(' · ')}</p>` : '<p class="fine" style="margin:6px 0 0">Modellvergleich: sammelt noch Daten.</p>'}</div>`;
}
function siteFbHtml(f) {
  if (!f) return '';
  return `<div style="margin-top:12px"><b>Aus Rückmeldungen gelernt</b> <span class="fine">Urteile nach Flügen, Flüge ohne Urteil (halb) und «nicht gestartet» je Startplatz, jüngere zählen mehr. «Zu streng» gilt nur für die eigene und erfahrenere Stufen.</span>
    ${f.sites.length ? `<ul class="fine" style="margin:4px 0 0;padding-left:18px">${f.sites.map(x => `<li>${esc(x.name)}: <b>${sgn(x.adj)} Punkte</b> · ${x.n} Rückmeldungen${x.implicit ? ` (${x.implicit} ohne Urteil)` : ''}</li>`).join('')}</ul>`
      : `<p class="fine" style="margin:4px 0 0">${f.records ? `${f.records} Rückmeldungen an ${f.collecting} Startplätzen, noch keine Anpassung (ab 3 je Platz).` : 'Noch keine Rückmeldungen nach Flügen.'}</p>`}</div>`;
}
function learnedHtml(list, guard) {
  if (!list) return '';
  const r = guard?.runs, pc = x => (x?.n ? Math.round(x.passt / x.n * 100) + ' %' : '–');
  const runs = r ? `<p class="fine" style="margin:4px 0 0">Rückblick-Test vom ${new Date(guard.at).toLocaleDateString('de-CH')}: ohne Lernen ${pc(r.ohne)} passt, ${r.ohne?.gefaehrlich ?? '–'} gefährlich · nur Einfaches ${pc(r.einfach)}, ${r.einfach?.gefaehrlich ?? '–'} · alles ${pc(r.voll)}, ${r.voll?.gefaehrlich ?? '–'}.</p>` : '';
  const head = guard?.off || guard?.mode === 'off'
    ? `<b>Selbst gelernt: pausiert</b><p class="fine" style="margin:4px 0 0">Der Rückblick-Test war ohne das Gelernte besser (${esc(guard.reason || '')}). AFC rechnet vorerst ohne und prüft nächste Woche wieder.</p>`
    : guard?.mode === 'simple' ? `<b>Selbst gelernt: nur das Einfache aktiv</b><p class="fine" style="margin:4px 0 0">Die Details nach Tageszeit und Wind hat der Rückblick-Test nicht bestätigt. AFC nutzt nur das Mittel je Station und hebt Böen nur an.</p>`
    : `<b>Selbst gelernt aus Messwerten</b> <span class="fine">Jede Stunde vergleicht AFC die Prognose mit den Messstationen. Je Station lernt es, wie stark die Böen danebenliegen, auch nach Tageszeit und Windrichtung. Übernommen wird nur, was Tag für Tag besser getroffen hätte.</span>`;
  const used = list.filter(x => x.used), wait = list.filter(x => !x.used);
  const maxN = list.length ? Math.max(...list.map(x => x.n)) : 0;
  return `<div style="margin-top:12px">${head}
    ${used.length ? `<ul class="fine" style="margin:4px 0 0;padding-left:18px">${used.map(x => `<li><b>${esc(x.name)}</b>${num(x.alt) ? ` (${x.alt} m)` : ''}: ${x.mode !== 'none' ? `Böenfehler ${x.mae0} → ${x.mae} km/h, im Mittel ${sgn(x.gust)}` : 'Böen ohne Korrektur'}${x.top?.length ? ' · ' + x.top.map(t => `${esc(LEARN_WHEN(t.k))} ${sgn(t.gust)}`).join(', ') : ''}${x.windMode !== 'none' ? ` · Grundwind ${x.windMae0} → ${x.windMae} km/h, im Mittel ${sgn(x.wind)}` : ''}</li>`).join('')}</ul>` : ''}
    <p class="fine" style="margin:4px 0 0">${used.length ? `${used.length} Stationen mit Korrektur, ${wait.length} ohne (zu wenig Daten oder Prognose dort schon gut).` : `Sammelt noch Daten (${maxN} von 30 Stunden je Station). Wird mit jedem Tag genauer.`} Bergstationen korrigieren Böen und Grundwind am Start, Talstationen den Talwind an der Landung. Mehr Grundwind zählt nur, wenn es die Bewertung verschlechtert.</p>
    ${runs}</div>`;
}

/** Ergebnis des automatischen Rückblick-Tests (wöchentlich nachts, letzte 14 Tage). */
function backtestHtml(b) {
  if (!b) return '';
  const L = b.last, P = b.prev;
  const pc = x => (x?.n ? Math.round(x.passt / x.n * 100) : null);
  const dd = d => d.split('-').reverse().join('.');
  const trend = L && P && pc(P) !== null ? ` <span class="fine">(vorher ${pc(P)} %, ${P.gefaehrlich} gefährlich)</span>` : '';
  const body = L ? `<b>${dd(L.from)} bis ${dd(L.to)}: ${pc(L)} % passt · ${L.gefaehrlich} gefährlich · ${L.zuStreng} zu streng</b>${trend}
      ${L.berg ? `<p class="fine" style="margin:4px 0 0">Am Berg: ${L.berg.gefaehrlich} gefährlich, ${L.berg.zuMild} zu mild, ${L.berg.zuStreng} zu streng${num(L.berg.gustBias) ? ` · Böen-Prognose im Schnitt ${L.berg.gustBias > 0 ? '+' : ''}${L.berg.gustBias} km/h` : ''}</p>` : ''}
      ${L.faelle?.length ? `<p class="fine" style="margin:4px 0 0"><b>Gefährliche Fälle:</b> ${L.faelle.map(esc).join(' · ')}</p>` : ''}
      <p class="fine" style="margin:4px 0 0">Gerechnet am ${new Date(L.at).toLocaleDateString('de-CH')}. Details in data/${esc(L.datei || '')}.</p>`
    : '<p class="fine" style="margin:0">Noch kein Lauf.</p>';
  return `<div style="margin-top:12px"><b>Rückblick-Test</b> <span class="fine">${b.auto ? 'läuft jede Woche nachts automatisch (letzte 14 Tage)' : 'automatischer Lauf aus'}</span>
    <div style="margin-top:4px">${b.running ? '<p class="fine" style="margin:0">Läuft gerade …</p>' : body}${b.error ? `<p class="fine" style="margin:4px 0 0">Letzter Versuch: ${esc(b.error)}</p>` : ''}</div>
    ${b.running ? '' : '<div class="btn-row" style="justify-content:flex-start;margin-top:6px"><button class="btn sec" type="button" data-act="btrun">Jetzt prüfen</button></div>'}</div>`;
}

function statusHtml() {
  const d = ST.data;
  if (!d) return '<p class="fine" style="margin:0">Wird geladen …</p>';
  if (d.admin === false) return `<div><b>AFC ${esc(d.version)}</b> <span class="fine">App ${APP_VER}. Updates spielt Lars auf seinem Mac ein, die App lädt sie danach von selbst.</span></div>`;
  const u = d.update;
  const upd = !u?.enabled ? 'Keine Git-Kopie: Update-Prüfung aus.'
    : u.error ? `Letzte Prüfung fehlgeschlagen (${esc(u.error)}).`
    : u.available ? `Neue Version verfügbar, automatische Tests bestanden. ${esc(updText(u))}`
    : u.waiting ? `${esc(updText(u))}. ${esc(u.waiting)}`
    : u.checkedAt ? `Aktuell (geprüft ${timeOf(u.checkedAt)} Uhr).` : 'Noch nicht geprüft.';
  const probs = d.problems?.length ? `<div class="lb-alert due" role="status" style="margin-bottom:12px">${d.problems.map(x => `<div><b>${esc(x.title.replace(/^AFC: /, ''))}:</b> ${esc(x.body)}</div>`).join('')}</div>` : '';
  const aw = d.awake?.enabled ? `<p class="fine" style="margin:6px 0 0">Mac wach halten: ${d.awake.active ? `aktiv bis ${timeOf(d.awake.until)} Uhr` : d.awake.error ? 'hat nicht geklappt (' + esc(d.awake.error) + ')' : 'nachts aus, ab 6 Uhr wieder aktiv'}. Zugeklappt schläft ein MacBook trotzdem.</p>` : '';
  return `${probs}<div><b>AFC ${esc(d.version)}</b> <span class="fine">${upd}</span>
      ${aw}
      <div class="btn-row" style="justify-content:flex-start;margin-top:6px">${u?.available && u.canApply ? `<button class="btn" type="button" data-act="update" ${ST.busy ? 'disabled' : ''}>Jetzt aktualisieren</button>` : ''}${u?.enabled ? '<button class="btn sec" type="button" data-act="updcheck">Nach Updates suchen</button>' : ''}</div></div>`;
}
/** Technischer Teil: Open-Meteo-Verbrauch, was AFC gelernt hat, Rückblick-Test. */
function techHtml() {
  const d = ST.data;
  if (!d) return '<p class="fine" style="margin:0">Wird geladen …</p>';
  const o = d.openMeteo;
  if (!o) return `${learnedHtml(d.learned, d.learnGuard)}${pressureHtml(d.pressure, d.models, d.backfill)}${siteFbHtml(d.siteFeedback)}${thermalHtml(d.thermal)}`;
  const pct = Math.min(100, Math.round(o.calls / o.limitDay * 100));
  return `<div><b>Open-Meteo heute: ${o.calls.toLocaleString('de-CH')} von ${o.limitDay.toLocaleString('de-CH')} Gratis-Aufrufen</b> <span class="fine">(${pct} %, letzte Stunde ${o.lastHour.toLocaleString('de-CH')})</span>
      <div class="usage-bar" aria-hidden="true"><span style="width:${pct}%;${pct >= 80 ? 'background:var(--no)' : ''}"></span></div>
      <p class="fine" style="margin:6px 0 0">Open-Meteo zählt je Ort und je 10 Wettergrössen einen Aufruf. Der Zähler beginnt um ${new Date(Date.parse(o.day + 'T00:00:00Z')).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })} Uhr neu.${pct >= 80 ? ' <b>Achtung: nahe am Tageslimit.</b>' : ''}</p></div>
    ${learnedHtml(d.learned, d.learnGuard)}
    ${pressureHtml(d.pressure, d.models, d.backfill)}
    ${siteFbHtml(d.siteFeedback)}
    ${thermalHtml(d.thermal)}
    ${backtestHtml(d.backtest)}`;
}
function refreshStatus() {
  const a = $('#statusPanel'), b = $('#techPanel');
  if (a) a.innerHTML = statusHtml();
  if (b) b.innerHTML = techHtml();
}
function renderProfile() {
  const el = $('#v-profile');
  const log = store.get('log', []);
  const favs = [...S.fav].map(id => S.plan && siteById(id)).filter(Boolean);
  el.innerHTML = `
    ${pilotCard()}
    ${surveyCard()}
    ${testPanel()}
    <h2 class="prof-h">Mein Fliegen</h2>
    ${pilotPanel()}
    <div class="panel"><h3>Favoriten</h3>
      ${favs.length ? favs.map(s => `<div class="srow" style="padding-left:0;padding-right:0"><button type="button" class="srow-main" data-act="site" data-id="${esc(s.id)}"><span class="srow-name">${esc(s.name)}</span><span class="srow-sub">${s.alt} m · ${esc(aspectText(s))}</span></button>${starBtn(s.id)}</div>`).join('') : '<p class="fine" style="margin:0">Noch keine Favoriten. Tippe in der Startplatz-Ansicht auf den Stern.</p>'}</div>
    <h2 class="prof-h">App</h2>
    <div class="panel"><h3>Benachrichtigungen</h3><div id="pushPanel">${pushHtml()}</div></div>
    <div class="panel"><h3>AFC und Updates</h3><div id="statusPanel">${statusHtml()}</div></div>
    <div class="panel"><h3>Darstellung</h3>
      <div class="seg" role="group" aria-label="Darstellung">${[['auto', 'Automatisch'], ['light', 'Hell'], ['dark', 'Dunkel'], ['sun', 'Sonne']].map(([k, n]) => `<button type="button" data-act="theme" data-v="${k}" aria-pressed="${S.theme === k}">${n}</button>`).join('')}</div>
      <p class="fine">«Sonne»: grössere Schrift und starker Kontrast, gut lesbar draussen am Startplatz. Schnell ein- und ausschalten mit dem Sonnen-Knopf oben.</p></div>
    <div class="panel"><h3>Hilfe</h3><div class="btn-row" style="justify-content:flex-start;flex-wrap:wrap"><button class="btn sec" type="button" data-act="intro">Einführung nochmals ansehen</button>${ME.user ? '<button class="btn sec" type="button" data-act="feedback">Rückmeldung an Lars</button>' : ''}</div></div>
    ${accountPanel()}
    <details class="prof-tech" ${S.techOpen ? 'open' : ''}><summary><span class="prof-h">Technik und Daten</span><span class="fine">Verbrauch, was AFC gelernt hat, Datenquellen, Datenschutz</span></summary>
    <div class="panel"><h3>Verbrauch und Lernen</h3><div id="techPanel">${techHtml()}</div></div>
    <div class="panel"><h3>Datenquellen</h3>${sourcesHtml()}</div>
    <div class="panel"><h3>Gemeldete Flüge und AFC-Score</h3>
      ${flightCheck(log)}
      ${log.length ? `<div class="tw"><table class="plain"><thead><tr><th>Datum</th><th>Startplatz</th><th>Flug</th><th>Score</th><th></th></tr></thead><tbody>${log.slice().reverse().map((r, i) => `<tr><td>${new Date(r.launchTime).toLocaleDateString('de-CH')}</td><td>${esc(r.name)}</td><td>${r.launched ? '★'.repeat(r.quality) : 'nicht geflogen'}</td><td>${num(r.afcScore) ? r.afcScore : '–'}${flightMatch(r) && flightMatch(r) !== 'passt' ? ` <span class="fine" title="${flightMatch(r)}">(${flightMatch(r)})</span>` : ''}</td><td><button type="button" class="star" data-act="logdel" data-i="${log.length - 1 - i}" aria-label="Eintrag entfernen">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="fine" style="margin:0">Noch keine Einträge. Nach einem Flug über die Startplatz-Ansicht melden.</p>'}
      <p class="fine">Gemeldete Flüge werden anonym gespeichert (ohne Namen, mit zufälliger Gerätekennung).</p></div>
    <div class="panel"><h3>Datenschutz</h3>
      <div class="btn-row" style="justify-content:flex-start"><button class="btn sec" type="button" data-act="export">Meine Daten exportieren</button><button class="btn sec" type="button" data-act="wipe">Meine Daten löschen</button><a class="btn sec" href="/privacy">Datenschutzerklärung</a></div></div>
    </details>
    <p class="fine">AFC ${esc(S.plan?.version || '8.0')} · ${S.plan?.siteCount ?? ''} Startplätze (DHV-Geländedatenbank) · Prognose: MeteoSchweiz, DWD, ECMWF über Open-Meteo · Messwerte: MeteoSchweiz · Karte: swisstopo. Keine Gewähr. Der Startentscheid liegt immer bei der Pilotin oder beim Piloten.</p>`;
  el.querySelector('.prof-tech')?.addEventListener('toggle', e => { S.techOpen = e.target.open; });
  if (isAdminMe() && !ADM.data && !ADM.req) ADM.req = adminLoad().then(() => { if (S.tab === 'profile') renderProfile(); }).catch(() => {}).finally(() => { ADM.req = null; });
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
/**
 * Flüge aus dem Pilotenprofil ins Flugbuch übernehmen: Wer im Profil mehr Flüge angibt, als das Flugbuch kennt,
 * hat die übrigen vor dem Flugbuch gemacht. Sonst zeigt das Flugbuch «0 Flüge», obwohl im Profil 150 stehen.
 */
async function lbAlignBefore(quiet = true) {
  const d = LB.data, pr = store.get('pilot', {});
  if (!d || !num(pr.flights)) return false;
  const total = (d.settings.flightsBefore || 0) + d.flights.length;
  if (pr.flights <= total) return false;
  try { await lbSave('settings', { ...d.settings, flightsBefore: pr.flights - d.flights.length }, quiet); return true; } catch { return false; }
}
/** Pilotenprofil aus dem Flugbuch nachführen (Flüge, Stunden, letzter Flug, Schirmklasse). */
function lbSyncProfile() {
  const d = LB.data, p = d && LG()?.profileFromLog(d.flights, d.settings);
  if (!p) return;
  // Ein noch unvollständiges Flugbuch darf die Erfahrung nicht senken (3 importierte Flüge ≠ 3 Flüge im Jahr)
  const prev = store.get('pilot', {});
  const pr = { ...prev, ...p, flights: Math.max(p.flights, prev.flights || 0), hours12: Math.max(p.hours12, prev.hours12 || 0) };
  if (prev.lastFlight && (!p.lastFlight || prev.lastFlight > p.lastFlight)) pr.lastFlight = prev.lastFlight;
  const g = d.gear.find(x => x.id === d.settings.defaults?.glider);
  const cls = g?.cert?.toUpperCase().match(/\b(?:EN[- ]?)?([A-D])\b|CCC/);
  if (cls) pr.glider = cls[1] || 'D';
  store.set('pilot', pr);
  const pl = P()?.pilotLevel(pr);
  if (pl && !store.get('levelManual') && pl.level !== S.level) {
    S.level = pl.level; store.set('level', S.level); S.detail.clear(); loadPlan();
    // nicht still umstellen: sagen, warum (änderbar unter Profil)
    toast(`Erfahrung jetzt «${LEVEL_INFO[S.level][0]}»: ${pl.why.at(-1)}. Änderbar unter Profil.`);
  }
}
const ddmm = d => d.slice(8, 10) + '.' + d.slice(5, 7) + '.';
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
/** AFC-Wert eines Startplatzes an einem Tag zur Startzeit (oder bestes Fenster), solange der Plan den Tag kennt. */
function afcScoreAt(siteId, date, start) {
  const p = S.plan, d = p?.dates?.indexOf(date) ?? -1, site = siteId && p?.sites?.find(x => x.id === siteId);
  if (!site || d < 0) return null;
  const day = site.days?.[d], h = start ? Number(start.slice(0, 2)) : NaN;
  const at = Number.isFinite(h) ? day?.scores?.[h - (p.h0 ?? 6)] : null;
  return num(at) ? at : day?.best?.score ?? null;
}
/** Prognose zur Startzeit festhalten (Wind, Thermik, Basis, Fenster), solange AFC den Tag kennt. Für den Rückblick. */
async function afcFcAt(siteId, date, start) {
  if (!siteId || !S.plan?.dates?.includes(date) || !siteById(siteId)) return null;
  try {
    const d = await loadDetail(siteId), day = d.days.find(x => x.date === date);
    if (!day || d._savedAt) return null;
    const h = start ? Number(start.slice(0, 2)) : day.best?.peak;
    const hr = day.hours.find(x => x.h === h) || day.hours.find(x => x.h === day.best?.peak);
    if (!hr) return null;
    return { h: hr.h, score: hr.score, speed: hr.speed, gust: hr.gust, dir: hr.dir, top: hr.thermalTop, base: hr.cloudBase, wstar: hr.wstar, valley: hr.valley?.[0] ?? null, from: day.best ? Number(String(day.best.from).slice(0, 2)) : null, to: day.best ? Number(String(day.best.to).slice(0, 2)) : null };
  } catch { return null; }
}
/** Rückblick-Karte im Flug: was AFC sagte und wie es war. */
function reviewHtml(f) {
  const fc = f.afcFc;
  if (!fc) return '';
  const rv = LG().flightReview(f);
  const sym = { ok: '✓', more: '↑', less: '↓' };
  return `<div class="fld lb-wide rv"><span>Rückblick: Prognose gegen Flug</span>
    <p class="fine" style="margin:0 0 6px">AFC sagte für ${fc.h}–${fc.h + 1} Uhr: Score ${fc.score ?? '–'}, Wind ${fc.speed ?? '–'} km/h${num(fc.dir) ? ' aus ' + dirLabel(fc.dir) : ''}, Böen ${fc.gust ?? '–'}${num(fc.top) ? ', Thermik bis ' + fc.top + ' m' : ''}${num(fc.base) ? ', Basis ' + fc.base + ' m' : ''}.</p>
    ${rv.length ? `<div class="rv-list">${rv.map(x => `<div class="rv-row rv-${x.lvl}"><span class="rv-i" aria-hidden="true">${sym[x.lvl]}</span><span><b>${esc(x.k)}</b><small>Prognose ${esc(x.fc)} · Flug ${esc(x.real)}</small></span><span class="rv-n">${esc(x.note)}</span></div>`).join('')}</div>` : '<p class="fine" style="margin:0">Mit einer IGC-Datei (z.B. aus FlySkyHy) vergleicht AFC auch Thermikhöhe und Steigen.</p>'}
    <p class="fine" style="margin:6px 0 0">Stimmt das mit deinem Gefühl? Gleich darunter bei «AFC-Bewertung» sagen, ob AFC richtig, zu streng oder zu mild war.</p></div>`;
}
/** Neuester Flug der letzten 14 Tage an einem bekannten Startplatz ohne Rückmeldung. */
function feedbackDue() {
  const d = LB.data;
  if (!d) return null;
  const from = new Date(Date.now() - 14 * 86400000).toLocaleDateString('sv-SE'), skip = store.get('fbSkip', []);
  return d.flights.find(f => f.siteId && f.date >= from && !f.afcVerdict && !skip.includes(f.id)) || null;
}
const rerender = () => { if (S.tab === 'book') renderBook(); else if (S.tab === 'decide') renderDecide(); };
function feedbackHtml() {
  const f = feedbackDue(), L = LG();
  if (!f || !L) return '';
  const when = f.date === todayKey() ? 'heute' : f.date === new Date(Date.now() - 86400000).toLocaleDateString('sv-SE') ? 'gestern' : 'am ' + ddmm(f.date);
  return `<div class="lb-ask" role="region" aria-label="Rückmeldung zum Flug">
    <div><b>Wie lag AFC bei deinem Flug?</b> <span class="fine">${esc(f.siteName || '')}, ${when}${f.start ? ' ' + f.start : ''}${num(f.afcScore) ? ` · AFC sagte ${f.afcScore}` : ''}</span></div>
    <div class="lb-ask-btns">${Object.entries(L.VERDICTS).map(([k, n]) => `<button type="button" class="btn sec" data-act="fb" data-id="${esc(f.id)}" data-v="${k}">${n}</button>`).join('')}</div>
    <button type="button" class="linkbtn fine" data-act="fbskip" data-id="${esc(f.id)}">Diesen Flug nicht bewerten</button></div>`;
}
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
    const sub = [f.kind && L.FLIGHT_KINDS[f.kind], gearById[f.gliderId] && L.gearName(gearById[f.gliderId]), num(f.km) ? f.km + ' km' : '', f.track ? 'IGC' : '', f.afcVerdict && f.afcVerdict !== 'richtig' ? 'AFC ' + L.VERDICTS[f.afcVerdict].toLowerCase() : ''].filter(Boolean).join(' · ');
    return `${head}<button type="button" class="lb-row" data-act="lbflight" data-id="${esc(f.id)}"><span class="lb-date">${ddmm(f.date)}${f.start ? `<small>${f.start}</small>` : ''}</span><span class="lb-main"><b>${esc(route)}</b><small>${esc(sub)}${f.rating ? ' ' + stars(f.rating) : ''}</small></span><span class="lb-dur">${f.durMin ? L.fmtDur(f.durMin) : '–'}</span></button>`;
  }).join('');
  const gear = d.gear.slice().sort((a, b) => a.retired - b.retired || Object.keys(L.GEAR_TYPES).indexOf(a.type) - Object.keys(L.GEAR_TYPES).indexOf(b.type));
  const empty = !d.flights.length && !d.settings.flightsBefore && !d.gear.length;
  el.innerHTML = empty ? `
    <div class="panel lb-start">
      <h3>Dein Flugbuch ist noch leer</h3>
      <p>So kommen deine Flüge hinein, in ein paar Sekunden:</p>
      <ol class="lb-steps">
        <li><b>Flüge von früher:</b> nur die Anzahl eintragen, damit dein Total stimmt.
          <form id="lbSettings" class="lb-inline"><label class="fld"><span>Flüge</span><input type="number" inputmode="numeric" min="0" name="flightsBefore" placeholder="z.B. 120"></label><label class="fld"><span>Stunden</span><input type="number" inputmode="decimal" min="0" step="0.5" name="hoursBefore" placeholder="z.B. 80"></label><button class="btn sec" type="submit">Speichern</button></form></li>
        <li><b>IGC-Dateien laden:</b> aus FlySkyHy, XCTrack oder dem Vario. Start, Landung, Dauer und Thermik füllt AFC selbst aus.
          <div class="btn-row" style="justify-content:flex-start;margin-top:6px"><label class="btn lb-file">IGC laden<input type="file" id="lbIgc" accept=".igc,.IGC,application/octet-stream,text/plain" multiple></label></div></li>
        <li><b>Oder von Hand:</b> <button class="linkbtn" type="button" data-act="lbflight">Flug eintragen</button>, und unter <button class="linkbtn" type="button" data-act="lbgear">Ausrüstung</button> Schirm, Gurtzeug und Retter erfassen.</li>
      </ol>
      <p class="fine">Nach jedem Flug fragt AFC kurz, ob die Prognose gestimmt hat. Genau diese Rückmeldungen machen AFC besser.</p>
    </div>` : `
    ${feedbackHtml()}
    ${gearAlertHtml()}
    <div class="panel">
      <div class="lb-head"><h3>Flugbuch</h3><span class="btn-row"><label class="btn sec lb-file" title="IGC-Dateien vom Vario oder Handy (auch mehrere, oder hierher ziehen)">IGC laden<input type="file" id="lbIgc" accept=".igc,.IGC,application/octet-stream,text/plain" multiple></label><button class="btn" type="button" data-act="lbflight">+ Flug</button></span></div>
      <div class="kv lb-kv">
        <div><b>${st.total}</b><span>Flüge total</span></div>
        <div><b>${L.fmtDur(st.totalMin)} h</b><span>Flugzeit total</span></div>
        <div><b>${st.yearFlights} · ${L.fmtDur(st.yearMin)}</b><span>${st.year}: Flüge · Std.</span></div>
        <div><b>${st.last ? Math.max(0, Math.round((Date.now() - Date.parse(st.last.date)) / 86400000)) + ' Tg.' : '–'}</b><span>seit dem letzten Flug</span></div>
      </div>
      ${years.length > 1 ? `<div class="seg" role="group" aria-label="Jahr">${['all', ...years].map(y => `<button type="button" data-act="lbyear" data-v="${y}" aria-pressed="${LB.year === y}">${y === 'all' ? 'Alle' : y}</button>`).join('')}</div>` : ''}
      <div class="lb-list">${rows || `<p class="fine" style="margin:8px 0 0">${d.settings.flightsBefore ? `Noch keine Flüge einzeln erfasst. Deine ${d.settings.flightsBefore} Flüge von vorher zählen im Total. Neue Flüge mit «+ Flug» oder «IGC laden».` : 'Noch keine Flüge. Tippe auf «+ Flug» oder lade IGC-Dateien.'}</p>`}</div>
      ${st.longest?.durMin ? `<p class="fine">Längster Flug: ${L.fmtDur(st.longest.durMin)} h am ${ddmm(st.longest.date)}${st.longest.date.slice(0, 4)} (${esc(st.longest.siteName || '–')})${st.farthest ? ` · weitester: ${st.farthest.km} km` : ''}</p>` : ''}
    </div>
    ${lbStatsHtml(d.flights)}
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
      <p class="fine">Das Flugbuch liegt auf deinem Mac und füllt dein Pilotenprofil automatisch.</p>
    </div>
    <div class="panel">
      <div class="lb-head"><h3>Sichern und exportieren</h3><button class="btn sec" type="button" data-act="lbbackup">Jetzt sichern</button></div>
      ${lbBackupHtml(d.backup)}
      <div class="btn-row lb-exp">
        <button class="btn sec" type="button" data-act="lbcsv">Tabelle (Excel)</button>
        <button class="btn sec" type="button" data-act="lbprint">Drucken / PDF</button>
        <button class="btn sec" type="button" data-act="lbjson">Sicherungsdatei</button>
        <label class="btn sec lb-file">Sicherung laden<input type="file" id="lbRestore" accept=".json,application/json"></label>
      </div>
      <p class="fine">«Drucken / PDF» nimmt die Flüge der gewählten Jahres-Ansicht; im Druckfenster «Als PDF sichern» wählen. «Sicherung laden» ergänzt und aktualisiert Flüge, löscht aber nichts.</p>
    </div>`;
}

/* ---- Flugbuch-Statistik: Flugstunden je Monat, Flugarten, meine Plätze */
function lbStatsHtml(flights) {
  const L = LG();
  if (!flights.length) return '';
  // Monate: gewähltes Jahr, sonst die letzten 12 Monate
  const months = [];
  if (LB.year === 'all') { const d = new Date(); d.setDate(1); for (let i = 11; i >= 0; i--) { const x = new Date(d.getFullYear(), d.getMonth() - i, 1); months.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`); } }
  else for (let m = 1; m <= 12; m++) months.push(`${LB.year}-${String(m).padStart(2, '0')}`);
  const per = months.map(m => { const l = flights.filter(f => f.date.startsWith(m)); return { m, n: l.length, min: l.reduce((t, f) => t + (f.durMin || 0), 0) }; });
  const maxMin = Math.max(60, ...per.map(x => x.min)), top = per.reduce((a, b) => (b.min > a.min ? b : a), per[0]);
  const pool = LB.year === 'all' ? flights.filter(f => f.date >= months[0]) : flights.filter(f => f.date.startsWith(LB.year));
  const sumMin = pool.reduce((t, f) => t + (f.durMin || 0), 0);
  const bars = per.map(x => `<div class="st-col" title="${MONTHS[Number(x.m.slice(5)) - 1]} ${x.m.slice(0, 4)}: ${x.n} Flüge, ${L.fmtDur(x.min)} h" role="listitem" aria-label="${MONTHS[Number(x.m.slice(5)) - 1]}: ${x.n} Flüge, ${L.fmtDur(x.min)} Stunden">
      <span class="st-v">${x === top && x.min ? L.fmtDur(x.min) : ''}</span>
      <span class="st-bar" style="height:${x.min ? Math.max(4, Math.round(x.min / maxMin * 100)) : 0}%"></span>
      <span class="st-m">${MONTHS[Number(x.m.slice(5)) - 1].slice(0, 1)}</span></div>`).join('');
  const kinds = Object.entries(pool.reduce((m, f) => { const k = f.kind || 'andere'; m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  const sites = Object.values(pool.reduce((m, f) => {
    const k = f.siteId || f.siteName || '–';
    (m[k] ||= { id: f.siteId, name: f.siteName || '–', n: 0, min: 0, rs: [] });
    m[k].n++; m[k].min += f.durMin || 0; if (f.rating) m[k].rs.push(f.rating);
    return m;
  }, {})).sort((a, b) => b.n - a.n || b.min - a.min).slice(0, 6);
  const maxN = Math.max(1, ...sites.map(x => x.n));
  return `<div class="panel"><h3>Statistik ${LB.year === 'all' ? 'letzte 12 Monate' : LB.year}</h3>
    <p class="fine" style="margin:0 0 6px">${pool.length} Flüge · ${L.fmtDur(sumMin)} h${pool.length ? ' · im Schnitt ' + L.fmtDur(Math.round(sumMin / pool.length)) + ' h pro Flug' : ''}. Flugstunden je Monat:</p>
    <div class="st-chart" role="list" aria-label="Flugstunden je Monat">${bars}</div>
    ${kinds.length ? `<div class="st-kinds">${kinds.map(([k, n]) => `<span class="st-chip">${esc(L.FLIGHT_KINDS[k] || 'Andere')} <b>${n}</b></span>`).join('')}</div>` : ''}
    ${sites.length ? `<h3 class="st-h">Meine Plätze</h3><div class="st-sites">${sites.map(x => `<${x.id && S.plan && siteById(x.id) ? `button type="button" data-act="site" data-id="${esc(x.id)}"` : 'div'} class="st-site"><span class="st-sn">${esc(x.name)}</span><span class="st-track"><i style="width:${Math.round(x.n / maxN * 100)}%"></i></span><span class="st-sv">${x.n}× · ${L.fmtDur(x.min)} h${x.rs.length ? ' · ' + (x.rs.reduce((a, b) => a + b, 0) / x.rs.length).toFixed(1) + '★' : ''}</span></${x.id && S.plan && siteById(x.id) ? 'button' : 'div'}>`).join('')}</div>` : ''}
  </div>`;
}

/* ---- Benachrichtigungen (Web Push über den eigenen Mac, gratis) */
const PU = { state: null, sub: null, reg: null, key: null, serverOff: false, busy: false };
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function pushPrefs() {
  const p = store.get('pushPrefs', {});
  return { good: p.good !== false, foehn: p.foehn !== false, gear: p.gear !== false, health: p.health !== false, review: p.review !== false, threshold: p.threshold || 75, favs: [...S.fav], level: S.level };
}
async function pushInit() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { PU.state = isIOS() && !isStandalone() ? 'install' : 'unsupported'; return; }
  try {
    PU.reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, no) => setTimeout(() => no(new Error('kein Service Worker')), 8000))]);
    PU.sub = await PU.reg.pushManager.getSubscription();
    const k = await (await fetch('/api/push/key', { headers: { 'X-AFC-Client': clientId } })).json();
    PU.key = k.publicKey; PU.serverOff = !k.enabled;
  } catch { /* offline: später nochmals */ }
  PU.state = Notification.permission === 'denied' ? 'denied' : PU.sub ? 'on' : 'off';
}
const pushPost = (u, b) => fetch(u, { method: 'POST', headers: { 'X-AFC-Client': clientId, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
/** Einstellungen, Favoriten und Erfahrungsstufe an den Mac melden, wenn sie sich geändert haben. */
async function pushSync(force = false) {
  if (!PU.sub) return;
  const prefs = pushPrefs(), sig = JSON.stringify([PU.sub.endpoint, prefs]);
  if (!force && store.get('pushSig') === sig) return;
  try { const r = await pushPost('/api/push/subscribe', { subscription: PU.sub.toJSON(), prefs }); if (r.ok) store.set('pushSig', sig); } catch { /* nächstes Mal */ }
}
async function pushEnable() {
  if (!PU.reg || !PU.key) { toast(PU.serverOff ? 'Benachrichtigungen sind auf dem Mac ausgeschaltet.' : 'AFC auf dem Mac ist gerade nicht erreichbar.'); return; }
  PU.busy = true;
  try {
    // direkt im Tipp, sonst lässt iOS die Abfrage nicht zu
    PU.sub = await PU.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(PU.key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)) });
    await pushSync(true);
    PU.state = 'on';
    toast('Benachrichtigungen eingeschaltet. Tippe auf «Test senden».');
  } catch (err) {
    PU.state = Notification.permission === 'denied' ? 'denied' : 'off';
    toast(PU.state === 'denied' ? 'Benachrichtigungen wurden nicht erlaubt.' : 'Einschalten hat nicht geklappt: ' + err.message);
  } finally { PU.busy = false; renderPush(); }
}
async function pushDisable() {
  const ep = PU.sub?.endpoint;
  try { await PU.sub?.unsubscribe(); } catch { /* egal */ }
  if (ep) await pushPost('/api/push/unsubscribe', { endpoint: ep }).catch(() => {});
  PU.sub = null; PU.state = 'off'; store.del('pushSig');
  toast('Benachrichtigungen ausgeschaltet'); renderPush();
}
async function pushTest() {
  try {
    await pushSync(true);
    const r = await pushPost('/api/push/test', { endpoint: PU.sub?.endpoint });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Fehler ' + r.status);
    toast('Test gesendet. Er sollte in wenigen Sekunden ankommen.');
  } catch (err) { toast('Test fehlgeschlagen: ' + err.message); if (/abgelaufen/.test(err.message)) { PU.sub = null; PU.state = 'off'; renderPush(); } }
}
const renderPush = () => { const el = $('#pushPanel'); if (el) el.innerHTML = pushHtml(); };
function pushHtml() {
  const what = 'Abends um 19 Uhr, wenn morgen ein guter Flugtag wird (an deinen Favoriten, sonst überall) und bei Föhn. Morgens um 7 Uhr bei Föhn und wenn Retter packen oder Schirm-Check fällig ist. Tagsüber sofort, wenn bei AFC etwas nicht stimmt. Dafür muss der Mac wach sein.';
  switch (PU.state) {
    case null: return '<p class="fine" style="margin:0">Wird geprüft …</p>';
    case 'install': return `<p class="fine" style="margin:0">${what}</p><p class="fine"><b>So geht es auf dem iPhone:</b> AFC in Safari öffnen, unten auf Teilen tippen, «Zum Home-Bildschirm» wählen und AFC dann von dort öffnen. Hier erscheint danach «Einschalten».</p>`;
    case 'unsupported': return `<p class="fine" style="margin:0">Dieser Browser kann keine Benachrichtigungen. Auf dem iPhone (ab iOS 16.4) geht es, wenn AFC vom Home-Bildschirm aus geöffnet ist.</p>`;
    case 'denied': return `<p class="fine" style="margin:0">Benachrichtigungen sind für AFC blockiert. Auf dem iPhone: Einstellungen › Mitteilungen › AFC › «Mitteilungen erlauben». Danach AFC neu öffnen.</p>`;
    case 'off': return `<p class="fine" style="margin:0 0 8px">${what}</p><div class="btn-row" style="justify-content:flex-start"><button class="btn" type="button" data-act="pushon" ${PU.busy ? 'disabled' : ''}>Einschalten</button></div>`;
    default: {
      const p = pushPrefs();
      return `<form id="pushForm" class="push-form">
        <label class="chk"><input type="checkbox" name="good" ${p.good ? 'checked' : ''}><span>Guter Flugtag morgen, ab <select name="threshold" aria-label="ab welchem AFC-Wert">${[65, 70, 75, 80, 85].map(v => `<option ${v === p.threshold ? 'selected' : ''}>${v}</option>`).join('')}</select></span></label>
        <label class="chk"><input type="checkbox" name="foehn" ${p.foehn ? 'checked' : ''}><span>Föhn- und Bisewarnung</span></label>
        <label class="chk"><input type="checkbox" name="gear" ${p.gear ? 'checked' : ''}><span>Retter packen und Schirm-Check fällig</span></label>
        <label class="chk"><input type="checkbox" name="review" ${p.review ? 'checked' : ''}><span>Abends: Rückblick auf deinen Flug von heute</span></label>
        <label class="chk"><input type="checkbox" name="health" ${p.health ? 'checked' : ''}><span>Störungen von AFC (Wetterdaten veraltet, Sicherung fehlgeschlagen)</span></label>
      </form>
      <p class="fine">${what}</p>
      <div class="btn-row" style="justify-content:flex-start"><button class="btn sec" type="button" data-act="pushtest">Test senden</button><button class="btn sec" type="button" data-act="pushoff">Ausschalten</button></div>`;
    }
  }
}
/** Aus einer Benachrichtigung öffnen: /?tab=… oder /?site=… */
function applyDeepLink(url) {
  let q;
  try { q = new URL(url, location.href).searchParams; } catch { return; }
  const tab = q.get('tab'), site = q.get('site'), flight = q.get('flight');
  if (tab && $('#v-' + tab)) setTab(tab);
  if (flight) lbLoad().then(d => { if (d.flights.some(x => x.id === flight)) flightForm(flight); }).catch(() => {});
  if (site) {
    const open = () => { if (siteById(site)) { if (S.tab !== 'decide') setTab('decide'); openSite(site); } };
    S.plan ? open() : loadPlan().then(open);
  }
}

/* ---- Sicherung und Export */
const dayKey = v => new Date(v).toLocaleDateString('sv-SE', { timeZone: 'Europe/Zurich' });
function lbBackupHtml(b) {
  if (!b) return '';
  const parts = [];
  if (b.at) parts.push(`<b>Letzte Sicherung:</b> ${dayKey(b.at) === todayKey() ? 'heute' : 'am ' + ddmm(dayKey(b.at))} ${timeOf(b.at)} Uhr, ${b.flights} ${b.flights === 1 ? 'Flug' : 'Flüge'}.`);
  else parts.push('<b>Noch keine Sicherung.</b> Sie läuft täglich und kurz nach jeder Änderung.');
  if (b.cloudError) parts.push(`<span class="lb-warn">Die Kopie in ${esc(b.cloudDir || 'iCloud Drive')} hat nicht geklappt (${esc(b.cloudError)}).</span> Die Sicherung auf dem Mac (AFC/data/backups/flugbuch) läuft trotzdem.`);
  else if (b.cloudDir) parts.push(`Kopie in <b>${esc(b.cloudDir)}</b>${b.cloud ? '' : ' (ab der nächsten Sicherung)'}, also auch auf dem iPhone in der Dateien-App.`);
  else parts.push('iCloud Drive ist auf diesem Mac nicht eingeschaltet, die Sicherung liegt nur auf dem Mac (AFC/data/backups/flugbuch).');
  return `<p class="fine" style="margin:0 0 12px">${parts.join(' ')}</p>`;
}
/** Datei speichern: auf dem Handy über «Teilen» (In Dateien sichern), sonst als Download. */
async function saveFile(name, blob) {
  const file = new File([blob], name, { type: blob.type });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function lbExport(kind) {
  try {
    const r = await lbFetch('/api/logbook/export.' + kind);
    if (!r.ok) throw new Error('Fehler ' + r.status);
    await saveFile(`AFC-Flugbuch-${todayKey()}.${kind}`, await r.blob());
  } catch (err) { toast('Export fehlgeschlagen: ' + err.message); }
}
async function lbRestore(file) {
  if (!file) return;
  let b;
  try { b = JSON.parse(await file.text()); } catch { toast('Die Datei ist keine AFC-Sicherung.'); return; }
  if (b?.type !== 'flugbuch' || !Array.isArray(b.flights)) { toast('Die Datei ist keine AFC-Flugbuch-Sicherung.'); return; }
  const stand = b.exportedAt ? ` vom ${new Date(b.exportedAt).toLocaleDateString('de-CH')}` : '';
  if (!(await ask({ title: 'Sicherung einspielen?', text: `Die Sicherung${stand} enthält ${b.flights.length} Flüge und ${b.gear?.length || 0} Ausrüstungsteile. Gleiche Flüge werden durch den Stand aus der Sicherung ersetzt, fehlende kommen dazu, nichts wird gelöscht. Vorher macht AFC eine Sicherheitskopie.`, ok: 'Einspielen' }))) return;
  try {
    const r = await lbFetch('/api/logbook/import', { method: 'POST', body: JSON.stringify(b) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Fehler ' + r.status);
    await lbLoad(true);
    toast(`Eingespielt: ${j.added} neue und ${j.updated} aktualisierte Flüge, ${j.gear} Ausrüstungsteile`);
    renderBook(); setTimeout(lbSyncProfile, 2500);
  } catch (err) { toast('Einspielen fehlgeschlagen: ' + err.message); }
}
/** Druckansicht (auch für «Als PDF sichern»): Zusammenfassung, Flugliste, Ausrüstung. */
function lbPrint() {
  const L = LG(), d = LB.data;
  const flights = (LB.year === 'all' ? d.flights : d.flights.filter(f => f.date.startsWith(LB.year))).slice().sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const st = L.logStats(d.flights, d.settings), gn = Object.fromEntries(d.gear.map(g => [g.id, L.gearName(g)]));
  const sum = flights.reduce((m, f) => m + (f.durMin || 0), 0);
  const rows = flights.map((f, i) => `<tr><td class="n">${i + 1}</td><td>${f.date.split('-').reverse().join('.')}</td><td>${f.start || ''}</td><td class="n">${f.durMin ? L.fmtDur(f.durMin) : ''}</td><td>${esc([f.siteName, f.landingName].filter(Boolean).join(' → '))}</td><td>${esc(L.FLIGHT_KINDS[f.kind] || '')}</td><td>${esc(gn[f.gliderId] || '')}</td><td class="n">${num(f.km) ? f.km : ''}</td><td class="n">${num(f.maxAlt) ? f.maxAlt : ''}</td><td>${esc(f.note || '')}</td></tr>`).join('');
  const gear = d.gear.filter(g => !g.retired).map(g => { const s = L.gearStatus(g, d.flights); return `<li><b>${esc(L.GEAR_TYPES[g.type])}:</b> ${esc(L.gearName(g))}${g.cert ? ' (' + esc(g.cert) + ')' : ''}${g.serial ? ', Nr. ' + esc(g.serial) : ''}${g.type === 'reserve' ? '' : `, ${s.hours} h, ${s.flights} Flüge`}${s.items.map(x => ' · ' + esc(x.text)).join('')}</li>`; }).join('');
  let el = $('#printArea');
  if (!el) { el = document.createElement('div'); el.id = 'printArea'; document.body.append(el); }
  el.innerHTML = `<h1>Flugbuch</h1>
    <p>${LB.year === 'all' ? 'Alle erfassten Flüge' : 'Jahr ' + esc(LB.year)}: ${flights.length} ${flights.length === 1 ? 'Flug' : 'Flüge'}, ${L.fmtDur(sum)} h. Total inklusive Flüge vor dem Flugbuch: ${st.total} Flüge, ${L.fmtDur(st.totalMin)} h.</p>
    <table><thead><tr><th>Nr.</th><th>Datum</th><th>Start</th><th>Dauer</th><th>Startplatz → Landeplatz</th><th>Art</th><th>Schirm</th><th>km</th><th>max. m</th><th>Notiz</th></tr></thead><tbody>${rows || '<tr><td colspan="10">Keine Flüge</td></tr>'}</tbody></table>
    ${gear ? `<h2>Ausrüstung</h2><ul>${gear}</ul>` : ''}
    <p class="foot">Erstellt mit AFC am ${new Date().toLocaleDateString('de-CH')}</p>`;
  setTimeout(() => window.print(), 50);
}

/* ---- IGC-Import (lib/igc.js): Spur lesen, Start- und Landeplatz zuordnen, als Flug speichern */
const toMin = hm => (hm ? Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)) : NaN);
async function importIgc(files) {
  const I = window.AFCIgc, L = LG();
  if (!I || !L || !files?.length) return;
  const d = await lbLoad().catch(err => { toast(err.message); return null; });
  if (!d) return;
  const starts = [...(S.plan?.sites || []), ...(S.plan?.unrated || [])], lands = S.plan?.landings || [];
  const def = d.settings.defaults || {};
  let added = 0, dup = 0, bad = 0, lastId = null;
  for (const file of files) {
    let a = null;
    try { a = file.size < 20e6 ? I.analyzeIgc(await file.text(), file.name) : null; } catch {}
    if (!a) { bad++; continue; }
    if (d.flights.some(f => f.track?.file === file.name && f.date === a.date || (f.date === a.date && Math.abs(toMin(f.start) - toMin(a.start)) <= 5))) { dup++; continue; }
    const site = I.nearestPlace(starts, a.takeoff, 800), land = I.nearestPlace(lands, a.landing, 1000);
    const item = {
      id: L.newId(), date: a.date, start: a.start, durMin: a.durMin, maxAlt: a.maxAlt, km: a.km,
      siteId: site?.id || null, siteName: site?.name || '', landingId: land?.id || null, landingName: land?.name || '',
      kind: a.km >= 15 ? 'xc' : a.track.thermals.length ? 'thermik' : a.durMin <= 20 ? 'abgleiter' : '',
      gliderId: def.glider || null, harnessId: def.harness || null, reserveId: def.reserve || null,
      track: { ...a.track, takeoff: a.takeoff, landing: a.landing }
    };
    item.afcScore = afcScoreAt(item.siteId, a.date, a.start);
    item.afcFc = await afcFcAt(item.siteId, a.date, a.start);
    try { lastId = (await lbSave('flight', item, true)).id; added++; } catch { bad++; }
  }
  if (S.tab === 'book') renderBook();
  toast([added && `${added} ${added === 1 ? 'Flug' : 'Flüge'} importiert`, dup && `${dup} schon im Flugbuch`, bad && `${bad} nicht lesbar`].filter(Boolean).join(', ') || 'Nichts importiert');
  setTimeout(lbSyncProfile, 2500);   // nach der Import-Meldung, damit eine geänderte Erfahrungsstufe lesbar bleibt
  if (added === 1 && files.length === 1) flightForm(lastId);   // gleich ergänzen: Bewertung, Notiz
}

/** Spur als kleine Karte und Höhenprofil, darunter die Thermiken. */
function trackHtml(t) {
  const line = t.line || [];
  let svg = '', prof = '';
  if (line.length > 1) {
    const la = line.map(p => p[0]), lo = line.map(p => p[1]), k = Math.cos(la[0] * Math.PI / 180);
    const s0 = Math.min(...la), s1 = Math.max(...la), w0 = Math.min(...lo), w1 = Math.max(...lo);
    const sc = Math.min(280 / Math.max(1e-6, (w1 - w0) * k), 150 / Math.max(1e-6, s1 - s0));
    const X = q => (10 + ((q - w0) * k * sc) + (280 - (w1 - w0) * k * sc) / 2).toFixed(1), Y = q => (10 + (s1 - q) * sc + (150 - (s1 - s0) * sc) / 2).toFixed(1);
    svg = `<svg class="lb-map" viewBox="0 0 300 170" role="img" aria-label="Flugspur"><polyline points="${line.map(p => X(p[1]) + ',' + Y(p[0])).join(' ')}"/>${(t.thermals || []).map(h => `<circle class="th" cx="${X(h.lon)}" cy="${Y(h.lat)}" r="${Math.min(9, 3 + h.gain / 150).toFixed(1)}"><title>${h.at} Uhr: ${h.base}–${h.alt} m, ${h.rate} m/s</title></circle>`).join('')}<circle class="st" cx="${X(line[0][1])}" cy="${Y(line[0][0])}" r="4"/><circle class="ld" cx="${X(line.at(-1)[1])}" cy="${Y(line.at(-1)[0])}" r="4"/></svg>`;
    const al = line.map(p => p[2]), a0 = Math.min(...al), a1 = Math.max(a0 + 1, ...al);
    prof = `<svg class="lb-prof" viewBox="0 0 300 50" preserveAspectRatio="none" role="img" aria-label="Höhenprofil ${Math.round(a0)} bis ${Math.round(a1)} m"><polyline points="${al.map((v, i) => (i / (al.length - 1) * 300).toFixed(1) + ',' + (46 - (v - a0) / (a1 - a0) * 42).toFixed(1)).join(' ')}"/></svg>`;
  }
  const th = (t.thermals || []).slice().sort((a, b) => b.gain - a.gain).slice(0, 4);
  return `<div class="lb-wide lb-track"><span class="lb-type">Spur${t.file ? ' · ' + esc(t.file) : ''}</span>${svg}${prof}
    <p class="fine" style="margin:4px 0 0">${(t.thermals || []).length} Thermiken · bestes Steigen ${t.climbMax ?? '–'} m/s${num(t.maxDistKm) ? ` · bis ${t.maxDistKm} km vom Start` : ''}</p>
    ${th.length ? `<p class="fine" style="margin:2px 0 0">${th.map(h => `${h.at}: ${h.base} → ${h.alt} m (${h.rate} m/s)`).join(' · ')}</p>` : ''}</div>`;
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
      ${f ? reviewHtml(f) : ''}
      <div class="fld lb-wide"><span id="lbVerdL">AFC-Bewertung${num(v.afcScore) ? ` (AFC sagte ${v.afcScore})` : ''}</span><div class="stars lb-verd" role="radiogroup" aria-labelledby="lbVerdL">${Object.entries(L.VERDICTS).map(([k, n]) => `<label><input type="radio" name="afcVerdict" value="${k}" ${v.afcVerdict === k ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div></div>
      <div class="fld lb-wide"><span id="lbRateL">Bewertung</span><div class="stars" role="radiogroup" aria-labelledby="lbRateL">${[1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="rating" value="${n}" ${v.rating === n ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div></div>
      ${v.track ? trackHtml(v.track) : ''}
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
    const item = { ...(f || {}), id: f?.id || L.newId(), date: x.date, start: x.start, durMin: (Number(x.durH) || 0) * 60 + (Number(x.durM) || 0), kind: x.kind, siteName: x.siteName, siteId: site?.id || null, landingName: x.landingName, landingId: land?.id || null, km: x.km, maxAlt: x.maxAlt, gliderId: x.gliderId || null, harnessId: x.harnessId || null, reserveId: x.reserveId || null, rating: x.rating ? Number(x.rating) : null, afcVerdict: x.afcVerdict || '', note: x.note };
    // AFC-Score des Startplatzes zur Startzeit festhalten (zum späteren Abgleich), solange der Plan diesen Tag noch kennt
    if (!num(item.afcScore) || (f && (f.siteId !== item.siteId || f.date !== item.date || f.start !== item.start))) item.afcScore = afcScoreAt(item.siteId, item.date, item.start) ?? (f && f.siteId === item.siteId && f.date === item.date ? f.afcScore : null);
    if (!item.afcFc || (f && (f.siteId !== item.siteId || f.date !== item.date || f.start !== item.start))) item.afcFc = (await afcFcAt(item.siteId, item.date, item.start)) ?? (f && f.siteId === item.siteId && f.date === item.date ? f.afcFc : null);
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
  lbAlignBefore().then(ok => { if (ok && S.tab === 'book') renderBook(); });
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
  // Auf dem Handy: «Schliessen» unten in Daumenreichweite (oben rechts ist mit einer Hand schwer erreichbar)
  if (id === '#siteDlg') d.querySelector('.dlg-in')?.insertAdjacentHTML('beforeend', '<div class="dlg-foot"><button class="btn sec" type="button" data-act="closesite">Schliessen</button></div>');
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
  ['Dein Profil', 'Unter «Profil» trägst du Flüge, Stunden, Schirm und letzten Flug ein. Daraus wählt AFC deine Grenzen für Wind und Thermik und rechnet die Route mit deiner Gleitzahl. AFC ersetzt nie deine eigene Beurteilung am Startplatz.'],
  ['Testphase: deine Rückmeldung zählt', 'Oben rechts beim Sprechblasen-Knopf schickst du Lars jederzeit eine Idee, einen Fehler oder ein Bildschirmfoto. Nach jedem Flug fragt AFC kurz, ob die Prognose gestimmt hat, und unter «Flugtag» meldest du auch Tage ohne Start. Genau das macht AFC besser.']
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
    if (v === 'profile') { setTab('profile'); if (ME.user) setTimeout(profileEdit, 300); }
  };
  d.onclose = () => store.set('intro', INTRO_VER);
}
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, Math.max(3200, msg.length * 70));
}

/* ---- Startplatz-Ansicht */
async function openSite(id) {
  if (!S.plan || !siteById(id)) return;
  const base = siteById(id);
  S.site = id; S.hour = null; S.panel = null;
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
/** Landeplatz: nächster offizieller Landeplatz im Gebiet, Prognose zur gewählten Stunde und Messung in der Nähe. */
function landingHtml(s, hr) {
  // Landeplätze des Gebiets, sonst der nächste im Umkreis von 5 km (z.B. Lehn für Amisbühl)
  const cand = (S.plan?.landings || []).filter(l => num(l.lat)).map(l => ({ l, d: haversineKm(s.lat, s.lon, l.lat, l.lon) }));
  const L = (cand.some(x => x.l.area === s.area) ? cand.filter(x => x.l.area === s.area) : cand.filter(x => x.d <= 5)).sort((a, b) => a.d - b.d)[0];
  if (!L && !hr?.valley) return '';
  const l = L?.l, [warn, bad] = [22, 28];
  const fc = hr?.valley, fv = fc ? Math.max(fc[0], 0.75 * (fc[1] ?? 0)) : null;
  const fl = fv == null ? 'none' : fv >= bad ? 'bad' : fv >= warn ? 'warn' : 'ok';
  let st = null;
  if (l && S.day === 0) {
    for (const x of S.plan.stations || []) {
      if (!num(x.lat) || !num(x.wind)) continue;
      const d = haversineKm(l.lat, l.lon, x.lat, x.lon);
      if (d <= 12 && Math.abs((x.alt ?? 0) - (l.alt ?? 0)) <= 400 && (!st || d < st.d)) st = { x, d };
    }
  }
  const sx = st?.x, sv = sx ? Math.max(sx.wind, 0.75 * (sx.gust ?? 0)) : null, sl = sv == null ? 'none' : sv >= bad ? 'bad' : sv >= warn ? 'warn' : 'ok';
  return `<div class="panel land" style="margin:0"><h3>Landeplatz</h3>
    ${l ? `<p style="margin:0 0 8px"><b>${esc(l.name)}</b> <span class="fine">${l.alt ?? '–'} m · ${L.d.toFixed(1)} km vom Start · ${num(l.alt) ? (s.alt - l.alt) + ' m tiefer' : ''}</span></p>` : ''}
    <div class="land-g">
      <div class="land-c stc-${fl}"><small>Prognose ${hr ? hr.h + '–' + (hr.h + 1) + ' Uhr' : ''}</small><b>${fc ? fc[0] + ' / ' + (fc[1] ?? '–') : '–'}</b><small>Wind / Böen km/h</small></div>
      ${S.day === 0 ? `<div class="land-c stc-${sl}"><small>Gemessen jetzt</small><b>${sx ? Math.round(sx.wind) + ' / ' + (num(sx.gust) ? Math.round(sx.gust) : '–') : '–'}</b><small>${sx ? `${esc(sx.name)}, ${st.d.toFixed(0)} km · ${ageTxt(ageMin(sx.time, sx.age))}${num(sx.dir) ? ' · aus ' + dirLabel(sx.dir) : ''}` : 'keine Station in der Nähe'}</small></div>` : ''}
    </div>
    <p class="fine" style="margin:8px 0 0">Ab etwa ${warn} km/h (Böen zu drei Vierteln gezählt) wird die Landung anspruchsvoll, ab ${bad} km/h stark. Windsack am Landeplatz vor dem Start ansehen, wenn möglich.</p>
    ${l ? volteHtml(l, sx && num(sx.dir) && sx.wind >= 4 ? { dir: sx.dir, src: 'gemessen' } : hr?.valleyDir != null ? { dir: hr.valleyDir, src: 'Prognose' } : num(hr?.dir) ? { dir: hr.dir, src: 'Prognose am Start' } : null) : ''}</div>`;
}

/* ---- Landevolte: eigene Angabe je Landeplatz (Endanflug und Seite), sonst Vorschlag gegen den Wind */
const VOLTE_DIRS = [['N', 0], ['NO', 45], ['O', 90], ['SO', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]];
function volteSvg(h, side, wind) {
  const rad = d => d * Math.PI / 180, v = (d, L) => [Math.sin(rad(d)) * L, -Math.cos(rad(d)) * L];
  // rückwärts vom Aufsetzpunkt: Endanflug, Queranflug, Gegenanflug (Linksvolte = Linkskurven)
  const T = [0, 0], f = v(h, 46), P2 = [T[0] - f[0], T[1] - f[1]];
  const b = v(side === 'R' ? h - 90 : h + 90, 34), P1 = [P2[0] - b[0], P2[1] - b[1]];
  const dv = v(h + 180, 58), P0 = [P1[0] - dv[0], P1[1] - dv[1]];
  const pts = [P0, P1, P2, T], xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const ox = 70 - (Math.min(...xs) + Math.max(...xs)) / 2, oy = 66 - (Math.min(...ys) + Math.max(...ys)) / 2;
  const q = p => `${(p[0] + ox).toFixed(1)},${(p[1] + oy).toFixed(1)}`;
  const seg = (a, c, cl) => `<line x1="${q(a).split(',')[0]}" y1="${q(a).split(',')[1]}" x2="${q(c).split(',')[0]}" y2="${q(c).split(',')[1]}" class="${cl}" marker-end="url(#va)"/>`;
  const w = wind ? `<g transform="translate(128 14) rotate(${Math.round(wind.dir)})"><line x1="0" y1="-9" x2="0" y2="8" class="vw"/><path d="M-4 3 L0 9 L4 3" class="vw"/></g><text x="128" y="34" class="vt" text-anchor="middle">Wind</text>` : '';
  return `<svg class="volte" viewBox="0 0 140 132" role="img" aria-label="Volte: Gegenanflug, Queranflug, Endanflug Richtung ${dirLabel(h)}">
    <defs><marker id="va" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 z" class="vm"/></marker></defs>
    <text x="10" y="14" class="vt">N ↑</text>${w}
    ${seg(P0, P1, 'vl')}${seg(P1, P2, 'vl')}${seg(P2, T, 'vf')}
    <circle cx="${q(T).split(',')[0]}" cy="${q(T).split(',')[1]}" r="5" class="vp"/></svg>`;
}
function volteHtml(l, wind) {
  const mine = LB.data?.settings?.lands?.[l.id];
  const h = mine ? mine.dir : wind ? Math.round(wind.dir / 45) * 45 % 360 : null;
  // Regel des Landeplatzes (z.B. Lehn: Rechtsvolte bei Talwind, Linksvolte bei Bergwind)
  const R = l.volte, tal = R && wind ? wind.dir >= R.talFrom[0] && wind.dir < R.talFrom[1] : null;
  const side = mine?.side || (R && tal != null ? (tal ? R.tal : R.berg) : 'L');
  // Rückenwind auf dem eigenen Endanflug? (Wind kommt von hinten, wenn er mehr als 100° neben der Anflugrichtung liegt)
  const off = mine && wind ? Math.abs(((wind.dir - mine.dir) % 360 + 540) % 360 - 180) : null;
  const tail = off != null && off > 100;
  const opt = (sel) => VOLTE_DIRS.map(([n, d]) => `<option value="${d}" ${sel === d ? 'selected' : ''}>nach ${n}</option>`).join('');
  return `<div class="volte-box">
    ${h != null ? volteSvg(h, side, wind) : ''}
    <div class="volte-t">
      <p style="margin:0"><b>Volte</b> ${h != null ? `${side === 'R' ? 'rechts' : 'links'}, Endanflug nach ${dirLabel(h)}` : ''}
      <span class="fine">${mine ? '(deine Angabe)' : h != null ? `(Vorschlag gegen den Wind, ${esc(wind.src)}${R ? `; Seite nach Platzregel bei ${tal ? 'Talwind' : 'Bergwind'}` : '; Seite und Hindernisse vor Ort klären'})` : 'Keine Windangabe für einen Vorschlag.'}</span></p>
      ${R ? `<p class="fine" style="margin:4px 0 0">Platzregel: ${R.tal === 'R' ? 'Rechtsvolte' : 'Linksvolte'} bei Talwind, ${R.berg === 'R' ? 'Rechtsvolte' : 'Linksvolte'} bei Bergwind${R.src ? ' (' + esc(R.src) + ')' : ''}. Vor Ort an der Tafel prüfen.</p>` : ''}
      ${(l.notes || []).map((n, i) => i ? `<p class="fine" style="margin:4px 0 0">${esc(n)}</p>` : `<p class="volte-warn">${esc(n)}</p>`).join('')}
      ${h != null ? '<p class="fine" style="margin:4px 0 0">Gestrichelt: Gegenanflug und Queranflug, grün: Endanflug zum Landepunkt. Der blaue Pfeil zeigt, wohin der Wind weht.</p>' : ''}
      ${tail ? `<p class="volte-warn" role="alert">Wind heute aus ${dirLabel(wind.dir)} (${esc(wind.src)}): Rückenwind auf deinem Endanflug. Anders einteilen.</p>` : ''}
      <details class="volte-ed"><summary>${mine ? 'Volte ändern' : 'Volte für diesen Landeplatz eintragen'}</summary>
        <div class="volte-f"><label>Endanflug <select data-volte="dir">${opt(mine?.dir ?? h)}</select></label>
        <label>Volte <select data-volte="side"><option value="L" ${side === 'L' ? 'selected' : ''}>links</option><option value="R" ${side === 'R' ? 'selected' : ''}>rechts</option></select></label>
        <button class="btn sec" type="button" data-act="volteset" data-id="${esc(l.id)}">Speichern</button>${mine ? `<button class="linkbtn" type="button" data-act="volteset" data-id="${esc(l.id)}" data-clear="1">Entfernen</button>` : ''}</div>
        <p class="fine" style="margin:4px 0 0">Wird in deinem Flugbuch gespeichert und mitgesichert.</p></details>
    </div></div>`;
}
async function volteSet(id, btn) {
  const d = LB.data;
  if (!d) { toast('Flugbuch ist noch nicht geladen.'); return; }
  const box = btn.closest('.volte-f'), lands = { ...(d.settings.lands || {}) };
  if (btn.dataset.clear) delete lands[id];
  else lands[id] = { dir: Number(box.querySelector('[data-volte=dir]').value), side: box.querySelector('[data-volte=side]').value };
  try { await lbSave('settings', { ...d.settings, lands }); toast(btn.dataset.clear ? 'Volte entfernt' : 'Volte gespeichert'); if (S.detailData?.site) renderSite(); }
  catch (e) { toast('Speichern fehlgeschlagen: ' + e.message); }
}
function profileHtml(prof) {
  if (!prof?.length) return '<p class="fine">Kein Windprofil verfügbar (Höhenmodell fehlt).</p>';
  const max = Math.max(40, ...prof.map(p => p[1]));
  return `<div class="profile" role="table" aria-label="Windprofil">${[...prof].reverse().map(p => `<div class="pr" role="row"><span>+${p[0]} m</span><span class="bar"><i class="${p[1] >= 40 ? 'hi' : ''}" style="width:${Math.round(p[1] / max * 100)}%"></i></span><b>${p[1]} ${arrow(p[2])} ${dirLabel(p[2])}</b></div>`).join('')}</div>`;
}
/* ---- Flugtag-Wächter: «Heute fliege ich hier» (lib/watch.js) */
const WT = { list: [], devices: 0, to: 20 };
async function loadWatch() {
  try { const j = await (await fetch('/api/watch', { headers: { 'X-AFC-Client': clientId } })).json(); if (j.ok) Object.assign(WT, { list: j.watches, devices: j.devices, to: j.to ?? 20 }); } catch { /* offline */ }
}
const watching = id => WT.list.some(w => w.siteId === id);
function watchBtnHtml(id) {
  const on = watching(id);
  return `<div class="watch-row${on ? ' on' : ''}"><button class="btn ${on ? '' : 'sec'}" type="button" data-act="watch" data-id="${esc(id)}" aria-pressed="${on}">${on ? '✓ Wächter aktiv' : 'Heute fliege ich hier'}</button><span class="fine">${on ? `AFC meldet sich bis ${WT.to} Uhr sofort, wenn Böen, Föhn oder die Bewertung kippen. Nochmals tippen beendet den Wächter.` : 'AFC behält den Startplatz heute im Auge und meldet sich, wenn es kippt.'}</span></div>`;
}
function watchLineHtml() {
  const names = WT.list.map(w => siteById(w.siteId)).filter(Boolean);
  if (!names.length) return '';
  return `<div class="watch-line" role="status">Wächter aktiv: ${names.map(s => `<button type="button" class="linkbtn" data-act="site" data-id="${esc(s.id)}">${esc(s.name)}</button>`).join(', ')} <span class="fine">bis ${WT.to} Uhr</span></div>`;
}
async function toggleWatch(id) {
  const on = !watching(id);
  try {
    const r = await fetch('/api/watch', { method: 'POST', headers: { 'X-AFC-Client': clientId, 'Content-Type': 'application/json' }, body: JSON.stringify({ siteId: id, on, level: S.level }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Fehler ' + r.status);
    WT.list = j.watches; WT.devices = j.devices;
    toast(!on ? 'Wächter beendet' : j.devices ? 'Wächter aktiv. AFC meldet sich, wenn es kippt.' : 'Wächter aktiv, aber noch kein Gerät für Benachrichtigungen angemeldet (Profil › Benachrichtigungen).');
    if (S.detailData?.site?.id === id) renderSite();
    if (S.tab === 'decide') renderDecide();
  } catch (err) { toast('Nicht geklappt: ' + err.message); }
}
/* ---- Webcams je Startplatz: Windfinder listet alle Webcams im Umkreis mit Entfernung und letzter Aufnahme */
const WF = slug => 'https://www.windfinder.com/webcams/' + slug;
const WEBCAMS = {
  area: {
    amisbuhl: ['Beatenberg', 'beatenberg_bern_switzerland'], niederhorn: ['Niederhorn', 'niederhorn_1920'], luegibruggli: ['Luegibrüggli', 'luegibrueggli'],
    'schynige-platte': ['Schynige Platte', 'schynige_platte_kamel_interlaken'], 'grindelwald-first': ['Grindelwald First', 'grindelwald_first'],
    grindelwald: ['Grindelwald First', 'grindelwald_first'], mannlichen: ['Wengernalp', 'wengernalp'], schilthorn: ['Schilthorn', 'schilthorn_2940_muerren'],
    niesen: ['Niesen', 'niesen_2280'], stockhorn: ['Stockhorn', 'stockhorn'], kandersteg: ['Allmenalp', 'allmenalp_kandersteg'],
    adelboden: ['Tschentenalp', 'tschentenalp'], frutigen: ['Frutigen', 'frutigen'], haslital: ['Planplatten', 'meiringen_planplatten_2240'],
    gstaad: ['Wispile', 'wispile_1900_saanen_gstaad']
  },
  site: { 'engstligen-1': ['Engstligenalp', 'engstligenalp'], 'engstligen-2': ['Engstligenalp', 'engstligenalp'], kuonisbergli: ['Adelboden', 'adelboden_boden'] }
};
function webcamHtml(s) {
  const w = WEBCAMS.site[s.id] || WEBCAMS.area[s.area], mine = LB.data?.settings?.cams?.[s.id];
  const links = [mine && `<a href="${esc(mine)}" target="_blank" rel="noopener">Meine Webcam</a>`, w && `<a href="${WF(w[1])}" target="_blank" rel="noopener">Webcams ${esc(w[0])}</a>`].filter(Boolean);
  return `${mine ? `<figure class="cam-img" id="camImg" data-u="${esc(mine)}" hidden><img alt="Webcam ${esc(s.name)}"><figcaption class="fine"></figcaption></figure>` : ''}<p class="cam-row"><b>Webcam:</b> ${links.length ? links.join(' · ') : '<span class="fine">noch keine hinterlegt</span>'} <button type="button" class="linkbtn fine" data-act="camset" data-id="${esc(s.id)}">${mine ? 'ändern' : 'eigene festlegen'}</button></p>`;
}
/** Eigene Webcam als Bild zeigen, wenn die Adresse ein Bild liefert (über den eigenen Mac, mit Uhrzeit). */
const CAMURL = new Map();
async function fillCam(s) {
  const fig = $('#camImg');
  if (!fig) return;
  const u = fig.dataset.u;
  try {
    const r = await fetch('/api/camimg?u=' + encodeURIComponent(u), { cache: 'no-store' });
    if (!r.ok) return;   // keine Bildadresse: es bleibt beim Link
    const blob = await r.blob(), at = r.headers.get('X-AFC-Image-Time');
    if ($('#camImg') !== fig) return;
    if (CAMURL.get(u)) URL.revokeObjectURL(CAMURL.get(u));
    const obj = URL.createObjectURL(blob); CAMURL.set(u, obj);
    fig.querySelector('img').src = obj;
    const age = at ? ageMin(at) : null;
    fig.querySelector('figcaption').innerHTML = at ? `Bild ${esc(whenTxt(at))}${age > 30 ? ' · <b>' + ageTxt(age) + ', eventuell veraltet</b>' : ''}` : '';
    fig.hidden = false;
  } catch { /* Link bleibt */ }
}
async function camSet(id) {
  const d = await lbLoad().catch(err => { toast(err.message); return null; });
  if (!d) return;
  const cur = d.settings.cams?.[id] || '';
  const v = prompt('Adresse deiner Webcam (beginnt mit https://). Am besten die Adresse des Bildes: im Browser lange auf das Webcam-Bild drücken und «Bildadresse kopieren» wählen. Dann zeigt AFC das Bild direkt an. Leer lassen zum Entfernen.', cur);
  if (v === null) return;
  const cams = { ...(d.settings.cams || {}) };
  if (v.trim()) { const u = LG().httpsUrl(v); if (!u) { toast('Bitte eine Adresse mit https:// eingeben.'); return; } cams[id] = u; } else delete cams[id];
  try { await lbSave('settings', { ...d.settings, cams }); toast(v.trim() ? 'Webcam gespeichert' : 'Webcam entfernt'); if (S.detailData?.site?.id === id) renderSite(); }
  catch (err) { toast('Nicht gespeichert: ' + err.message); }
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
  const actionsHtml = `<div class="site-acts">
      ${S.day === 0 ? watchBtnHtml(s.id) : ''}
      <div class="act-row">${starBtn(s.id).replace('class="star"', 'class="star act-star"')}<button class="btn sec" type="button" data-act="showmap" data-id="${esc(s.id)}">Auf Karte</button><button class="btn sec" type="button" data-act="report" data-id="${esc(s.id)}">Flug melden</button></div>
      ${groupLineFor(s.id)}
      ${ME.user && isToday() ? `<p class="nofly-l"><button class="linkbtn" type="button" data-act="nofly" data-id="${esc(s.id)}">Heute hier nicht gestartet?</button> <button class="linkbtn" type="button" data-act="feedback" data-v="forecast">Prognose stimmte nicht?</button></p>` : ''}
      ${webcamHtml(s)}
    </div>`;
  const detailHtml = hr ? `
    <div class="hr-detail">
      <div class="hr-head">${pill(hr.score, false)}<div><h3>${hr.h}–${hr.h + 1} Uhr: ${DECISION[c]}</h3><p class="fine" style="margin:0">${hr.cap != null ? 'Gedeckelt auf ' + hr.cap + ' wegen K.-o.-Kriterium' : 'Kein K.-o.-Kriterium aktiv'}</p></div></div>
      ${hr.why?.length ? `<h3 class="why-h">Kurz erklärt</h3><ul class="why">${[...hr.why, P()?.pilotHint({ ...store.get('pilot', {}), maxWind: ME.profile?.maxWind, maxGust: ME.profile?.maxGust }, hr)].filter(Boolean).map(f => `<li class="why-${f.lvl}"><span class="why-i" aria-label="${f.lvl === 'ok' ? 'in Ordnung' : f.lvl === 'warn' ? 'beachten' : 'nicht fliegbar'}">${f.lvl === 'ok' ? '✓' : f.lvl === 'warn' ? '!' : '✕'}</span><b>${esc(f.k)}</b><span>${esc(f.t)}</span></li>`).join('')}</ul>` : ''}
      ${actionsHtml}
      <details class="why-more"><summary>Alle Gründe für den Score</summary>
      ${hr.hard.length ? `<ul class="ko">${hr.hard.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${hr.reasons.length ? `<ul class="rs">${hr.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="fine">Keine Auffälligkeiten.</p>'}
      </details>
      <div class="kv">
        <div><b>${hr.speed ?? '–'} ${arrow(hr.dir)}</b><span>Wind km/h aus ${dirLabel(hr.dir)} (${hr.dir ?? '–'}°)</span></div>
        <div><b>${hr.gust ?? '–'}</b><span>Böen km/h</span></div>
        <div><b>${hr.cloudMargin ?? '–'} m</b><span>Wolkenbasis über Start${hr.cloudBase ? ' (Basis ' + hr.cloudBase + ' m)' : ''}</span></div>
        <div><b>${hr.pop ?? '–'} %</b><span>Regenrisiko</span></div>
      </div>
      <details class="pro-more" ${store.get('proOpen') ? 'open' : ''}><summary>Für Profis: Windprofil, Thermik, Scherung, Modelle</summary>
      <div class="kv">
        <div><b>${hr.head ?? '–'} / ${hr.tail ?? '–'}</b><span>Gegenwind / Rückenwind${hr.wd != null ? ', ' + hr.wd + '° neben dem Hang' : ''}</span></div>
        <div><b>${hr.cape ?? '–'}</b><span>CAPE J/kg (Gewitterenergie)</span></div>
        <div><b>${hr.thermal}</b><span>Thermikindex (0–100)</span></div>
        ${hr.thermalTop != null ? `<div><b>${hr.thermalTop} m</b><span>Thermik bis${hr.topMargin != null ? ' (' + (hr.topMargin >= 0 ? '+' : '') + hr.topMargin + ' m über Start)' : ''}${hr.wstar ? ', Steigen ca. ' + hr.wstar.toFixed(1) + ' m/s' : ''}${hr.inversion ? ', Inversion ab ' + hr.inversion + ' m' : ''}</span></div>` : ''}
        <div><b>${hr.valley ? hr.valley[0] + ' / ' + hr.valley[1] : '–'}</b><span>Landewind Wind / Böen km/h</span></div>
        <div><b>${hr.shear ?? '–'}</b><span>Scherung 500 m über Start km/h</span></div>
        ${hr.spread != null ? `<div><b>${hr.spread}</b><span>Modell-Unterschied km/h (ICON gegen ECMWF${hr.spread >= 10 ? ', unsicher' : ''})</span></div>` : ''}
      </div>
      <h3 style="font:700 18px var(--f-num)">Wind über dem Startplatz</h3>
      ${profileHtml(hr.prof)}
      </details>
    </div>` : `<div class="empty">Für diesen Tag gibt es keine Bewertung.</div>${actionsHtml}`;
  const table = hrs.length ? `<div class="hours-tbl"><table><thead><tr><th>Uhr</th><th>Score</th><th>Wind</th><th>Böen</th><th>Dir.</th><th>Basis</th><th>Regen</th></tr></thead><tbody>${hrs.map(h => `<tr class="${h.h === hr?.h ? 'sel' : ''}" data-act="hour" data-h="${h.h}" tabindex="0"><td>${h.h}</td><td><b class="mini-pill s-${cls(h.score)}" style="display:inline-block">${h.score}</b></td><td>${h.speed ?? '–'}</td><td>${h.gust ?? '–'}</td><td>${arrow(h.dir)} ${dirLabel(h.dir)}</td><td>${h.cloudBase ?? '–'}</td><td>${h.pop ?? '–'} %</td></tr>`).join('')}</tbody></table></div>` : '';
  dlg('#siteDlg', `<div class="dlg-in">
    <div class="dlg-h"><div><h2 id="siteDlgT">${esc(s.name)}</h2><p class="fine" style="margin:2px 0 0">${s.alt} m · Ausrichtung ${esc(aspectText(s))}${s.status ? ' · ' + esc(s.status) : ''}</p></div><button class="x-btn" type="button" data-act="closesite" aria-label="Schliessen">×</button></div>
    ${d._savedAt ? `<div class="saved-note" role="status"><b>Kein Empfang: gespeicherter Stand von ${esc(whenTxt(d._savedAt))}.</b> Nicht für den Startentscheid verwenden, Wind vor Ort prüfen.</div>` : ''}
    <div><strong>${dayName(S.day)}</strong> · bestes Fenster <strong>${winText(day?.best)}</strong>${day?.best ? ` · Score ${day.best.score}` : ''}</div>
    ${ribbon(scores, day?.best, { big: true, btn: true, sel: hr?.h, axis: true, now: nowHourToday() })}
    ${detailHtml}
    ${S.day === 0 && !d._savedAt ? `<div class="panel" style="margin:0"><h3>Regen jetzt</h3><div id="radarNear"><p class="fine" style="margin:0">Regenradar wird geprüft …</p></div></div>` : ''}
    ${landingHtml(s, hr)}
    ${table}
    <div class="panel" style="margin:0"><h3>Messung gegen Prognose</h3>${nc ? `<p>${esc(nc.name)} (${nc.dist} km, ${nc.altDiff >= 0 ? '+' : ''}${nc.altDiff} m Höhe) misst <b>${nc.obs} km/h</b> aus ${dirLabel(nc.obsDir)}; die Prognose sagte <b>${nc.fc} km/h</b> aus ${dirLabel(nc.fcDir)}. Abweichung ${nc.bias >= 0 ? '+' : ''}${nc.bias} km/h, in den nächsten 2 bis 3 Stunden eingerechnet. Messung ${ageTxt(ageMin(nc.at, nc.ageMin)).replace('vor ', '')} alt.</p>` : '<p class="fine" style="margin:0">Keine passende Station in der Nähe (höchstens 15 km und 600 m Höhenunterschied). Es gilt die reine Prognose.</p>'}</div>
  </div>`);
  if (S.day === 0 && !d._savedAt) fillRadarNear(s);
  fillCam(s);
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

/* ---- Regenradar (RainViewer über den eigenen Mac, /api/radar). Gratis für persönliche Nutzung. */
const RAD = { frames: [], at: 0, layer: null, timer: null, near: new Map() };
async function radarFrames(force) {
  if (!force && RAD.frames.length && Date.now() - RAD.at < 5 * 60000) return RAD.frames;
  const r = await fetch('/api/radar', { cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.frames?.length) throw new Error(j.error || 'Radar nicht verfügbar');
  RAD.frames = j.frames; RAD.at = Date.now();
  return RAD.frames;
}
const radarUrl = ts => `/api/radar/${ts}/{z}/{x}/{y}.png`;
async function setRadar(on) {
  const keep = store.get('ov', {}); keep.radar = on; store.set('ov', keep);
  clearInterval(RAD.timer); RAD.timer = null;
  if (RAD.layer) { M.map?.removeLayer(RAD.layer); RAD.layer = null; }
  const chip = $('#radarChip');
  if (!on || !M.map) { if (chip) chip.hidden = true; return; }
  const draw = async force => {
    try {
      const f = await radarFrames(force), ts = f.at(-1);
      if (!RAD.layer) RAD.layer = L.tileLayer(radarUrl(ts), { opacity: 0.65, maxNativeZoom: 7, maxZoom: 18, zIndex: 450, attribution: 'Radar <a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>' }).addTo(M.map);
      else RAD.layer.setUrl(radarUrl(ts));
      chip.textContent = `Regenradar ${timeOf(new Date(ts * 1000).toISOString())} Uhr`; chip.hidden = false;
    } catch (e) { chip.textContent = 'Regenradar: ' + e.message; chip.hidden = false; }
  };
  await draw(false);
  RAD.timer = setInterval(() => { if (S.tab === 'map') draw(true); }, 10 * 60000);
}
/** Regen auf dem Radar in der Nähe eines Ortes: nächster Regen (km, Richtung) jetzt und vor 20 Minuten. */
async function radarNear(lat, lon, radiusKm = 30) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`, hit = RAD.near.get(key);
  if (hit && Date.now() - hit.at < 5 * 60000) return hit.v;
  const f = await radarFrames(false), z = 7, n = 2 ** z;
  const xt = (lon + 180) / 360 * n, phi = lat * Math.PI / 180, yt = (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2 * n;
  const mpp = 156543.03 * Math.cos(phi) / n, rPx = Math.ceil(radiusKm * 1000 / mpp);
  const cx = xt * 256, cy = yt * 256;
  const tx0 = Math.floor((cx - rPx) / 256), tx1 = Math.floor((cx + rPx) / 256), ty0 = Math.floor((cy - rPx) / 256), ty1 = Math.floor((cy + rPx) / 256);
  const nearest = async ts => {
    const cv = document.createElement('canvas'); cv.width = (tx1 - tx0 + 1) * 256; cv.height = (ty1 - ty0 + 1) * 256;
    const g = cv.getContext('2d', { willReadFrequently: true });
    for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
      const r = await fetch(`/api/radar/${ts}/${z}/${tx}/${ty}.png`);
      if (!r.ok) throw new Error('Radarbild fehlt');
      const bmp = await createImageBitmap(await r.blob());
      g.drawImage(bmp, (tx - tx0) * 256, (ty - ty0) * 256);
    }
    const px = cx - tx0 * 256, py = cy - ty0 * 256;
    const x0 = Math.max(0, Math.floor(px - rPx)), y0 = Math.max(0, Math.floor(py - rPx));
    const data = g.getImageData(x0, y0, Math.min(cv.width - x0, 2 * rPx + 1), Math.min(cv.height - y0, 2 * rPx + 1));
    let best = null, cells = 0;
    for (let y = 0; y < data.height; y++) for (let x = 0; x < data.width; x++) {
      if (data.data[(y * data.width + x) * 4 + 3] < 60) continue;
      const dx = x0 + x - px, dy = y0 + y - py, d = Math.hypot(dx, dy) * mpp / 1000;
      if (d > radiusKm) continue;
      cells++;
      if (!best || d < best.d) best = { d, deg: (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360 };
    }
    return best ? { ...best, cells } : null;
  };
  const now = await nearest(f.at(-1)), before = f.length >= 3 ? await nearest(f.at(-3)).catch(() => null) : null;
  const v = { ts: f.at(-1), radiusKm, now, before };
  RAD.near.set(key, { at: Date.now(), v });
  return v;
}
const DIR8 = ['Norden', 'Nordosten', 'Osten', 'Südosten', 'Süden', 'Südwesten', 'Westen', 'Nordwesten'];
const dir8 = deg => DIR8[Math.round(deg / 45) % 8];
const DIR8_ADJ = ['nördlich', 'nordöstlich', 'östlich', 'südöstlich', 'südlich', 'südwestlich', 'westlich', 'nordwestlich'];
function radarNearHtml(v) {
  const when = timeOf(new Date(v.ts * 1000).toISOString());
  if (!v.now) return `<div class="rad-near ok"><b>Kein Regen</b> im Umkreis von ${v.radiusKm} km <span class="fine">(Radar ${when} Uhr)</span></div>`;
  const d = Math.max(1, Math.round(v.now.d)), b = v.before ? Math.round(v.before.d) : null;
  const trend = b === null ? '' : !v.before ? '' : b - d >= 3 ? `, kommt näher (vor 20 min ${b} km)` : d - b >= 3 ? `, zieht weg (vor 20 min ${b} km)` : ', bleibt etwa gleich';
  const newRain = !v.before && v.now ? ', neu entstanden (Schauer?)' : '';
  const lvl = d <= 10 || (b !== null && b - d >= 3 && d <= 20) || newRain ? 'warn' : 'ok';
  return `<div class="rad-near ${lvl}"><b>Regen ${d <= 2 ? 'hier' : d + ' km ' + DIR8_ADJ[Math.round(v.now.deg / 45) % 8]}</b>${trend}${newRain} <span class="fine">(Radar ${when} Uhr)</span></div>`;
}
async function fillRadarNear(s) {
  const el = $('#radarNear');
  if (!el) return;
  try { const v = await radarNear(s.lat, s.lon); if ($('#radarNear') === el) el.innerHTML = radarNearHtml(v); }
  catch (e) { if ($('#radarNear') === el) el.innerHTML = `<p class="fine" style="margin:0">Regenradar nicht verfügbar (${esc(e.message)}).</p>`; }
}
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
  M.sites = L.layerGroup().addTo(M.map);
  M.map.on('zoomend', () => { if (S.plan) drawSites(); });
  setBase(BASES[store.get('base')] ? store.get('base') : 'color');
  const ov = store.get('ov', {});
  for (const k of Object.keys(OVERLAYS)) if (ov[k]) setOverlay(k, true);
  if (ov.radar) setRadar(true);
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
  drawSites();
  if (showOv('landings')) for (const l of S.plan.landings || []) {
    L.marker([l.lat, l.lon], { icon: L.divIcon({ className: '', iconSize: [14, 14], iconAnchor: [7, 7], html: '<div class="mk-l"></div>' }), title: 'Landeplatz ' + l.name, keyboard: true }).on('click', () => (RT.active ? routeClick({ lat: l.lat, lng: l.lon }, l.alt) : mapSheet('landing', l.id))).addTo(M.group);
  }
  if (showOv('stations')) for (const st of S.plan.stations || []) {
    if (!num(st.wind)) continue;
    L.marker([st.lat, st.lon], { icon: arrowIcon(st.dir, Math.round(st.wind)), title: `${st.name}: ${Math.round(st.wind)} km/h aus ${dirLabel(st.dir)}`, keyboard: true }).on('click', () => (RT.active ? routeClick({ lat: st.lat, lng: st.lon }) : mapSheet('station', st.code))).addTo(M.group);
  }
}
/**
 * Startplätze auf der Karte. Liegen Punkte näher als 38 Pixel beieinander (z.B. fünf Starts am Amisbühl),
 * werden sie zu einem Punkt mit dem besten Score und der Anzahl zusammengefasst. Antippen zeigt alle in einer Liste.
 */
function drawSites() {
  M.sites.clearLayers();
  const z = M.map.getZoom(), list = S.plan.sites.map(s => ({ s, b: s.days[S.day]?.best, p: M.map.project([s.lat, s.lon], z) }))
    .sort((x, y) => (y.s.blocked ? -1 : y.b?.score ?? -1) - (x.s.blocked ? -1 : x.b?.score ?? -1));
  const groups = [];
  for (const it of list) {
    const g = groups.find(g => g.p.distanceTo(it.p) < 38);
    if (g) g.m.push(it); else groups.push({ p: it.p, m: [it] });
  }
  for (const g of groups) {
    const top = g.m[0], s = top.s, b = top.b, c = s.blocked ? 'none' : cls(b?.score);
    const n = g.m.length;
    // ohne Bewertung (z.B. am Abend) nur ein kleiner grauer Punkt statt einer Kugel mit «–»
    const icon = !b && !s.blocked
      ? L.divIcon({ className: '', iconSize: [14, 14], iconAnchor: [7, 7], html: '<div class="mk-e"></div>' })
      : L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 17], html: `<div class="mk s-${c}${s.blocked ? ' blocked' : ''}">${s.blocked ? '✕' : b.score}${n > 1 ? `<span class="mk-n">${n}</span>` : ''}</div>` });
    const at = n > 1 ? M.map.unproject(g.p, z) : [s.lat, s.lon];
    L.marker(at, { icon, title: n > 1 ? `${n} Startplätze, bester ${s.name}: ${b ? b.score : 'keine Bewertung'}` : `${s.name}: ${b ? b.score : 'keine Bewertung'}`, keyboard: true, zIndexOffset: b ? b.score : 0 })
      .on('click', () => (RT.active ? routeClick({ lat: s.lat, lng: s.lon }, s.alt) : n > 1 ? mapSheet('group', g.m.map(x => x.s.id)) : mapSheet('site', s.id))).addTo(M.sites);
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
  } else if (kind === 'group') {
    const ss = id.map(siteById).filter(Boolean);
    const pts = ss.map(x => [x.lat, x.lon]);
    M.groupBounds = pts;
    h = `<div class="sheet-top"><div><h3>${ss.length} Startplätze hier</h3><p class="fine" style="margin:0">Bester zuerst. Antippen für Details.</p></div></div>
      <div class="sheet-list">${ss.map(x => { const b = x.days[S.day]?.best; return `<button type="button" class="sheet-row" data-act="site" data-id="${esc(x.id)}"><span><b>${esc(x.name)}</b><small>${x.alt} m · ${esc(aspectText(x))} · ${b ? winText(b) : 'kein Fenster'}</small></span><span class="mini-pill s-${x.blocked ? 'none' : cls(b?.score)}">${x.blocked ? '✕' : b ? b.score : '–'}</span></button>`; }).join('')}</div>
      <div class="sheet-act"><button class="btn sec" type="button" data-act="groupzoom">Hineinzoomen</button><button class="btn sec" type="button" data-act="closesheet">Schliessen</button></div>`;
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
    h = `<div class="sheet-top"><div><h3>${esc(st.name)}</h3><p class="fine" style="margin:0">${st.alt ?? '–'} m · ${ageTxt(ageMin(st.time, st.age))}</p></div></div><div class="kv"><div><b>${Math.round(st.wind)} ${arrow(st.dir)}</b><span>Wind km/h aus ${dirLabel(st.dir)}</span></div><div><b>${num(st.gust) ? Math.round(st.gust) : '–'}</b><span>Böen km/h</span></div><div><b>${num(st.temp) ? st.temp.toFixed(1) + '°' : '–'}</b><span>Temperatur</span></div></div><div class="sheet-act"><button class="btn sec" type="button" data-act="closesheet">Schliessen</button></div>`;
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
  if (t === 'group') groupLoad().catch(() => {});
  window.scrollTo({ top: 0 });
}
// «Für Profis» merkt sich, ob es offen war
document.addEventListener('toggle', e => { if (e.target.classList?.contains('pro-more')) store.set(e.target.dataset.k || 'proOpen', e.target.open); }, true);
document.addEventListener('click', async e => {
  const dlgEl = e.target.closest('dialog');
  if (e.target.tagName === 'DIALOG') { closeDlg(e.target); return; }
  const tab = e.target.closest('.tabs [data-tab]');
  if (tab) return setTab(tab.dataset.tab);
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act, id = b.dataset.id;
  switch (a) {
    case 'setup': showGate('setup'); break;
    case 'gate': showGate(b.dataset.v); break;
    case 'gateclose': closeGate(); break;
    case 'pweye': { const i = b.parentElement.querySelector('input'); i.type = i.type === 'password' ? 'text' : 'password'; b.setAttribute('aria-label', i.type === 'password' ? 'Passwort zeigen' : 'Passwort verbergen'); break; }
    case 'photo': photoMenu(); break;
    case 'profedit': profileEdit(); break;
    case 'logout': logout(); break;
    case 'pwchange': pwChange(); break;
    case 'delacc': deleteAccount(); break;
    case 'feedback': closeDlg($('#siteDlg')); feedbackForm(b.dataset.v || 'idea'); break;
    case 'nofly': closeDlg($('#siteDlg')); noflyForm(id || [...S.fav][0]); break;
    case 'survey': surveyForm(); break;
    case 'invite': inviteCreate(); break;
    case 'admin': openAdmin(); break;
    case 'admtab': ADM.tab = b.dataset.v; dlg('#siteDlg', adminHtml()); break;
    case 'admreset': try { const j = await jsonPost('/api/admin/invite', { kind: 'reset', uid: id }); inviteShow(j.code, 'reset'); } catch (err) { toast(err.message); } break;
    case 'admdel': {
      if (!(await ask({ title: `${b.dataset.v} entfernen?`, text: 'Konto, Flugbuch, Profil und Rückmeldungen werden gelöscht (vorher legt AFC eine Sicherung an).', ok: 'Entfernen', danger: true }))) break;
      try { await jsonPost('/api/admin/user/' + id, undefined, 'DELETE'); await adminLoad(); dlg('#siteDlg', adminHtml()); toast('Entfernt'); } catch (err) { toast(err.message); }
      break;
    }
    case 'admsurvey': try { await jsonPost('/api/admin/survey', { on: b.dataset.v === '1' }, 'PUT'); await adminLoad(); dlg('#siteDlg', adminHtml()); toast(b.dataset.v === '1' ? 'Umfrage eingeschaltet' : 'Umfrage ausgeschaltet'); } catch (err) { toast(err.message); } break;
    case 'admdone': try { await jsonPost('/api/admin/feedback/' + id, { done: b.dataset.v === '1' }, 'PUT'); await adminLoad(); dlg('#siteDlg', adminHtml()); } catch (err) { toast(err.message); } break;
    case 'admshot': try { const j = await rawFetch(`/api/admin/feedback/${id}/shot`).then(r => r.json()); if (j.shot) dlg('#msgDlg', `<div class="dlg-in"><img src="${esc(j.shot)}" alt="Bildschirmfoto" style="max-width:100%;border-radius:8px"><div class="btn-row"><button class="btn sec" type="button" data-act="closemsg">Schliessen</button></div></div>`); } catch (err) { toast(err.message); } break;
    case 'admerrclear': try { await jsonPost('/api/admin/errors', undefined, 'DELETE'); await adminLoad(); dlg('#siteDlg', adminHtml()); } catch (err) { toast(err.message); } break;
    case 'invshow': inviteShow(id, b.dataset.v); break;
    case 'invdel': try { await jsonPost('/api/admin/invite/' + id, undefined, 'DELETE'); await adminLoad(); dlg('#siteDlg', adminHtml()); } catch (err) { toast(err.message); } break;
    case 'invshare': navigator.share?.({ title: 'AFC-Testphase', text: ADM.share.text }).catch(() => {}); break;
    case 'invcopy': try { await navigator.clipboard.writeText(ADM.share.text); toast('Kopiert. Jetzt in WhatsApp einfügen.'); } catch { prompt('Kopieren:', ADM.share.text); } break;
    case 'day': S.day = Number(b.dataset.i); S.dayPicked = true; render(); if (b.classList.contains('hl-next')) window.scrollTo({ top: 0 }); break;
    case 'reload': loadPlan(true); break;
    case 'sources': setTab('profile'); setTimeout(() => $$('#v-profile .panel h3').find(h => h.textContent === 'Datenquellen')?.scrollIntoView({ behavior: 'smooth' }), 80); break;
    case 'toggle': S.open.has(id) ? S.open.delete(id) : S.open.add(id); store.set('open', [...S.open]); renderDecide(); break;
    case 'site': $('#mapSheet').hidden = true; openSite(id); break;
    case 'closesite': closeDlg($('#siteDlg')); break;
    case 'groupzoom': if (M.groupBounds) { M.map.fitBounds(M.groupBounds, { padding: [60, 60], maxZoom: 16 }); $('#mapSheet').hidden = true; } break;
    case 'week': openWeek(); break;
    case 'compare': openCompare(); break;
    case 'cmpday': S.day = Number(b.dataset.d); S.dayPicked = true; render(); openCompare(); break;
    case 'wksite': S.day = Number(b.dataset.d); S.dayPicked = true; render(); openSite(b.dataset.id); break;
    case 'wkday': S.day = Number(b.dataset.d); S.dayPicked = true; closeDlg($('#siteDlg')); render(); break;
    case 'closemsg': closeDlg($('#msgDlg')); break;
    case 'closesheet': $('#mapSheet').hidden = true; break;
    case 'fav': {
      S.fav.has(id) ? S.fav.delete(id) : S.fav.add(id); store.set('fav', [...S.fav]); pushSync();
      b.setAttribute('aria-pressed', String(S.fav.has(id)));
      if (!dlgEl) { if (S.tab === 'decide') renderDecide(); else if (S.tab === 'profile') renderProfile(); }
      else if (S.detailData) renderSite();
      break;
    }
    case 'hour': S.hour = Number(b.dataset.h); if (S.detailData) renderSite(); break;
    case 'level': if (S.level !== b.dataset.v) { S.level = b.dataset.v; store.set('level', S.level); store.set('levelManual', true); S.detail.clear(); render(); loadPlan(); } break;
    case 'theme': S.theme = b.dataset.v; store.set('theme', S.theme); render(); break;
    case 'sun': {
      // Umschalten zwischen Sonnenmodus und der vorherigen Darstellung
      if (S.theme === 'sun') S.theme = store.get('themeBeforeSun', 'auto');
      else { store.set('themeBeforeSun', S.theme); S.theme = 'sun'; }
      store.set('theme', S.theme); render(); toast(S.theme === 'sun' ? 'Sonnenmodus: grosse Schrift, starker Kontrast' : 'Sonnenmodus aus');
      break;
    }
    case 'check': {
      const key = 'check.' + todayKey(), cur = new Set(store.get(key, [])), i = Number(b.dataset.i);
      b.checked ? cur.add(i) : cur.delete(i); store.set(key, [...cur]);
      // Fortschritt nachführen, ohne die Liste neu zu zeichnen (sonst springt der Fokus)
      const box = b.closest('.chk-box'), all = cur.size >= CHECKS.length;
      if (box) { const t = box.querySelector('.chk-n'); t.textContent = all ? '✓ alles erledigt' : `${cur.size} von ${CHECKS.length}`; t.classList.toggle('ok', all); box.querySelector('.chk-bar i').style.width = Math.round(cur.size / CHECKS.length * 100) + '%'; }
      break;
    }
    case 'report': closeDlg($('#siteDlg')); reportForm(id); break;
    case 'showmap': closeDlg($('#siteDlg')); setTab('map'); setTimeout(() => { const s = siteById(id); if (M.map && s) { M.map.setView([s.lat, s.lon], 14); mapSheet('site', id); } }, 200); break;
    case 'layers': { const p = $('#layerPanel'); p.hidden = !p.hidden; b.setAttribute('aria-expanded', String(!p.hidden)); break; }
    case 'locate': locate(); break;
    case 'wind': W.level = b.dataset.lvl; store.set('wind', W.level); updateWind(); break;
    case 'tab': if (dlgEl) closeDlg(dlgEl); setTab(b.dataset.tab); break;
    case 'grpday': G.date = b.dataset.v || null; G.data = null; renderGroup(); break;
    case 'grplike': try { groupSet(await jsonPost(`/api/community/${id}/like${G.date ? '?date=' + G.date : ''}`)); } catch (err) { toast(err.message); } break;
    case 'grpdel': if (await ask({ title: 'Beitrag löschen?', text: 'Antworten darauf werden auch gelöscht.', ok: 'Löschen', danger: true })) { try { groupSet(await jsonPost(`/api/community/${id}${G.date ? '?date=' + G.date : ''}`, undefined, 'DELETE')); } catch (err) { toast(err.message); } } break;
    case 'grpshare': try { await jsonPost('/api/me', { prefs: { shareName: b.checked } }, 'PUT'); await groupLoad(); toast(b.checked ? 'Dein Name erscheint bei deinen Flügen' : 'Deine Flüge zählen ohne Namen'); } catch (err) { toast(err.message); } break;
    case 'barfold': store.set('barFold', !$('#windBar').classList.contains('folded')); syncWindBar(); break;
    case 'route': routeStart(); break;
    case 'intro': showIntro(); break;
    case 'lbflight': lbLoad().then(() => flightForm(id)).catch(err => toast(err.message)); break;
    case 'lbgear': lbLoad().then(() => gearForm(id)).catch(err => toast(err.message)); break;
    case 'lbyear': LB.year = b.dataset.v; renderBook(); break;
    case 'fb': {
      const f = LB.data?.flights.find(x => x.id === id);
      if (!f) break;
      try {
        await lbSave('flight', { ...f, afcVerdict: b.dataset.v }, true);
        const fb = LG().siteFeedback(LB.data.flights)[f.siteId];
        toast(b.dataset.v === 'richtig' ? 'Danke! Gut zu wissen.' : fb?.adj ? `Danke! AFC passt die Bewertung für ${f.siteName} an (${fb.adj > 0 ? '+' : ''}${fb.adj}).` : `Danke! Ab ${LG().FEEDBACK_MIN_N} Rückmeldungen passt AFC die Bewertung für ${f.siteName} an.`);
        rerender(); if (b.dataset.v !== 'richtig') loadPlan();
      } catch (err) { toast('Nicht gespeichert: ' + err.message); }
      break;
    }
    case 'camset': camSet(id); break;
    case 'volteset': volteSet(id, b); break;
    case 'sort': if (b.dataset.v === 'near') { if (S.pos) { S.sort = 'near'; store.set('sort', 'near'); renderDecide(); } else locateNear(); } else { S.sort = 'best'; store.set('sort', 'best'); renderDecide(); } break;
    case 'watch': toggleWatch(id); break;
    case 'pushon': pushEnable(); break;
    case 'pushoff': pushDisable(); break;
    case 'pushtest': pushTest(); break;
    case 'fbskip': store.set('fbSkip', [...store.get('fbSkip', []), id].slice(-50)); rerender(); break;
    case 'lbcsv': lbExport('csv'); break;
    case 'lbjson': lbExport('json'); break;
    case 'lbprint': lbLoad().then(lbPrint).catch(err => toast(err.message)); break;
    case 'lbbackup': {
      try {
        const r = await lbFetch('/api/logbook/backup', { method: 'POST' });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'Fehler ' + r.status);
        LB.data.backup = j.backup; renderBook();
        toast(!j.backup.at ? 'Das Flugbuch ist noch leer' : j.backup.cloudError ? 'Auf dem Mac gesichert, iCloud hat nicht geklappt' : 'Flugbuch gesichert');
      } catch (err) { toast('Sicherung fehlgeschlagen: ' + err.message); }
      break;
    }
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
      store.del('updSkip'); renderUpdBanner(); refreshStatus();
      break;
    }
    case 'btrun': {
      b.disabled = true;
      try { const r = await fetch('/api/backtest', { method: 'POST', headers: { 'X-AFC-Client': clientId } }); const j = await r.json(); if (!r.ok) throw new Error(j.error); if (ST.data) ST.data.backtest = j; toast('Rückblick-Test läuft, dauert einige Minuten'); }
      catch (err) { toast('Nicht gestartet: ' + err.message); }
      refreshStatus();
      setTimeout(loadStatus, 180000);
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
      if (!(await ask({ title: 'Daten löschen?', text: 'Gemeldete Flüge («Flug melden») werden gelöscht. Dein Flugbuch, Favoriten und Einstellungen bleiben.', ok: 'Löschen', danger: true }))) break;
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
  const fid = e.target.id;
  if (['gateForm', 'profForm', 'pwForm', 'fbForm', 'noflyForm', 'surveyForm', 'grpForm'].includes(fid) || e.target.classList?.contains('grp-reply')) e.preventDefault();
  if (fid === 'gateForm') gateSubmit(e.target);
  if (fid === 'profForm') saveProfile(e.target);
  if (fid === 'fbForm') sendFeedback(e.target);
  if (fid === 'noflyForm') sendNofly(e.target);
  if (fid === 'grpForm' || e.target.classList?.contains('grp-reply')) groupPost(e.target);
  if (fid === 'surveyForm') sendSurvey(e.target);
  if (fid === 'pwForm') {
    const f = Object.fromEntries(new FormData(e.target)), err = e.target.querySelector('.gate-err');
    jsonPost('/api/me/password', f).then(() => { closeDlg($('#msgDlg')); toast('Passwort geändert'); }).catch(x => { err.textContent = x.message; });
  }
  if (e.target.id === 'pilotForm') { e.preventDefault(); savePilot(e.target); }
  if (e.target.id === 'lbSettings') {
    e.preventDefault();
    const x = Object.fromEntries(new FormData(e.target));
    lbSave('settings', { ...LB.data.settings, flightsBefore: x.flightsBefore, hoursBefore: x.hoursBefore }).then(() => { toast('Gespeichert'); renderBook(); }).catch(err => toast(err.message));
  }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches('select[data-cmp]')) {
    const ids = [...document.querySelectorAll('select[data-cmp]')].map(x => x.value).filter(Boolean);
    store.set('cmp', [...new Set(ids)]); openCompare(); return;
  }
  if (t.id === 'lbIgc') { importIgc([...t.files]); t.value = ''; return; }
  if (t.id === 'photoIn') { setPhoto(t.files[0]); t.value = ''; return; }
  if (t.closest('#fbForm') && t.name === 'kind') { const ta = $('#fbForm textarea'); if (ta) ta.placeholder = FB_KINDS[t.value][1]; return; }
  if (t.closest('#fbForm') && t.name === 'shot') { const l = t.closest('label'); if (l && t.files[0]) l.firstChild.textContent = 'Bild angehängt ✓ '; return; }
  if (t.id === 'lbRestore') { lbRestore(t.files[0]); t.value = ''; return; }
  if (t.closest('#grpForm')) {
    const f = new FormData($('#grpForm'));
    G.form = { kind: f.get('kind'), siteId: f.get('siteId'), date: f.get('date'), text: f.get('text') }; store.set('grpForm', G.form);
    if (t.name === 'kind') { const d = $('#grpForm .grp-date'); if (d) d.hidden = t.value !== 'plan'; }
    return;
  }
  if (t.closest('#pushForm')) {
    const f = new FormData($('#pushForm'));
    store.set('pushPrefs', { good: f.has('good'), foehn: f.has('foehn'), gear: f.has('gear'), health: f.has('health'), review: f.has('review'), threshold: Number(f.get('threshold')) || 75 });
    pushSync(); return;
  }
  if (t.matches('#layerPanel input[name="base"]')) setBase(t.value);
  else if (t.matches('#layerPanel input[name="ov"]')) { if (t.value === 'radar') setRadar(t.checked); else if (t.value in OVERLAYS) setOverlay(t.value, t.checked); else { store.set('ov', { ...store.get('ov', {}), [t.value]: t.checked }); if (t.value === 'air' || t.value === 'wild') updateAir(); else renderMap(); } }
});
// IGC-Dateien aufs Flugbuch ziehen
document.addEventListener('dragover', e => { if (S.tab === 'book' && e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
document.addEventListener('drop', e => {
  if (S.tab !== 'book' || !e.dataTransfer?.files?.length) return;
  e.preventDefault();
  importIgc([...e.dataTransfer.files].filter(f => /\.igc$/i.test(f.name)));
});
document.addEventListener('input', e => {
  if (e.target.closest?.('#profForm')) profHint();
  if (e.target.id === 'windHour') { W.hour = Number(e.target.value); $('#windHourT').textContent = `${W.hour} Uhr`; clearTimeout(W.t); W.t = setTimeout(() => { updateWind(); updateThermal(); if (RT.res) computeRoute(); }, 150); }
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-act="hour"]')) { e.preventDefault(); e.target.click(); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - S.loadedAt > 3 * 60000) loadPlan(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (S.theme === 'auto') applyTheme(); });
matchMedia('(min-width: 900px)').addEventListener?.('change', () => { if (S.tab === 'lage') renderLage(); });

/* ---------------------------------------------------------------- Konten (Testphase) */
// Der Mac kennt die Piloten. Ohne Konto auf dem Mac (alter Betrieb) läuft alles wie bisher ohne Anmeldung.
const ME = { state: null, user: store.get('me')?.user || null, profile: store.get('me')?.profile || {}, prefs: {}, stats: store.get('me')?.stats || null, survey: false, gate: null };
const isAdminMe = () => ME.user?.role === 'admin';
const jsonPost = (url, body, method = 'POST') => rawFetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-AFC-Client': clientId }, body: body === undefined ? undefined : JSON.stringify(body) })
  .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Fehler ' + r.status); return j; });
const PERSONAL = ['fav', 'level', 'levelManual', 'pilot', 'det', 'log', 'fbSkip', 'me', 'cmp', 'pushSig', 'logMigrated', 'open', 'grpForm', 'grpSeen'];
const initials = n => String(n || '').trim().split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
const PERSON_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="9" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 20c1-3.5 3.7-5 7-5s6 1.5 7 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
function avatarHtml(u, cls = '') {
  return `<span class="av ${cls}" aria-hidden="true">${u?.photo ? `<img src="${esc(u.photo)}" alt="" loading="lazy">` : u?.name ? esc(initials(u.name)) : PERSON_SVG}</span>`;
}
function renderMe() {
  const b = $('#meBtn');
  if (b) { b.innerHTML = avatarHtml(ME.user); b.setAttribute('aria-label', ME.user ? `Mein Profil (${ME.user.name})` : 'Mein Profil'); }
  const f = $('#fbBtn'); if (f) f.hidden = !ME.user;
}
function setMe(j) {
  ME.user = j.user; ME.profile = j.profile || {}; ME.prefs = j.prefs || {}; ME.stats = j.stats || null; ME.survey = !!j.survey;
  store.set('me', { user: ME.user, profile: ME.profile, stats: ME.stats });
  renderMe();
}
const prefsLocal = () => ({ fav: [...S.fav], level: S.level, levelManual: !!store.get('levelManual'), pilot: store.get('pilot', null) });
let prefT = null;
store.changed = () => {
  if (!ME.user || ME.applying) return;
  clearTimeout(prefT);
  prefT = setTimeout(() => jsonPost('/api/me', { prefs: prefsLocal() }, 'PUT').then(j => { ME.stats = j.stats; }).catch(() => {}), 700);
};
/** Einstellungen vom Mac übernehmen; beim ersten Mal die Einstellungen dieses Geräts hochladen. */
function applyServerPrefs(j) {
  if (!j.prefsSet) { store.changed(); return; }
  const p = j.prefs;
  ME.applying = true;
  try {
    S.fav = new Set(p.fav || []); store.set('fav', [...S.fav]);
    if (p.pilot) store.set('pilot', p.pilot); else store.del('pilot');
    if (p.levelManual) store.set('levelManual', true); else store.del('levelManual');
    if (p.level) { S.level = p.level; store.set('level', p.level); }
  } finally { ME.applying = false; }
}
/** Beim Start: angemeldet? Einladung im Link? Ohne Verbindung mit dem gespeicherten Stand weiter. */
async function authInit() {
  const q = new URLSearchParams(location.search), code = q.get('invite') || q.get('reset');
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await rawFetch('/api/auth/state' + (code ? '?invite=' + encodeURIComponent(code) : ''), { cache: 'no-store', signal: ctl.signal });
    const st = await r.json();
    ME.state = st;
    if (code) {
      if (st.invite?.ok) { showGate(st.invite.kind === 'reset' ? 'reset' : 'register', { code, name: st.invite.name }); return false; }
      history.replaceState(null, '', '/');
      if (st.auth && !st.user) { showGate('login', { msg: 'Dieser Link ist nicht mehr gültig oder wurde schon benutzt. Hast du schon ein Konto? Dann hier anmelden. Sonst bitte Lars um einen neuen Link.' }); return false; }
    }
    if (st.auth && !st.user) { for (const k of PERSONAL) store.del(k); ME.user = null; showGate('login'); return false; }
    if (!st.auth) { ME.user = null; store.del('me'); renderMe(); return true; }
    const j = await rawFetch('/api/me', { cache: 'no-store' }).then(x => x.json());
    setMe(j); applyServerPrefs(j);
    return true;
  } catch { renderMe(); return true; }   // kein Empfang: mit dem gespeicherten Stand weiter
  finally { clearTimeout(to); }
}

/* ---- Anmeldung, Einladung, neues Passwort, erstes Konto */
function gateHtml(mode, o) {
  const pw = (name, ac, label = 'Passwort') => `<label class="fld"><span>${label}</span><span class="pw-wrap"><input type="password" name="${name}" autocomplete="${ac}" required minlength="${ac === 'new-password' ? 8 : 1}"><button type="button" class="pw-eye" data-act="pweye" aria-label="Passwort zeigen">👁</button></span></label>`;
  const email = `<label class="fld"><span>E-Mail</span><input type="email" name="email" autocomplete="username" inputmode="email" autocapitalize="off" required></label>`;
  const name = `<label class="fld"><span>Vor- und Nachname</span><input type="text" name="name" autocomplete="name" required minlength="2" maxlength="60"></label>`;
  const T = {
    login: ['Anmelden', 'Willkommen zurück. Melde dich mit deiner E-Mail und deinem Passwort an.', `${email}${pw('password', 'current-password')}`, 'Anmelden',
      '<p class="fine">Passwort vergessen? Schreib Lars kurz, er schickt dir einen Link für ein neues Passwort.</p>'],
    register: ['Willkommen bei AFC', 'Lars hat dich zur Testphase eingeladen. Erstelle dein Konto, das dauert eine Minute.', `${name}${email}${pw('password', 'new-password', 'Passwort (mindestens 8 Zeichen)')}
      <label class="chk gate-chk"><input type="checkbox" name="privacy" required><span>Ich habe die <a href="/privacy" target="_blank" rel="noopener">Datenschutzerklärung</a> gelesen. Meine Daten bleiben auf dem Mac von Lars.</span></label>`, 'Konto erstellen',
      '<p class="fine">Schon ein Konto? <button type="button" class="linkbtn" data-act="gate" data-v="login">Hier anmelden</button></p>'],
    reset: ['Neues Passwort', `${o.name ? esc(o.name) + ', w' : 'W'}ähle ein neues Passwort. Danach bist du gleich angemeldet.`, pw('password', 'new-password', 'Neues Passwort (mindestens 8 Zeichen)'), 'Passwort speichern', ''],
    setup: ['Dein Konto einrichten', 'Du wirst Admin von AFC. Dein Flugbuch, deine Favoriten und deine Einstellungen gehören danach zu diesem Konto. Erst danach kannst du Freunde einladen.', `${name}${email}${pw('password', 'new-password', 'Passwort (mindestens 8 Zeichen)')}`, 'Konto erstellen',
      '<p class="fine"><button type="button" class="linkbtn" data-act="gateclose">Später</button></p>']
  }[mode];
  return `<div class="gate-in" role="dialog" aria-modal="true" aria-labelledby="gateT">
    <div class="gate-brand"><img src="/icon-192.png" alt="" width="56" height="56"><div><b>AFC</b><span>Flugwetter Berner Oberland · Testphase</span></div></div>
    <h1 id="gateT">${T[0]}</h1><p class="gate-lead">${T[1]}</p>
    ${o.msg ? `<p class="gate-msg">${esc(o.msg)}</p>` : ''}
    <form id="gateForm" data-mode="${mode}" data-code="${esc(o.code || '')}" novalidate>${T[2]}
      <p class="gate-err" role="alert"></p>
      <button class="btn gate-go" type="submit">${T[3]}</button></form>
    ${T[4]}</div>`;
}
function showGate(mode, o = {}) {
  let g = $('#gate');
  if (!g) { g = document.createElement('div'); g.id = 'gate'; g.className = 'gate'; document.body.append(g); }
  ME.gate = mode; document.body.classList.add('gated');
  g.innerHTML = gateHtml(mode, o);
  setTimeout(() => g.querySelector('input')?.focus(), 50);
}
function closeGate() { $('#gate')?.remove(); ME.gate = null; document.body.classList.remove('gated'); }
async function gateSubmit(form) {
  const mode = form.dataset.mode, f = Object.fromEntries(new FormData(form)), err = form.querySelector('.gate-err'), btn = form.querySelector('.gate-go');
  err.textContent = '';
  if ((mode === 'register' || mode === 'setup') && (f.name || '').trim().length < 2) { err.textContent = 'Bitte deinen Namen eingeben.'; return; }
  if (mode !== 'reset' && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test((f.email || '').trim())) { err.textContent = 'Bitte eine gültige E-Mail-Adresse eingeben.'; return; }
  if (mode !== 'login' && (f.password || '').length < 8) { err.textContent = 'Das Passwort braucht mindestens 8 Zeichen.'; return; }
  if (mode === 'register' && !f.privacy) { err.textContent = 'Bitte bestätige, dass du die Datenschutzerklärung gelesen hast.'; return; }
  btn.disabled = true; btn.textContent = 'Einen Moment …';
  try {
    await jsonPost({ login: '/api/auth/login', register: '/api/auth/register', reset: '/api/auth/reset', setup: '/api/auth/setup' }[mode], { ...f, email: f.email?.trim(), invite: form.dataset.code || undefined, prefs: mode === 'setup' ? prefsLocal() : undefined });
    if (mode === 'login' || mode === 'register') for (const k of PERSONAL) store.del(k);   // Gerät könnte vorher jemand anderem gehört haben
    store.set('welcome', mode);
    location.replace(mode === 'register' || mode === 'setup' ? '/?tab=profile' : '/');
  } catch (e) { err.textContent = e.message; btn.disabled = false; btn.textContent = { login: 'Anmelden', register: 'Konto erstellen', reset: 'Passwort speichern', setup: 'Konto erstellen' }[mode]; }
}
async function logout() {
  if (!(await ask({ title: 'Abmelden?', text: 'Auf diesem Gerät abmelden. Dein Flugbuch und dein Profil bleiben auf dem Mac gespeichert.', ok: 'Abmelden' }))) return;
  if (PU.sub) await pushDisable().catch(() => {});
  await jsonPost('/api/auth/logout').catch(() => {});
  for (const k of PERSONAL) store.del(k);
  location.replace('/');
}
function welcomeToast() {
  const w = store.get('welcome'); if (!w) return;
  store.del('welcome');
  if (w === 'register') {
    toast(`Willkommen, ${ME.user?.name?.split(' ')[0] || ''}! Fülle jetzt kurz dein Pilotenprofil aus.`);
    // die Einführung kommt zuerst und führt am Ende ins Profil; sonst gleich das Profil öffnen
    if ((store.get('intro') ?? 0) >= INTRO_VER) { const go = (n = 0) => (S.plan || n > 20 ? profileEdit() : setTimeout(() => go(n + 1), 500)); setTimeout(go, 600); }
  }
  else if (w === 'setup') toast('Konto erstellt. Jetzt kannst du unter «Testphase» Freunde einladen.');
  else if (w === 'reset') toast('Neues Passwort gespeichert');
  else toast(`Hoi ${ME.user?.name?.split(' ')[0] || ''}!`);
}

/* ---- Pilotenprofil (Runde 3): Karte, Bild, ausführliches Profil */
const LICENSES = { student: 'In Ausbildung (Schülerausweis)', brevet: 'Brevet', brevetXc: 'Brevet mit Streckenflug-Erfahrung', tandem: 'Tandem-Brevet', instructor: 'Fluglehrer/in' };
const STYLES = { thermal: 'Thermik', soaring: 'Soaring', xc: 'Strecke', glide: 'Abgleiter und Genussflüge', hike: 'Hike & Fly', acro: 'Akro', tandem: 'Tandem', skiing: 'Speedflying' };
const PROFILE_KEYS = ['license', 'since', 'wing', 'wingArea', 'weight', 'wingMin', 'harness', 'reserve', 'styles', 'homes', 'emergName', 'emergPhone'];
function profileDone(p) {
  const has = k => (Array.isArray(p[k]) ? p[k].length : p[k] != null && p[k] !== '');
  return Math.round((PROFILE_KEYS.filter(has).length + (ME.user?.photo ? 1 : 0)) / (PROFILE_KEYS.length + 1) * 100);
}
function wingLoad(p) {
  const r = {};
  if (num(p.weight) && num(p.wingArea)) r.load = p.weight / p.wingArea;
  if (num(p.weight) && num(p.wingMin) && num(p.wingMax) && p.wingMax > p.wingMin) r.pos = (p.weight - p.wingMin) / (p.wingMax - p.wingMin);
  return r;
}
function myStats() {
  const d = LB.data, L = LG();
  if (d && L) {
    const st = L.logStats(d.flights, d.settings);
    return { flights: st.total, hours: Math.round(st.totalMin / 6) / 10, year: st.yearFlights, yearLbl: st.year, last: st.last?.date || null };
  }
  const s = ME.stats;
  return s ? { flights: s.flights, hours: s.hours, year: s.year, yearLbl: new Date().getFullYear(), last: s.last } : null;
}
function pilotCard() {
  if (!ME.user) {
    if (ME.state && !ME.state.auth) return `<div class="panel setup-card"><h3>Testphase: zuerst dein Konto</h3><p>Damit deine Freunde AFC testen können, braucht jeder ein eigenes Konto. Richte zuerst deines ein: dein Flugbuch, deine Favoriten und deine Einstellungen werden übernommen.</p><div class="btn-row" style="justify-content:flex-start"><button class="btn" type="button" data-act="setup">Mein Konto einrichten</button></div></div>`;
    return '';
  }
  const p = ME.profile || {}, st = myStats(), wl = wingLoad(p), done = profileDone(p);
  const areas = (p.homes || []).map(id => S.plan?.areas.find(a => a.id === id)?.name).filter(Boolean);
  const sub = [p.license && LICENSES[p.license], p.since && `fliegt seit ${p.since}`, p.club].filter(Boolean).join(' · ');
  return `<section class="pcard" aria-label="Pilotenkarte">
    <div class="pcard-top">
      <button type="button" class="pcard-av" data-act="photo" aria-label="Profilbild ${ME.user.photo ? 'ändern' : 'hinzufügen'}">${avatarHtml(ME.user, 'big')}<span class="pcard-cam" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/></svg></span></button>
      <div class="pcard-t"><h2>${esc(ME.user.name)}</h2><p>${esc(sub || 'Pilotenprofil noch leer')}</p>
        ${areas.length ? `<p class="pcard-homes">${areas.map(a => `<span>${esc(a)}</span>`).join('')}</p>` : ''}
        ${(p.styles || []).length ? `<p class="pcard-styles">${p.styles.map(s => esc(STYLES[s] || s)).join(' · ')}</p>` : ''}</div>
    </div>
    <div class="pcard-stats">
      <div><b>${st ? st.flights : '–'}</b><span>Flüge</span></div>
      <div><b>${st ? Math.round(st.hours) : '–'}</b><span>Stunden</span></div>
      <div><b>${st ? st.year : '–'}</b><span>Flüge ${st ? st.yearLbl : ''}</span></div>
      <div><b>${num(wl.load) ? wl.load.toFixed(1) : '–'}</b><span>kg/m²${num(wl.pos) ? ` · ${wl.pos < 0 ? 'unter' : wl.pos > 1 ? 'über' : Math.round(wl.pos * 100) + ' % im'} Bereich` : ''}</span></div>
    </div>
    ${p.wing ? `<p class="pcard-gear">${esc([p.wing, p.wingSize].filter(Boolean).join(' '))}${p.harness ? ' · ' + esc(p.harness) : ''}${p.reserve ? ' · Retter ' + esc(p.reserve) : ''}</p>` : ''}
    ${done < 100 ? `<div class="pcard-done"><span>Profil zu ${done} % ausgefüllt</span><span class="chk-bar" aria-hidden="true"><i style="width:${done}%"></i></span></div>` : ''}
    <div class="btn-row" style="justify-content:flex-start"><button class="btn${done < 60 ? '' : ' sec'}" type="button" data-act="profedit">${done < 60 ? 'Profil ausfüllen' : 'Profil bearbeiten'}</button>${ME.user.photo ? '' : '<button class="btn sec" type="button" data-act="photo">Foto hinzufügen</button>'}</div>
    <input type="file" id="photoIn" accept="image/*" hidden>
  </section>`;
}
function profileEdit() {
  if (!ME.user) return;
  const p = ME.profile || {}, pi = store.get('pilot', {});
  const v = x => (x == null ? '' : esc(x));
  const areas = S.plan?.areas || [];
  const f = (name, label, val, type = 'text', extra = '') => `<label class="fld"><span>${label}</span><input type="${type}" name="${name}" value="${v(val)}" ${extra}></label>`;
  const n = (name, label, val, extra = '') => f(name, label, val, 'number', `inputmode="decimal" ${extra}`);
  const y = new Date().getFullYear();
  dlg('#msgDlg', `<div class="dlg-in"><div class="dlg-h"><h2 id="msgDlgT">Mein Pilotenprofil</h2><button class="x-btn" type="button" data-act="closemsg" aria-label="Schliessen">×</button></div>
    <form id="profForm" class="prof-form">
      <fieldset><legend>Über mich</legend>
        ${f('name', 'Name', ME.user.name, 'text', 'autocomplete="name" required maxlength="60"')}
        <label class="fld"><span>Ausbildung</span><select name="license"><option value="">– bitte wählen –</option>${Object.entries(LICENSES).map(([k, t]) => `<option value="${k}" ${p.license === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        ${n('since', 'Fliege seit (Jahr)', p.since, `min="1970" max="${y}" placeholder="z.B. 2018"`)}
        <div class="fld-pair">${n('flights', 'Flüge total', pi.flights, 'min="0" max="20000" placeholder="z.B. 150"')}${n('hours12', 'Flugstunden letzte 12 Monate', pi.hours12, 'min="0" max="2000" placeholder="z.B. 25"')}</div>
        <p class="fine lb-wide" style="margin:0">Daraus rechnet AFC deine Stufe (Vorsichtig, Normal, Erfahren) und damit deine Wind- und Böengrenzen.</p>
        ${n('birthYear', 'Jahrgang (freiwillig)', p.birthYear, `min="1920" max="${y - 10}"`)}
        ${f('club', 'Club (freiwillig)', p.club, 'text', 'maxlength="60" placeholder="z.B. GSC Interlaken"')}
        <label class="chk"><input type="checkbox" name="shv" ${p.shv ? 'checked' : ''}><span>Mitglied beim SHV</span></label>
      </fieldset>
      <fieldset><legend>Ausrüstung</legend>
        ${f('wing', 'Schirm (Marke und Modell)', p.wing, 'text', 'maxlength="60" placeholder="z.B. Advance Iota DLS"')}
        ${f('wingSize', 'Grösse', p.wingSize, 'text', 'maxlength="12" placeholder="z.B. 25"')}
        <label class="fld"><span>Schirmklasse</span><select name="glider">${Object.entries(P()?.GLIDERS || {}).map(([k, t]) => `<option value="${k}" ${(pi.glider || 'B') === k ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        ${n('wingArea', 'Fläche ausgelegt (m²)', p.wingArea, 'min="10" max="45" step="0.1" placeholder="z.B. 24.5"')}
        <div class="fld-pair">${n('wingMin', 'Gewichtsbereich von (kg)', p.wingMin, 'min="30" max="250"')}${n('wingMax', 'bis (kg)', p.wingMax, 'min="30" max="250"')}</div>
        ${n('weight', 'Startgewicht mit Ausrüstung (kg)', p.weight, 'min="30" max="250"')}
        <p class="fine lb-wide" id="wlHint"></p>
        ${f('harness', 'Gurtzeug', p.harness, 'text', 'maxlength="60"')}
        ${f('reserve', 'Retter', p.reserve, 'text', 'maxlength="60"')}
      </fieldset>
      <fieldset><legend>So fliege ich</legend>
        <div class="chips" role="group" aria-label="Flugstil">${Object.entries(STYLES).map(([k, t]) => `<label class="chip"><input type="checkbox" name="styles" value="${k}" ${(p.styles || []).includes(k) ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div>
        <p class="fine lb-wide" style="margin:10px 0 4px">Meine Hausgebiete (bis 6)</p>
        <div class="chips" role="group" aria-label="Hausgebiete">${areas.map(a => `<label class="chip"><input type="checkbox" name="homes" value="${esc(a.id)}" ${(p.homes || []).includes(a.id) ? 'checked' : ''}><span>${esc(a.name)}</span></label>`).join('')}</div>
        <p class="fine lb-wide" style="margin:10px 0 0">Meine eigenen Grenzen: AFC weist dich darauf hin, wenn es mehr bläst.</p>
        <div class="fld-pair">${n('maxWind', 'Wind höchstens (km/h)', p.maxWind, 'min="5" max="60" placeholder="z.B. 20"')}${n('maxGust', 'Böen höchstens (km/h)', p.maxGust, 'min="5" max="70" placeholder="z.B. 28"')}</div>
      </fieldset>
      <fieldset><legend>Notfall</legend>
        <p class="fine lb-wide" style="margin:0">Nur für dich und Lars sichtbar, falls nach einem Flug etwas ist.</p>
        ${f('emergName', 'Kontaktperson', p.emergName, 'text', 'maxlength="60" autocomplete="off"')}
        ${f('emergPhone', 'Telefon der Kontaktperson', p.emergPhone, 'tel', 'maxlength="30" autocomplete="off"')}
        ${f('phone', 'Meine Handynummer (freiwillig)', p.phone, 'tel', 'maxlength="30" autocomplete="tel"')}
      </fieldset>
      <fieldset><legend>Kurz über mich (freiwillig)</legend>
        <label class="fld lb-wide"><span class="sr">Über mich</span><textarea name="bio" rows="3" maxlength="300" placeholder="z.B. Fliege meistens am Niederhorn, am liebsten am Abend.">${v(p.bio)}</textarea></label>
      </fieldset>
      <p class="gate-err" id="profErr" role="alert"></p>
      <div class="btn-row"><button class="btn sec" type="button" data-act="closemsg">Abbrechen</button><button class="btn" type="submit">Speichern</button></div>
    </form></div>`);
  $('#msgDlg').classList.add('dlg-big');
  $('#msgDlg').addEventListener('close', () => $('#msgDlg').classList.remove('dlg-big'), { once: true });
  profHint();
}
function profFormData(form) {
  const fd = new FormData(form), o = {};
  for (const k of ['license', 'since', 'birthYear', 'club', 'wing', 'wingSize', 'wingArea', 'wingMin', 'wingMax', 'weight', 'harness', 'reserve', 'maxWind', 'maxGust', 'emergName', 'emergPhone', 'phone', 'bio']) o[k] = (fd.get(k) ?? '').toString().trim() || null;
  for (const k of ['since', 'birthYear', 'wingArea', 'wingMin', 'wingMax', 'weight', 'maxWind', 'maxGust']) o[k] = o[k] == null ? null : Number(o[k]);
  o.shv = fd.has('shv'); o.styles = fd.getAll('styles'); o.homes = fd.getAll('homes').slice(0, 6);
  return o;
}
function profHint() {
  const form = $('#profForm'), el = $('#wlHint');
  if (!form || !el) return;
  const p = profFormData(form), w = wingLoad(p);
  el.textContent = num(w.load) || num(w.pos) ? `Flächenbelastung ${num(w.load) ? w.load.toFixed(2) + ' kg/m²' : '–'}${num(w.pos) ? `, ${w.pos < 0 ? 'unter dem Gewichtsbereich: Schirm reagiert träger, bei Wind heikel' : w.pos > 1 ? 'über dem Gewichtsbereich: nicht zugelassen' : w.pos < 0.35 ? `im unteren Drittel (${Math.round(w.pos * 100)} %): ruhiger, langsamer, bei Wind weniger Reserve` : w.pos > 0.75 ? `im oberen Viertel (${Math.round(w.pos * 100)} %): schneller und dynamischer` : `in der Mitte des Bereichs (${Math.round(w.pos * 100)} %)`}` : ''}.` : 'Mit Fläche, Gewichtsbereich und Startgewicht rechnet AFC deine Flächenbelastung aus.';
}
async function saveProfile(form) {
  const p = profFormData(form), name = new FormData(form).get('name');
  const err = $('#profErr'); err.textContent = '';
  if (p.homes.length > 6) { err.textContent = 'Höchstens 6 Hausgebiete.'; return; }
  try {
    const fd = new FormData(form), int = k => { const v = fd.get(k); return v === '' || v == null ? null : Math.max(0, Math.round(Number(v))); };
    const pi = { ...store.get('pilot', {}), glider: fd.get('glider') || 'B', student: p.license === 'student', flights: int('flights'), hours12: int('hours12') };
    store.set('pilot', pi); store.del('levelManual');
    // Stufe wie unter «Ich als Pilot» neu rechnen: Schüler sind immer «Vorsichtig»
    const pl = P()?.pilotLevel(pi), lvChanged = pl && pl.level !== S.level;
    if (lvChanged) { S.level = pl.level; store.set('level', S.level); }
    const j = await jsonPost('/api/me', { name, profile: p, prefs: { ...prefsLocal(), pilot: pi } }, 'PUT');
    setMe(j); closeDlg($('#msgDlg')); toast(pl ? `Profil gespeichert, Stufe «${LEVEL_INFO[pl.level][0]}»` : 'Profil gespeichert'); S.detail.clear();
    lbAlignBefore().catch(() => {});
    render(); if (lvChanged) loadPlan();
  } catch (e) { err.textContent = 'Nicht gespeichert: ' + e.message; }
}
/** Profilbild: auf dem Gerät quadratisch zuschneiden und verkleinern (320 px JPEG), dann hochladen. */
async function setPhoto(file) {
  if (!file) return;
  if (!/^image\//.test(file.type) && !/\.(jpe?g|png|heic|webp)$/i.test(file.name)) { toast('Bitte ein Bild wählen.'); return; }
  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Bild nicht lesbar')); i.src = url; });
    const s = Math.min(img.naturalWidth, img.naturalHeight), c = document.createElement('canvas');
    c.width = c.height = 320;
    c.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 320, 320);
    URL.revokeObjectURL(url);
    const j = await jsonPost('/api/me/photo', { photo: c.toDataURL('image/jpeg', 0.86) }, 'PUT');
    setMe(j); toast('Profilbild gespeichert'); if (S.tab === 'profile') renderProfile();
  } catch (e) { toast('Bild nicht gespeichert: ' + e.message); }
}
async function photoMenu() {
  if (!ME.user?.photo) { $('#photoIn')?.click(); return; }
  const r = await new Promise(res => {
    const d = dlg('#msgDlg', `<div class="dlg-in"><h2 id="msgDlgT" style="font:700 24px var(--f-num)">Profilbild</h2><div class="btn-row" style="justify-content:flex-start;flex-wrap:wrap"><button class="btn" type="button" data-r="new">Neues Bild wählen</button><button class="btn sec" type="button" data-r="del">Bild entfernen</button><button class="btn sec" type="button" data-r="">Abbrechen</button></div></div>`);
    d.onclick = e => { const b = e.target.closest('[data-r]'); if (b) { d.onclick = null; closeDlg(d); res(b.dataset.r); } };
  });
  if (r === 'new') $('#photoIn')?.click();
  if (r === 'del') { try { setMe(await jsonPost('/api/me/photo', undefined, 'DELETE')); renderProfile(); toast('Bild entfernt'); } catch (e) { toast(e.message); } }
}
function accountPanel() {
  if (!ME.user) return '';
  return `<div class="panel"><h3>Konto</h3>
    <p style="margin:0 0 8px">${esc(ME.user.email)}${isAdminMe() ? ' · <b>Admin</b>' : ''}</p>
    <div class="btn-row" style="justify-content:flex-start;flex-wrap:wrap"><button class="btn sec" type="button" data-act="pwchange">Passwort ändern</button><button class="btn sec" type="button" data-act="logout">Abmelden</button></div>
    <div class="btn-row" style="justify-content:flex-start;flex-wrap:wrap;margin-top:8px"><a class="btn sec" href="/api/me/export" download>Meine Daten herunterladen</a><button class="btn sec danger-t" type="button" data-act="delacc">Konto löschen</button></div>
    <p class="fine">Deine Daten liegen auf dem Mac von Lars, nicht in einer Cloud. <a href="/privacy">Datenschutz</a></p></div>`;
}
async function pwChange() {
  const d = dlg('#msgDlg', `<div class="dlg-in"><h2 id="msgDlgT" style="font:700 24px var(--f-num)">Passwort ändern</h2><form id="pwForm" class="prof-form">
    <label class="fld"><span>Bisheriges Passwort</span><input type="password" name="old" autocomplete="current-password" required></label>
    <label class="fld"><span>Neues Passwort (mindestens 8 Zeichen)</span><input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
    <p class="gate-err" role="alert"></p><div class="btn-row"><button class="btn sec" type="button" data-act="closemsg">Abbrechen</button><button class="btn" type="submit">Speichern</button></div></form></div>`);
  d.querySelector('input')?.focus();
}
async function deleteAccount() {
  if (!(await ask({ title: 'Konto löschen?', text: 'Dein Konto, dein Flugbuch, deine Ausrüstung, dein Profil und deine Rückmeldungen werden auf dem Mac gelöscht. Das lässt sich nicht rückgängig machen. Tipp: vorher «Meine Daten herunterladen».', ok: 'Weiter', danger: true }))) return;
  const pw = prompt('Zur Sicherheit: dein Passwort');
  if (!pw) return;
  try { await jsonPost('/api/me', { password: pw }, 'DELETE'); for (const k of PERSONAL) store.del(k); alert('Dein Konto ist gelöscht. Danke fürs Testen!'); location.replace('/'); }
  catch (e) { toast(e.message); }
}

/* ---- Testphase: Rückmeldungen, «heute nicht gestartet», Umfrage */
const TAB_NAMES = { decide: 'Entscheid', map: 'Karte', lage: 'Lage', day: 'Flugtag', book: 'Flugbuch', profile: 'Profil' };
const FB_KINDS = { idea: ['Idee', 'Was fehlt dir, was würde AFC besser machen?'], bug: ['Fehler', 'Was ist passiert? Was hast du davor angetippt?'], forecast: ['Prognose', 'Wo lag AFC daneben? Startplatz, Tag, Uhrzeit, was war wirklich?'], praise: ['Lob', 'Was gefällt dir?'] };
function feedbackForm(kind = 'idea') {
  const site = S.detailData?.site && $('#siteDlg').open ? S.detailData.site : null;
  dlg('#msgDlg', `<div class="dlg-in"><div class="dlg-h"><h2 id="msgDlgT">Rückmeldung an Lars</h2><button class="x-btn" type="button" data-act="closemsg" aria-label="Schliessen">×</button></div>
    <form id="fbForm" class="prof-form" data-site="${esc(site?.id || '')}">
      <div class="seg seg-sm fb-kinds" role="radiogroup" aria-label="Art">${Object.entries(FB_KINDS).map(([k, [t]]) => `<label><input type="radio" name="kind" value="${k}" ${k === kind ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div>
      <label class="fld"><span class="sr">Text</span><textarea name="text" rows="5" maxlength="2000" required placeholder="${esc(FB_KINDS[kind][1])}"></textarea></label>
      <label class="btn sec lb-file fb-shot">Bildschirmfoto anhängen<input type="file" name="shot" accept="image/*"></label>
      <p class="fine" style="margin:0">Mitgeschickt werden: Ansicht «${esc(TAB_NAMES[S.tab] || S.tab)}»${site ? `, Startplatz ${esc(site.name)}` : ''}, Gerät und App-Version. Tipp für ein Bildschirmfoto auf dem iPhone: Seitentaste und Lauter-Taste gleichzeitig drücken.</p>
      <p class="gate-err" role="alert"></p>
      <div class="btn-row"><button class="btn sec" type="button" data-act="closemsg">Abbrechen</button><button class="btn" type="submit">Senden</button></div>
    </form></div>`);
  setTimeout(() => $('#fbForm textarea')?.focus(), 60);
}
async function shrinkImage(file, max = 1000, q = 0.7) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  } finally { URL.revokeObjectURL(url); }
}
async function sendFeedback(form) {
  const fd = new FormData(form), err = form.querySelector('.gate-err'), btn = form.querySelector('[type=submit]');
  const text = String(fd.get('text') || '').trim();
  if (!text) { err.textContent = 'Bitte kurz beschreiben.'; return; }
  btn.disabled = true; btn.textContent = 'Sende …';
  try {
    const f = fd.get('shot');
    const shot = f && f.size ? await shrinkImage(f).catch(() => null) : null;
    await jsonPost('/api/feedback', { kind: fd.get('kind'), text, page: S.tab, site: form.dataset.site || null, ver: APP_VER, device: navigator.userAgent.slice(0, 160), shot });
    closeDlg($('#msgDlg')); toast('Danke! Lars hat deine Rückmeldung.');
  } catch (e) { err.textContent = 'Nicht gesendet: ' + e.message; btn.disabled = false; btn.textContent = 'Senden'; }
}
const NOFLY = { wind: 'Zu viel Wind oder Böen', thermal: 'Thermik zu stark', weak: 'Zu schwach, nicht lohnend', cloud: 'Wolken oder Nebel am Start', rain: 'Regen oder Gewitter', foehn: 'Föhn oder Bise', time: 'Keine Zeit', feeling: 'Bauchgefühl', other: 'Anderes' };
function noflyForm(siteId) {
  const all = (S.plan?.sites || []).filter(x => !x.blocked);
  const favs = [...S.fav].map(siteById).filter(Boolean);
  const opts = [...favs, ...all.filter(x => !S.fav.has(x.id)).sort((a, b) => a.name.localeCompare(b.name))];
  dlg('#msgDlg', `<div class="dlg-in"><div class="dlg-h"><h2 id="msgDlgT">Heute nicht gestartet</h2><button class="x-btn" type="button" data-act="closemsg" aria-label="Schliessen">×</button></div>
    <p style="margin:0">Warum? Gerade solche Tage zeigen, wo AFC zu optimistisch ist.</p>
    <form id="noflyForm" class="prof-form">
      <label class="fld"><span>Startplatz</span><select name="site">${opts.map(x => `<option value="${esc(x.id)}" ${x.id === siteId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <div class="chips" role="radiogroup" aria-label="Grund">${Object.entries(NOFLY).map(([k, t]) => `<label class="chip"><input type="radio" name="reason" value="${k}" required><span>${t}</span></label>`).join('')}</div>
      <label class="fld"><span>Was war los? (freiwillig)</span><textarea name="text" rows="3" maxlength="600" placeholder="z.B. am Start 30 km/h aus West, Windsack stand waagrecht"></textarea></label>
      <p class="gate-err" role="alert"></p>
      <div class="btn-row"><button class="btn sec" type="button" data-act="closemsg">Abbrechen</button><button class="btn" type="submit">Senden</button></div>
    </form></div>`);
}
/* ------------------------------------------------------------------ Austausch unter den Piloten */
const G = { data: null, date: null, req: null, form: store.get('grpForm', null) };
async function groupLoad(date = G.date) {
  if (!ME.user) return null;
  const r = await fetch('/api/community' + (date ? '?date=' + date : ''), { headers: { 'X-AFC-Client': clientId } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Fehler ' + r.status);
  groupSet(j);
  return j;
}
function groupSet(j) {
  G.data = j; G.date = j.date === j.today ? null : j.date;
  if (S.tab === 'group') { store.set('grpSeen', new Date().toISOString()); renderGroup(); }
  groupDot();
}
/** Punkt am Reiter, wenn andere etwas Neues geschrieben haben. */
function groupDot() {
  const b = $('.tabs [data-tab="group"]');
  if (!b) return;
  const seen = store.get('grpSeen', '') || '';
  const fresh = (G.data?.posts || []).some(p => !p.mine && (p.at > seen || p.replies.some(r => !r.mine && r.at > seen)));
  b.classList.toggle('has-new', fresh && S.tab !== 'group');
}
const GRP_ICON = { report: '🪂', plan: '📅', ask: '💬', warn: '⚠️' };
/** Bester AFC-Score des Tages für einen Startplatz (aus dem geladenen Plan). */
function afcBestOn(siteId, date) {
  const s = siteById(siteId), i = S.plan?.dates.indexOf(date);
  return s && i >= 0 ? s.days[i]?.best?.score ?? null : null;
}
const dayWord = d => { const t = todayKey(); if (d === t) return 'heute'; const y = new Date(Date.parse(t) - 86400000).toISOString().slice(0, 10), m = new Date(Date.parse(t) + 86400000).toISOString().slice(0, 10); return d === y ? 'gestern' : d === m ? 'morgen' : new Date(d + 'T12:00').toLocaleDateString('de-CH', { weekday: 'long', day: 'numeric', month: 'numeric' }); };
function groupSiteHtml(x, reasons) {
  const afc = afcBestOn(x.siteId, G.data.date);
  const bits = [x.flights ? `${x.flights} ${x.flights === 1 ? 'Flug' : 'Flüge'}` : '', x.rating ? `${stars(Math.round(x.rating))} ${x.rating}` : '', x.km ? `bis ${x.km} km` : '', x.durMin ? `längster ${LG().fmtDur(x.durMin)}` : ''].filter(Boolean).join(' · ');
  const nf = x.noflyN ? `${x.noflyN}× nicht gestartet (${Object.entries(x.nofly).map(([k, n]) => `${esc(reasons[k] || k)}${n > 1 ? ' ' + n + '×' : ''}`).join(', ')})` : '';
  const v = x.verdicts || {}, vt = [v.richtig && `${v.richtig}× passte`, v.streng && `${v.streng}× zu streng`, v.mild && `${v.mild}× zu mild`].filter(Boolean).join(', ');
  return `<button type="button" class="grp-site" data-act="site" data-id="${esc(x.siteId)}">
    <span class="grp-site-main"><b>${esc(x.siteName)}</b><small>${bits || '&nbsp;'}</small>${nf ? `<small class="grp-nf">${nf}</small>` : ''}${vt ? `<small>AFC-Bewertung: ${vt}</small>` : ''}${x.names.length ? `<small>${esc(x.names.join(', '))}${x.pilots > x.names.length ? ` und ${x.pilots - x.names.length} weitere` : ''}</small>` : x.pilots > 1 ? `<small>${x.pilots} Piloten</small>` : ''}</span>
    ${num(afc) ? `<span class="grp-afc"><small>AFC</small>${pill(afc)}</span>` : ''}</button>`;
}
function groupPostHtml(p) {
  const head = `${avatarHtml(p.who, 'grp-av')}<div class="grp-meta"><b>${esc(p.who.name)}</b> <span class="fine">${whenTxt(p.at)}</span>${p.kind ? `<div class="grp-kind">${GRP_ICON[p.kind] || ''} ${esc(G.data.kinds[p.kind] || '')}${p.kind === 'plan' ? ` · <b>${esc(dayWord(p.date))}</b>` : p.date && p.date !== p.at.slice(0, 10) ? ` · ${esc(dayWord(p.date))}` : ''}${p.siteId ? ` · <button type="button" class="linkbtn" data-act="site" data-id="${esc(p.siteId)}">${esc(p.siteName || siteById(p.siteId)?.name || p.siteId)}</button>` : p.siteName ? ` · ${esc(p.siteName)}` : ''}</div>` : ''}</div>`;
  const like = p.kind === 'plan' ? (p.liked ? 'Bin dabei ✓' : 'Bin dabei') : (p.liked ? '👍 Gefällt mir' : '👍');
  const reps = p.replies.map(r => `<div class="grp-rep">${avatarHtml(r.who, 'grp-av sm')}<div><b>${esc(r.who.name)}</b> <span class="fine">${whenTxt(r.at)}</span><p>${esc(r.text)}</p>${r.canDel ? `<button type="button" class="linkbtn fine" data-act="grpdel" data-id="${r.id}">löschen</button>` : ''}</div></div>`).join('');
  return `<article class="grp-post grp-${esc(p.kind || 'report')}" id="post-${p.id}"><div class="grp-head">${head}</div><p class="grp-text">${esc(p.text)}</p>
    <div class="grp-acts"><button type="button" class="btn sec sm${p.liked ? ' on' : ''}" data-act="grplike" data-id="${p.id}" aria-pressed="${p.liked}">${like}${p.likes ? ` <b>${p.likes}</b>` : ''}</button>${p.canDel ? `<button type="button" class="linkbtn fine" data-act="grpdel" data-id="${p.id}">löschen</button>` : ''}</div>
    ${reps ? `<div class="grp-reps">${reps}</div>` : ''}
    <form class="grp-reply" data-parent="${p.id}"><input type="text" name="text" maxlength="600" placeholder="Antworten …" aria-label="Antwort an ${esc(p.who.name)}"><button class="btn sec sm" type="submit">Senden</button></form></article>`;
}
function groupFormHtml() {
  const f = G.form || {}, kind = f.kind || 'report';
  const all = (S.plan?.sites || []).filter(x => !x.blocked);
  const favs = [...S.fav].map(siteById).filter(Boolean);
  const opts = [...favs, ...all.filter(x => !S.fav.has(x.id)).sort((a, b) => a.name.localeCompare(b.name))];
  const t = todayKey(), dates = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(t) + i * 86400000).toISOString().slice(0, 10));
  return `<form id="grpForm" class="prof-form grp-form">
    <div class="chips" role="radiogroup" aria-label="Art">${Object.entries(G.data.kinds).map(([k, v]) => `<label class="chip"><input type="radio" name="kind" value="${k}" ${k === kind ? 'checked' : ''}><span>${GRP_ICON[k]} ${esc(v)}</span></label>`).join('')}</div>
    <div class="fld-pair"><label class="fld"><span>Startplatz (freiwillig)</span><select name="siteId"><option value="">–</option>${opts.map(x => `<option value="${esc(x.id)}" ${x.id === f.siteId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    <label class="fld grp-date" ${kind === 'plan' ? '' : 'hidden'}><span>Wann?</span><select name="date">${dates.map(d => `<option value="${d}" ${d === f.date ? 'selected' : ''}>${esc(dayWord(d))}</option>`).join('')}</select></label></div>
    <label class="fld"><span>Text</span><textarea name="text" rows="3" maxlength="600" placeholder="${kind === 'plan' ? 'z.B. Ich gehe morgen um 11 Uhr an den Niesen, wer kommt mit?' : kind === 'warn' ? 'z.B. Am Start Bise mit 35 km/h Böen, wir sind wieder runtergelaufen' : kind === 'ask' ? 'z.B. Wo ging heute Nachmittag die Thermik?' : 'z.B. Super Thermik am Grat bis 2600 m, Landung ruhig'}">${esc(f.text || '')}</textarea></label>
    <p class="gate-err" role="alert"></p>
    <div class="btn-row"><button class="btn" type="submit">Teilen</button></div></form>`;
}
/** In der Startplatz-Ansicht: was die Gruppe heute dort gemeldet hat. */
function groupLineFor(siteId) {
  if (!isToday() || !G.data || G.data.date !== G.data.today) return '';
  const x = G.data.sites.find(v => v.siteId === siteId), n = G.data.posts.filter(p => p.siteId === siteId && (p.date === G.data.today || p.at.slice(0, 10) === G.data.today)).length;
  if (!x && !n) return '';
  const t = [x?.flights ? `${x.flights} ${x.flights === 1 ? 'Flug' : 'Flüge'}${x.rating ? `, ${x.rating} von 5 Sternen` : ''}` : '', x?.noflyN ? `${x.noflyN}× nicht gestartet` : '', n ? `${n} ${n === 1 ? 'Beitrag' : 'Beiträge'}` : ''].filter(Boolean).join(' · ');
  return `<p class="grp-line"><button class="linkbtn" type="button" data-act="tab" data-tab="group">Heute in der Gruppe: ${esc(t)}</button></p>`;
}
function renderGroup() {
  const el = $('#v-group');
  if (!ME.user) { el.innerHTML = '<div class="panel"><h3>Austausch</h3><p>Der Austausch braucht ein Konto. Lars kann dich mit einem Einladungslink dazunehmen.</p></div>'; return; }
  if (!G.data) {
    el.innerHTML = '<div class="warm"><div class="spinner"></div>Austausch wird geladen …</div>';
    if (!G.req) G.req = groupLoad().catch(err => { el.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }).finally(() => { G.req = null; });
    return;
  }
  const d = G.data, t = d.today, y = new Date(Date.parse(t) - 86400000).toISOString().slice(0, 10);
  const plans = d.posts.filter(p => p.kind === 'plan' && p.date >= t).sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at));
  const feed = d.posts.filter(p => !(p.kind === 'plan' && p.date >= t));
  el.innerHTML = `
    <div class="panel"><div class="grp-top"><h3>${d.date === t ? 'Heute' : d.date === y ? 'Gestern' : esc(dayWord(d.date))} an den Startplätzen</h3>
      <div class="seg" role="group" aria-label="Tag"><button type="button" aria-pressed="${d.date === t}" data-act="grpday" data-v="">Heute</button><button type="button" aria-pressed="${d.date === y}" data-act="grpday" data-v="${y}">Gestern</button></div></div>
      ${d.sites.length ? `<div class="grp-sites">${d.sites.map(x => groupSiteHtml(x, d.reasons)).join('')}</div>` : `<p class="fine" style="margin:0">${d.date === t ? 'Heute hat noch niemand einen Flug oder «nicht gestartet» eingetragen.' : 'An diesem Tag hat niemand etwas eingetragen.'}</p>`}
      <p class="fine" style="margin:8px 0 0">Aus den Flugbüchern und «nicht gestartet» aller ${d.pilots} Piloten. Namen nur von denen, die es erlauben. <label class="grp-share"><input type="checkbox" data-act="grpshare" ${d.shareName ? 'checked' : ''}> Meinen Namen bei meinen Flügen zeigen</label></p></div>
    ${plans.length ? `<div class="panel"><h3>Wer geht fliegen?</h3>${plans.map(groupPostHtml).join('')}</div>` : ''}
    <div class="panel"><h3>Teilen</h3>${groupFormHtml()}</div>
    <div class="grp-feed">${feed.length ? feed.map(groupPostHtml).join('') : '<div class="panel"><p class="fine" style="margin:0">Noch keine Beiträge. Schreib, wie dein Flug war, wo die Thermik ging oder wann du fliegen gehst.</p></div>'}</div>
    <p class="fine" style="text-align:center">Beiträge bleiben 14 Tage sichtbar und nur für Piloten mit einem AFC-Konto.</p>`;
}
async function groupPost(form) {
  const fd = new FormData(form), err = form.querySelector('.gate-err');
  const text = String(fd.get('text') || '').trim();
  if (!text) { if (err) err.textContent = 'Bitte etwas schreiben.'; return; }
  const parent = Number(form.dataset.parent) || undefined, siteId = fd.get('siteId') || null;
  const b = parent ? { text, parent } : { text, kind: fd.get('kind'), siteId, siteName: siteId ? siteById(siteId)?.name : null, date: fd.get('kind') === 'plan' ? fd.get('date') : todayKey() };
  try {
    groupSet(await jsonPost('/api/community', { ...b, view: G.date || undefined }));
    if (!parent) { G.form = null; store.set('grpForm', null); toast('Geteilt'); }
  } catch (e) { if (err) err.textContent = 'Nicht gesendet: ' + e.message; else toast('Nicht gesendet: ' + e.message); }
}
async function sendNofly(form) {
  const fd = new FormData(form), err = form.querySelector('.gate-err');
  if (!fd.get('reason')) { err.textContent = 'Bitte einen Grund antippen.'; return; }
  const site = fd.get('site'), s = siteById(site), h = nowHourToday();
  const score = s && num(h) ? s.days[S.plan.dates.indexOf(todayKey())]?.scores?.[h - S.plan.h0] : null;
  try {
    await jsonPost('/api/feedback', { kind: 'nofly', reason: fd.get('reason'), text: String(fd.get('text') || '').trim(), site, score: num(score) ? score : s?.days[S.plan.dates.indexOf(todayKey())]?.best?.score ?? null, page: S.tab, ver: APP_VER });
    closeDlg($('#msgDlg')); toast('Danke! Das hilft AFC, solche Tage besser einzuschätzen.');
  } catch (e) { err.textContent = 'Nicht gesendet: ' + e.message; }
}
const SURVEY = [
  ['use', 'Wie oft hast du AFC benutzt?', ['täglich', 'mehrmals pro Woche', 'ab und zu', 'kaum']],
  ['match', 'Wie gut passten die Bewertungen zu deinem Gefühl am Startplatz?', 5],
  ['clear', 'Wie gut verstehst du, warum AFC etwas so bewertet?', 5],
  ['best', 'Was hat dir am meisten geholfen?', 'text'],
  ['miss', 'Was hat gefehlt oder gestört?', 'text'],
  ['keep', 'Würdest du AFC weiter benutzen?', ['ja', 'vielleicht', 'nein']],
  ['nps', 'Wie wahrscheinlich empfiehlst du AFC einem Flugkollegen? (0 = nie, 10 = sicher)', 10]
];
function surveyForm() {
  const scale = (k, n) => `<div class="scale" role="radiogroup">${Array.from({ length: n === 10 ? 11 : n }, (_, i) => n === 10 ? i : i + 1).map(i => `<label><input type="radio" name="${k}" value="${i}"><span>${i}</span></label>`).join('')}</div>`;
  dlg('#msgDlg', `<div class="dlg-in"><div class="dlg-h"><h2 id="msgDlgT">Umfrage zum Testende</h2><button class="x-btn" type="button" data-act="closemsg" aria-label="Schliessen">×</button></div>
    <p style="margin:0">Zwei Minuten, die Lars sehr helfen. Danke!</p>
    <form id="surveyForm" class="prof-form">${SURVEY.map(([k, q, t]) => `<fieldset><legend>${esc(q)}</legend>${t === 'text' ? `<textarea name="${k}" rows="3" maxlength="600"></textarea>` : Array.isArray(t) ? `<div class="chips">${t.map(o => `<label class="chip"><input type="radio" name="${k}" value="${esc(o)}"><span>${esc(o)}</span></label>`).join('')}</div>` : scale(k, t)}</fieldset>`).join('')}
      <p class="gate-err" role="alert"></p>
      <div class="btn-row"><button class="btn sec" type="button" data-act="closemsg">Später</button><button class="btn" type="submit">Senden</button></div></form></div>`);
  $('#msgDlg').classList.add('dlg-big');
  $('#msgDlg').addEventListener('close', () => $('#msgDlg').classList.remove('dlg-big'), { once: true });
}
async function sendSurvey(form) {
  const fd = new FormData(form), answers = {};
  for (const [k, , t] of SURVEY) { const v = fd.get(k); if (v != null && v !== '') answers[k] = typeof t === 'number' ? Number(v) : String(v); }
  if (Object.keys(answers).length < 3) { form.querySelector('.gate-err').textContent = 'Bitte mindestens drei Fragen beantworten.'; return; }
  try { await jsonPost('/api/feedback', { kind: 'survey', answers, ver: APP_VER }); ME.survey = false; closeDlg($('#msgDlg')); toast('Vielen Dank fürs Mitmachen!'); render(); }
  catch (e) { form.querySelector('.gate-err').textContent = e.message; }
}
const surveyCard = () => (ME.survey ? `<div class="lb-ask survey-card"><div><b>Umfrage zum Testende</b> <span class="fine">Zwei Minuten, sieben Fragen. Damit wird AFC besser.</span></div><div class="lb-ask-btns"><button type="button" class="btn" data-act="survey">Jetzt ausfüllen</button></div></div>` : '');
function dayAskHtml() {
  if (!ME.user || !S.plan?.dates.includes(todayKey())) return '';
  const h = Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Zurich' }));
  if (h < 9) return '';
  return `<div class="panel day-ask"><h3>Warst du heute am Startplatz?</h3>
    <p class="fine" style="margin:0 0 8px">Jeder Tag hilft, auch einer ohne Start.</p>
    <div class="btn-row" style="justify-content:flex-start;flex-wrap:wrap"><button class="btn" type="button" data-act="lbflight">Geflogen: Flug eintragen</button><button class="btn sec" type="button" data-act="nofly">Nicht gestartet</button></div></div>`;
}

/* ---- Admin: Testphase im Überblick */
const ADM = { data: null, tab: 'users' };
async function adminLoad() { ADM.data = await rawFetch('/api/admin/overview').then(r => (r.ok ? r.json() : Promise.reject(new Error('Fehler ' + r.status)))); return ADM.data; }
function testPanel() {
  if (!isAdminMe()) return '';
  const d = ADM.data;
  const open = d ? d.feedback.filter(x => !x.done).length : null;
  return `<div class="panel test-panel"><h3>Testphase</h3>
    ${d ? `<div class="pcard-stats" style="margin-bottom:10px"><div><b>${d.users.length}</b><span>Piloten</span></div><div><b>${open}</b><span>neue Rück­meldungen</span></div><div><b>${d.users.reduce((t, u) => t + u.stats.verdicts, 0)}</b><span>Flüge bewertet</span></div><div><b>${d.errors.reduce((t, x) => t + x.n, 0)}</b><span>App-Fehler</span></div></div>` : '<p class="fine" style="margin:0 0 8px">Lade …</p>'}
    <div class="btn-row" style="justify-content:flex-start;flex-wrap:wrap"><button class="btn" type="button" data-act="invite">Freund einladen</button><button class="btn sec" type="button" data-act="admin">Übersicht öffnen</button></div></div>`;
}
const agoTxt = t => (t ? ageTxt(ageMin(t)) || 'gerade eben' : '–');
function adminHtml() {
  const d = ADM.data, t = ADM.tab;
  if (!d) return '<div class="dlg-in"><div class="warm"><div class="spinner"></div>Lade …</div></div>';
  const tabs = [['users', `Piloten ${d.users.length}`], ['fb', `Meldungen ${d.feedback.filter(x => !x.done).length}`], ['types', 'Typen'], ['inv', 'Einladen'], ['err', `Fehler ${d.errors.length}`]];
  let body = '';
  if (t === 'users') body = `<div class="adm-users">${d.users.map(u => `<div class="adm-u">${avatarHtml(u)}<div><b>${esc(u.name)}</b>${u.role === 'admin' ? ' <small class="tag">Admin</small>' : ''}<small>${esc(u.email)} · zuletzt ${esc(agoTxt(u.lastSeen))}</small>
      <small>${u.stats.flights} Flüge (${u.stats.logged} im Flugbuch, ${u.stats.igc} IGC) · ${u.stats.verdicts} bewertet · ${u.feedback} Rückmeldungen · ${u.push ? 'Push an' : 'Push aus'}</small>
      ${u.profile.license ? `<small>${esc(LICENSES[u.profile.license] || '')}${u.profile.since ? ', seit ' + u.profile.since : ''}${u.profile.wing ? ' · ' + esc(u.profile.wing) : ''}</small>` : '<small>Profil noch leer</small>'}
      ${u.profile.styles?.length ? `<small>Fliegt: ${esc(u.profile.styles.map(x => d.styles?.[x] || x).join(', '))}</small>` : ''}
      ${u.profile.emergName ? `<small>Notfall: ${esc(u.profile.emergName)} ${esc(u.profile.emergPhone || '')}</small>` : ''}
      ${u.role !== 'admin' ? `<span class="adm-act"><button class="linkbtn" type="button" data-act="admreset" data-id="${esc(u.id)}">Passwort-Link</button><button class="linkbtn" type="button" data-act="admdel" data-id="${esc(u.id)}" data-v="${esc(u.name)}">Entfernen</button></span>` : ''}</div></div>`).join('')}</div>
    <h3 class="adm-h">Wie lag AFC laut den Piloten?</h3><p>${Object.keys(d.verdicts).length ? Object.entries(d.verdicts).map(([k, n]) => `${esc(LG()?.VERDICTS[k] || k)}: <b>${n}</b>`).join(' · ') : 'Noch keine Bewertungen nach Flügen.'}</p>
    <h3 class="adm-h">Abschluss-Umfrage</h3><p class="fine" style="margin:0 0 6px">Eingeschaltet sehen alle Piloten eine kurze Umfrage, bis sie sie ausgefüllt haben.</p>
    <button class="btn sec" type="button" data-act="admsurvey" data-v="${d.survey ? '0' : '1'}">${d.survey ? 'Umfrage ausschalten' : 'Umfrage einschalten'}</button>`;
  if (t === 'fb') body = d.feedback.length ? `<div class="adm-fb">${d.feedback.map(f => `<div class="adm-f${f.done ? ' done' : ''}"><div class="adm-f-h"><span class="tag k-${esc(f.kind)}">${esc(d.kinds[f.kind] || f.kind)}</span><b>${esc(f.who)}</b><small>${esc(whenTxt(f.at))}</small></div>
      ${f.kind === 'nofly' ? `<p><b>${esc(d.reasons[f.reason] || '')}</b>${f.site ? ` am ${esc(siteById(f.site)?.name || f.site)}` : ''}${num(f.score) ? `, AFC sagte ${f.score}` : ''}</p>` : ''}
      ${f.kind === 'survey' ? `<ul class="adm-sv">${Object.entries(f.answers || {}).map(([k, v]) => `<li><small>${esc(SURVEY.find(x => x[0] === k)?.[1] || k)}</small> ${esc(v)}</li>`).join('')}</ul>` : ''}
      ${f.text ? `<p>${esc(f.text)}</p>` : ''}
      <small class="fine">${[f.page && 'Ansicht ' + (TAB_NAMES[f.page] || f.page), f.site && f.kind !== 'nofly' && 'Startplatz ' + (siteById(f.site)?.name || f.site), f.ver && 'Version ' + f.ver, f.device && f.device.replace(/Mozilla\/5\.0 \(|\) AppleWebKit.*$/g, '')].filter(Boolean).map(esc).join(' · ')}</small>
      <span class="adm-act">${f.shot ? `<button class="linkbtn" type="button" data-act="admshot" data-id="${f.id}">Bild ansehen</button>` : ''}<button class="linkbtn" type="button" data-act="admdone" data-id="${f.id}" data-v="${f.done ? 0 : 1}">${f.done ? 'wieder offen' : 'erledigt'}</button></span></div>`).join('')}</div>` : '<p>Noch keine Rückmeldungen.</p>';
  if (t === 'types') {
    const g = d.groups || [], row = x => {
      const v = x.richtig + x.streng + x.mild, nf = Object.entries(x.nofly).sort((a, b) => b[1] - a[1]).slice(0, 3);
      return `<div class="adm-f"><div class="adm-f-h"><b>${esc(x.label)}</b><small>${x.pilots} ${x.pilots === 1 ? 'Pilot' : 'Piloten'} · ${x.flights} Flüge</small></div>
        <p>${v ? `Urteile: richtig <b>${x.richtig}</b> · zu streng <b>${x.streng}</b> · zu mild <b>${x.mild}</b>` : 'Noch keine Urteile nach Flügen.'}</p>
        ${nf.length ? `<small>Nicht gestartet: ${nf.map(([k, n]) => `${esc(d.reasons[k] || k)} ${n}×`).join(', ')}</small>` : ''}
        ${x.feedback ? `<small>${x.feedback} ${x.feedback === 1 ? 'Rückmeldung' : 'Rückmeldungen'}</small>` : ''}</div>`;
    };
    body = `<p class="fine" style="margin:0 0 8px">Was die verschiedenen Pilotentypen sagen. Wer mehrere Flugstile angibt, zählt bei jedem. AFC lernt getrennt nach Stufe: «zu streng» gilt nur für die eigene Stufe und erfahrenere, «zu mild» als Warnung für alle.</p>
      <h3 class="adm-h">Nach Flugstil</h3><div class="adm-fb">${g.filter(x => x.key.startsWith('s:')).map(row).join('') || '<p>Noch keine Angaben.</p>'}</div>
      <h3 class="adm-h">Nach Stufe</h3><div class="adm-fb">${g.filter(x => x.key.startsWith('l:')).map(row).join('') || '<p>Noch keine Angaben.</p>'}</div>`;
  }
  if (t === 'inv') body = `<p>Jeder Freund bekommt einen eigenen Link. Er gilt 30 Tage und nur für ein Konto.</p><button class="btn" type="button" data-act="invite">Neuen Einladungslink erstellen</button>
    <div class="adm-inv">${d.invites.map(i => `<div class="adm-i"><b>${esc(i.note || (i.kind === 'reset' ? 'Passwort-Link' : 'Einladung'))}</b><small>${i.kind === 'reset' ? `Neues Passwort für ${esc(i.forUser || '?')} · ` : ''}${i.usedBy ? `benutzt von ${esc(i.usedBy)} ${esc(whenTxt(i.usedAt))}` : i.expires < new Date().toISOString() ? 'abgelaufen' : `offen bis ${esc(new Date(i.expires).toLocaleDateString('de-CH'))}`}</small>
      ${!i.usedBy && i.expires > new Date().toISOString() ? `<span class="adm-act"><button class="linkbtn" type="button" data-act="invshow" data-id="${esc(i.code)}" data-v="${esc(i.kind)}">Link zeigen</button><button class="linkbtn" type="button" data-act="invdel" data-id="${esc(i.code)}">Löschen</button></span>` : ''}</div>`).join('')}</div>`;
  if (t === 'err') body = d.errors.length ? `<button class="btn sec" type="button" data-act="admerrclear">Liste leeren</button><div class="adm-fb">${d.errors.map(e => `<div class="adm-f"><div class="adm-f-h"><b>${esc(e.msg)}</b><small>${e.n}× · ${esc(e.who)} · ${esc(whenTxt(e.at))}</small></div><small class="fine">${esc([e.src && e.src + ':' + e.line, e.page && 'Ansicht ' + (TAB_NAMES[e.page] || e.page), e.ver && 'Version ' + e.ver].filter(Boolean).join(' · '))}</small>${e.stack ? `<pre class="adm-stack">${esc(e.stack)}</pre>` : ''}</div>`).join('')}</div>` : '<p>Keine App-Fehler gemeldet.</p>';
  return `<div class="dlg-in"><div class="dlg-h"><h2 id="siteDlgT">Testphase</h2><button class="x-btn" type="button" data-act="closesite" aria-label="Schliessen">×</button></div>
    <div class="seg seg-sm adm-tabs" role="tablist">${tabs.map(([k, n]) => `<button type="button" data-act="admtab" data-v="${k}" aria-pressed="${t === k}">${n}</button>`).join('')}</div>
    ${body}</div>`;
}
async function openAdmin(tab) {
  if (tab) ADM.tab = tab;
  S.panel = 'admin';
  dlg('#siteDlg', adminHtml());
  try { await adminLoad(); if ($('#siteDlg').open && S.panel === 'admin') dlg('#siteDlg', adminHtml()); } catch (e) { toast(e.message); }
}
const inviteUrl = (code, kind) => `${location.origin}/?${kind === 'reset' ? 'reset' : 'invite'}=${code}`;
function inviteShow(code, kind = 'invite', note = '') {
  const url = inviteUrl(code, kind);
  const text = kind === 'reset' ? `Hier kannst du dein AFC-Passwort neu setzen (gilt 3 Tage): ${url}` : `Hoi${note ? ' ' + note : ''}! Hier ist deine Einladung zur AFC-Testphase. Zuerst Tailscale einrichten (siehe Anleitung), dann diesen Link auf dem Handy öffnen: ${url}`;
  dlg('#msgDlg', `<div class="dlg-in"><h2 id="msgDlgT" style="font:700 24px var(--f-num)">${kind === 'reset' ? 'Link für ein neues Passwort' : 'Einladung' + (note ? ' für ' + esc(note) : '')}</h2>
    <p>Schick diesen Link ${kind === 'reset' ? '' : 'zusammen mit der Anleitung '}per WhatsApp oder SMS. Er funktioniert nur einmal.</p>
    <p class="inv-url"><code>${esc(url)}</code></p>
    <div class="btn-row" style="justify-content:flex-start;flex-wrap:wrap">${navigator.share ? '<button class="btn" type="button" data-act="invshare">Teilen …</button>' : ''}<button class="btn ${navigator.share ? 'sec' : ''}" type="button" data-act="invcopy">Text kopieren</button><button class="btn sec" type="button" data-act="closemsg">Fertig</button></div></div>`);
  ADM.share = { text, url };
}
async function inviteCreate() {
  const note = prompt('Für wen ist die Einladung? (Vorname, nur für deine Übersicht)');
  if (note === null) return;
  try { const j = await jsonPost('/api/admin/invite', { note: note.trim() }); inviteShow(j.code, 'invite', note.trim()); adminLoad().then(() => { if (S.panel === 'admin' && $('#siteDlg').open) dlg('#siteDlg', adminHtml()); if (S.tab === 'profile') renderProfile(); }).catch(() => {}); }
  catch (e) { toast(e.message); }
}

/* ---------------------------------------------------------------- Start */
(async function init() {
  const t = store.get('tab');
  if (['decide', 'map', 'lage', 'day', 'book', 'group', 'profile'].includes(t)) S.tab = t;
  applyTheme();
  renderMe();
  // Konten: zuerst klären, wer da ist (ohne Empfang mit dem gespeicherten Stand weiter)
  if (!(await authInit())) {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    return;
  }
  W.level = ['off', '10m', '800', '700'].includes(store.get('wind')) ? store.get('wind') : 'off';
  W.hour = Math.min(20, Math.max(6, new Date().getHours()));
  const pl = window.AFCPilot?.pilotLevel(store.get('pilot', {}));
  if (pl && !store.get('levelManual')) { S.level = pl.level; store.set('level', S.level); }
  T.mode = ['thermal', 'soar'].includes(store.get('thermal')) ? store.get('thermal') : store.get('thermal') === true ? 'thermal' : 'off';
  render();
  loadPlan();
  lbLoad().then(async () => { if (await lbAlignBefore()) toast('Deine Flüge aus dem Profil stehen jetzt auch im Flugbuch.'); lbSyncProfile(); if (S.tab === 'decide') renderDecide(); }).catch(() => {});
  loadStatus(); setInterval(() => { if (!document.hidden) loadStatus(); }, 15 * 60000);
  if ((store.get('intro') ?? 0) < INTRO_VER) setTimeout(() => { if (!$('#msgDlg').open && !$('#siteDlg').open) showIntro(); }, 600);
  setInterval(() => { if (!document.hidden) { loadPlan(); loadWatch(); } }, 5 * 60000);
  setTimeout(() => groupLoad().catch(() => {}), 2500); setInterval(() => { if (!document.hidden && ME.user) groupLoad().catch(() => {}); }, 10 * 60000);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', e => { if (e.data?.type === 'open') applyDeepLink(e.data.url); });
  }
  pushInit().then(() => { renderPush(); pushSync(); });
  loadWatch().then(() => { if (S.tab === 'decide') renderDecide(); });
  if (store.get('sort') === 'near') locateNear();
  if (/[?&](tab|site)=/.test(location.search)) { applyDeepLink(location.href); history.replaceState(null, '', '/'); }
  welcomeToast();
  // Alter Betrieb ohne Konten: einmal auf die Testphase hinweisen
  if (ME.state && !ME.state.auth && !store.get('setupAsked') && store.get('intro')) setTimeout(async () => {
    if ($('#msgDlg').open || $('#siteDlg').open) return;
    store.set('setupAsked', true);
    if (await ask({ title: 'Neu: Konten für die Testphase', text: 'Damit deine Freunde AFC testen können, bekommt jeder ein eigenes Konto mit eigenem Flugbuch und Profil. Richte zuerst dein Konto ein, deine Daten werden übernommen.', ok: 'Konto einrichten', cancel: 'Später' })) showGate('setup');
  }, 1500);
})();
