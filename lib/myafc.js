// MyAFC (Lars, 12.11.2026): eine kleine KI in AFC, die man fragen kann, ob man morgen fliegen soll.
// Das Gespräch führt Claude (Anthropic). Die Daten holt sie sich mit Werkzeugen aus AFC selbst: Prognose und Scores,
// Lage, Messwerte und das eigene Flugbuch. Am Anfang stützt sie sich auf die Scores; je mehr Flüge und Rückmeldungen
// im Flugbuch stehen, desto persönlicher wird die Antwort.
// Bewusst ohne npm-Paket (AFC hat keine Abhängigkeiten und aktualisiert sich per git): direkter HTTPS-Aufruf.
import { isNum } from './util.js';

const BASE = () => (process.env.AFC_ANTHROPIC_URL || 'https://api.anthropic.com').replace(/\/$/, '');
export const MYAFC_MODEL = () => process.env.AFC_MYAFC_MODEL || 'claude-opus-5-5';
export const MYAFC_DAILY = () => Number(process.env.AFC_MYAFC_DAILY || 40);
const MAX_STEPS = 6;

export const SYSTEM = `Du bist MyAFC, der persönliche Flugberater in der App AFC, einer Gleitschirm-Wetter-App fürs Berner Oberland und Umgebung.
Du sprichst Deutsch wie in der Schweiz (immer «ss», nie «ß»), per Du, ruhig, klar und kurz: meist 3 bis 6 Sätze, ohne Überschriften und ohne Tabellen. Zahlen nennst du, wenn sie die Antwort tragen (Score, Wind, Böen, Uhrzeit).

So arbeitest du:
- Hol dir die Fakten immer mit den Werkzeugen, bevor du antwortest. Rate nie Wetterwerte und erfinde keine Startplätze.
- Bei «soll ich fliegen?» schaust du die Übersicht des Tages an, dann die Lieblings- und Heimstartplätze der Pilotin oder des Piloten (mein_profil) und den besten Startplatz im Detail.
- Begründe kurz mit dem Wichtigsten: bestes Zeitfenster, Hauptgrund, was unsicher ist («in 6 von 21 Wettervarianten …»), was man vor Ort prüfen muss.
- Persönlich wird es mit dem Flugbuch: Vergleiche mit Flügen bei ähnlichen Bedingungen (Böen, Wind, Score), mit den Rückmeldungen «zu streng» oder «zu mild» und mit den eigenen Grenzen im Profil (maxWind, maxGust). Sag ehrlich, wenn es noch zu wenige Flüge sind, um das persönlich einzuschätzen.

Sicherheit:
- Zeigt AFC ein K.-o. (Föhn, Front, Gewitter, starke Böen, Nebel am Start oder Landeplatz, Lee bei Bise), rätst du vom Fliegen ab. Das überstimmst du nie, auch nicht wegen guter früherer Erfahrungen.
- Liegt die persönliche Grenze unter dem, was kommt, sagst du das deutlich.
- Du ersetzt nicht den Blick vor Ort: Windsack, Wolken, andere Piloten, Luftraum. Der Entscheid bleibt bei der Pilotin oder beim Piloten.
- AFC ist zum Planen und für danach gedacht, nicht für Fragen während des Flugs.

Antworte nur zu Gleitschirmfliegen, Wetter, Startplätzen und dem eigenen Fliegen. Bei anderen Themen sag freundlich, dass du dafür nicht da bist.`;

const obj = (props, req = []) => ({ type: 'object', properties: props, required: req, additionalProperties: false });
const DAY = { type: 'integer', minimum: 0, maximum: 4, description: '0 = heute, 1 = morgen, 2 = übermorgen …' };
export const TOOLS = [
  { name: 'uebersicht', description: 'Überblick über die nächsten Tage: pro Tag die besten Startplätze mit Zeitfenster und Score, die regionale Lage und wie sicher die Prognose ist. Zuerst aufrufen.', input_schema: obj({}) },
  { name: 'startplatz', description: 'Ein Startplatz im Detail für einen Tag: Stunde für Stunde Score, Wind, Böen, Gründe, K.-o., Wettervarianten und gemessener Nebel, dazu das beste Fenster und die nächste Messstation. Name oder ID.', input_schema: obj({ name: { type: 'string', description: 'Name oder ID des Startplatzes, z. B. «Niederhorn» oder «niederhorn-1»' }, tag: DAY }, ['name', 'tag']) },
  { name: 'lage', description: 'Regionale Lage eines Tages Stunde für Stunde (Föhn, Bise, Front, Gewitter, Wolkenbasis, Thermikhöhe) und für heute die Messwerte jetzt inklusive gemessenem Nebelmeer.', input_schema: obj({ tag: DAY }, ['tag']) },
  { name: 'messwerte', description: 'Aktuelle Messwerte der Wetterstationen (Wind, Böen, Richtung, Höhe, Alter der Messung).', input_schema: obj({}) },
  { name: 'mein_profil', description: 'Profil der fragenden Person: Erfahrungsstufe, Lizenz, Schirm, eigene Windgrenzen, Lieblings- und Heimstartplätze, und aus dem Flugbuch: Anzahl Flüge, letzte Flüge mit den damaligen Bedingungen, Rückmeldungen zu AFC, Tage ohne Start mit Grund, eigene Muster.', input_schema: obj({}) },
  { name: 'startplaetze', description: 'Liste aller Startplätze mit ID, Name, Gebiet, Höhe und Ausrichtung.', input_schema: obj({}) }
];

/* ---------------------------------------------------------------- Werkzeuge: kompakte Antworten aus AFC-Daten */
const R = v => (isNum(v) ? Math.round(v) : null);
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Startplatz nach ID oder Name finden (der beste Treffer, bei mehreren Richtungen die am besten bewertete). */
export function findSite(plan, name, day = 0) {
  const sites = plan?.sites || [];
  const q = norm(name);
  if (!q) return null;
  const exact = sites.find(s => s.id === name || norm(s.name) === q);
  if (exact) return exact;
  const words = q.split(' ');
  const hits = sites.filter(s => { const n = norm(s.name + ' ' + s.area); return words.every(w => n.includes(w)); });
  const pool = hits.length ? hits : sites.filter(s => norm(s.name + ' ' + s.area).includes(words[0]));
  return pool.sort((a, b) => (b.days?.[day]?.best?.score ?? -1) - (a.days?.[day]?.best?.score ?? -1))[0] || null;
}

export function toolOverview(plan) {
  if (!plan?.ok) return { fehler: 'Keine Prognose geladen' };
  return {
    tage: plan.dates.map((date, d) => {
      const best = plan.sites.filter(s => !s.blocked && s.days[d]?.best).sort((a, b) => b.days[d].best.score - a.days[d].best.score).slice(0, 6)
        .map(s => ({ id: s.id, name: s.name, gebiet: s.area, hoehe: s.alt, fenster: `${s.days[d].best.from}-${s.days[d].best.to} Uhr`, score: s.days[d].best.score, wetter: s.days[d].sky?.t || null }));
      const dd = plan.days[d] || {};
      return { tag: d, datum: date, beste: best, region: dd.regionStatus && dd.regionStatus !== 'ok' ? `${dd.regionWorst} (${dd.regionStatus === 'danger' ? 'K.-o.' : 'Vorsicht'})` : 'ruhig', sicherheit: dd.conf ? `${dd.conf.level}: ${dd.conf.why.join(', ')}` : null };
    }),
    schlagzeile: plan.headline ? { tag: plan.headline.day, text: plan.headline.text } : null,
    score: '80+ startbereit, 55-79 Vorsicht/prüfen, unter 55 nicht starten'
  };
}

export function toolSite(detail, site) {
  if (!detail?.ok) return { fehler: 'Startplatz nicht gefunden' };
  return {
    id: detail.site.id, name: detail.site.name, gebiet: detail.site.area, hoehe: detail.site.alt, ausrichtung: detail.site.aspects,
    status: detail.site.status || null, notizen: site?.notes?.slice(0, 3) || [],
    station: detail.nowcast ? { name: detail.nowcast.name, wind: detail.nowcast.obs, boeen: detail.nowcast.obsGust, vor_min: detail.nowcast.ageMin } : null,
    tage: detail.days.map(d => ({
      datum: d.date,
      bestes_fenster: d.best ? `${d.best.from}-${d.best.to} Uhr, Score ${d.best.score}` : 'keins',
      stunden: d.hours.filter(h => h.h >= 8 && h.h <= 19).map(h => ({
        h: h.h, score: h.score, wind: h.speed, boeen: h.gust, richtung: h.dir, ko: h.hard.map(x => x.replace(/^K\.-o\.: /, '')),
        gruende: h.reasons.slice(0, 3), thermik_bis: h.thermalTop, basis: h.cloudBase, regen_pct: h.pop,
        varianten: h.ens ? `${h.ens.n} Varianten, Böen ${h.ens.g[0]}-${h.ens.g[1]}; starke Böen ${pct(h.ens.ph)}, Regen ${pct(h.ens.pr)}, Bise ${pct(h.ens.pb)}, Föhn ${pct(h.ens.pf)}` : null,
        nebel: h.fog ? `${h.fog.k} (${h.fog.s}), ${h.fog.base}-${h.fog.top} m` : null
      }))
    })).slice(0, 3)
  };
}
const pct = p => (isNum(p) ? Math.round(p * 100) + ' %' : '–');

export function toolRegion(plan, d) {
  const day = plan?.region?.days?.[d];
  if (!day) return { fehler: 'Kein solcher Tag' };
  return {
    datum: day.date,
    stunden: day.hours.filter(h => h.h >= 7 && h.h <= 19).map(h => ({ h: h.h, lage: h.vs, schlimmstes: h.worst, foehn: h.foehn, bise: h.bise + (h.biseWeak ? ' (schwach)' : ''), front: h.front, gewitter: h.storm, basis: h.cb, thermik_bis: h.top, hoehenwind_2000: h.up800?.[0] ?? null })),
    jetzt: d === 0 && plan.region.now ? { foehn_signal: plan.region.now.foehnScore, bise: plan.region.now.bise, foehndruck: plan.region.now.dpFoehn, bisedruck: plan.region.now.dpBise, gruende: plan.region.now.reasons, nebel: plan.region.now.fog } : null
  };
}

export function toolStations(list) {
  return (list || []).sort((a, b) => (b.alt ?? 0) - (a.alt ?? 0)).slice(0, 24).map(s => ({ name: s.name, hoehe: s.alt, wind: R(s.wind), boeen: R(s.gust), richtung: R(s.dir), temp: R(s.temp), vor_min: s.age }));
}

/** Was AFC über die fragende Person weiss: Profil, Favoriten und ein verdichtetes Flugbuch mit Mustern. */
export function toolProfile({ name, profile = {}, prefs = {}, logbook = {}, nofly = [], plan }) {
  const flights = logbook.flights || [];
  const siteName = id => plan?.sites?.find(s => s.id === id)?.name || id;
  const fc = flights.filter(f => f.afcFc);
  const good = fc.filter(f => (f.rating || 0) >= 4);
  const maxOf = (a, k) => { const v = a.map(f => f.afcFc?.[k]).filter(isNum); return v.length ? Math.max(...v) : null; };
  const verdicts = { richtig: 0, streng: 0, mild: 0 };
  for (const f of flights) if (verdicts[f.afcVerdict] != null) verdicts[f.afcVerdict]++;
  const bySite = {};
  for (const f of flights) bySite[f.siteId || f.siteName] = (bySite[f.siteId || f.siteName] || 0) + 1;
  const year = new Date().getFullYear();
  return {
    name: name || null,
    stufe: prefs.level || null, lizenz: profile.license || null, fliegt_seit: profile.since || null, schirm: profile.wing || null,
    eigene_grenzen: { max_wind: profile.maxWind ?? null, max_boeen: profile.maxGust ?? null },
    flugstil: profile.styles || [], heimgebiete: (profile.homes || []).map(id => plan?.areas?.find(a => a.id === id)?.name || id), favoriten: (prefs.fav || []).map(siteName),
    flugbuch: {
      fluege: flights.length, dieses_jahr: flights.filter(f => String(f.date).startsWith(String(year))).length,
      meist_geflogen: Object.entries(bySite).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${siteName(k)} (${n})`),
      rueckmeldungen_zu_afc: verdicts,
      muster: fc.length >= 3 ? {
        fluege_mit_prognose: fc.length,
        hoechste_boeen_geflogen: maxOf(fc, 'gust'), hoechste_boeen_bei_guter_bewertung: maxOf(good, 'gust'),
        tiefster_score_geflogen: Math.min(...fc.map(f => f.afcFc.score).filter(isNum)),
        mittlerer_score_geflogen: Math.round(fc.map(f => f.afcFc.score).filter(isNum).reduce((a, b) => a + b, 0) / Math.max(1, fc.filter(f => isNum(f.afcFc.score)).length))
      } : 'noch zu wenige Flüge mit gespeicherter Prognose (ab 3)',
      letzte_fluege: flights.slice(0, 10).map(f => ({ datum: f.date, platz: f.siteName || siteName(f.siteId), dauer_min: f.durMin ?? null, bewertung: f.rating ?? null, afc_damals: f.afcFc ? { score: f.afcFc.score, wind: f.afcFc.speed, boeen: f.afcFc.gust, thermik_bis: f.afcFc.top } : null, rueckmeldung: f.afcVerdict || null, notiz: f.note ? String(f.note).slice(0, 120) : null })),
      nicht_gestartet: nofly.slice(0, 6).map(f => ({ datum: f.date, platz: f.siteName || siteName(f.siteId), grund: f.reason || null, afc_score: f.afcScore ?? null }))
    }
  };
}

export function toolSites(plan) {
  return (plan?.sites || []).map(s => ({ id: s.id, name: s.name, gebiet: s.area, hoehe: s.alt, ausrichtung: s.aspects, gesperrt: !!s.blocked }));
}

/* ---------------------------------------------------------------- Gespräch mit Claude */
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|fable-5-[12]|sonnet-5-5)$/;

/** Ein Aufruf der Messages API (ohne SDK, siehe oben). */
async function callClaude({ apiKey, model, messages, fetchImpl = fetch }) {
  const fb = FALLBACK_MODELS.test(model);
  const body = {
    model, max_tokens: 16000, system: SYSTEM, tools: TOOLS, messages,
    cache_control: { type: 'ephemeral' },          // Werkzeuge, System und bisheriges Gespräch bleiben im Cache
    output_config: { effort: 'low' },               // Chat: kurze Antworten, wenig Aufwand
    ...(fb ? { fallbacks: 'default' } : {})
  };
  const r = await fetchImpl(`${BASE()}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2026-10-21', ...(fb ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(90000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j?.error?.message || `HTTP ${r.status}`); e.status = r.status; throw e; }
  return j;
}

/**
 * Eine Frage beantworten. history: bisherige Nachrichten (werden unverändert weitergegeben, auch Denkblöcke).
 * run(name, input) führt ein Werkzeug aus und gibt ein Objekt zurück.
 * -> { reply, messages, tools: [Namen], usage }
 */
export async function askMyAfc({ apiKey, model = MYAFC_MODEL(), history = [], text, stamp, run, fetchImpl }) {
  const messages = [...history, { role: 'user', content: `[${stamp}] ${text}` }];
  const used = [], usage = { in: 0, out: 0, cacheRead: 0 };
  for (let step = 0; step < MAX_STEPS; step++) {
    const m = await callClaude({ apiKey, model, messages, fetchImpl });
    usage.in += m.usage?.input_tokens || 0; usage.out += m.usage?.output_tokens || 0; usage.cacheRead += m.usage?.cache_read_input_tokens || 0;
    messages.push({ role: 'assistant', content: m.content || [] });
    if (m.stop_reason === 'refusal') return { reply: 'Dazu kann ich leider nichts sagen. Frag mich gern zum Fliegen, zum Wetter oder zu deinen Startplätzen.', messages, tools: used, usage, refused: true };
    if (m.stop_reason === 'tool_use') {
      const results = [];
      for (const b of m.content.filter(x => x.type === 'tool_use')) {
        used.push(b.name);
        let content, isErr = false;
        try { content = JSON.stringify(await run(b.name, b.input || {})); }
        catch (e) { content = 'Fehler: ' + (e.message || e); isErr = true; }
        results.push({ type: 'tool_result', tool_use_id: b.id, content: content.slice(0, 60000), ...(isErr ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }
    const reply = (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    return { reply: reply || (m.stop_reason === 'max_tokens' ? 'Die Antwort wurde zu lang. Frag bitte etwas genauer.' : 'Ich habe gerade keine Antwort.'), messages, tools: used, usage };
  }
  return { reply: 'Ich habe zu viele Daten nachgeschaut und bin nicht fertig geworden. Frag bitte etwas genauer.', messages, tools: used, usage };
}

/** Fehlermeldung für die App, ohne technische Details nach aussen. */
export function myafcError(e) {
  if (e?.status === 401 || e?.status === 403) return { code: 503, msg: 'MyAFC ist nicht richtig eingerichtet (Schlüssel ungültig). Der Admin muss den Anthropic-Schlüssel prüfen.' };
  if (e?.status === 429 || e?.status === 529) return { code: 503, msg: 'MyAFC ist gerade ausgelastet. Versuch es in einer Minute nochmals.' };
  if (e?.status === 400) return { code: 502, msg: 'MyAFC konnte die Frage nicht verarbeiten. Starte ein neues Gespräch.' };
  return { code: 502, msg: 'MyAFC ist gerade nicht erreichbar. Versuch es später nochmals.' };
}
