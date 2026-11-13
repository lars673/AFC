// «So genau war AFC»: öffentliche Seite mit dem ehrlichen Rückblick. Quelle sind die wöchentlichen Rückblick-Tests
// (tools/backtest.js: Bewertung je Gebiet und Tag gegen das, was die Stationen danach gemessen haben) und die
// Rückmeldungen der Piloten nach ihren Flügen (nur Summen, nie Namen). Die Seite braucht kein JavaScript.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dd = d => String(d || '').split('-').reverse().map((x, i) => (i < 2 ? String(Number(x)) : x)).join('.');
const pct = (a, n) => (n ? Math.round(a / n * 100) : null);

/**
 * Zahlen für die Seite. history: Läufe aus backtest-history.json (älteste zuerst), verdicts: { richtig, streng, mild }.
 * Mehrere Läufe über denselben Zeitraum zählen einmal (der neueste). -> { last, runs, total, verdicts }
 */
export function accuracyData({ history = [], verdicts = {} } = {}) {
  const byRange = new Map();
  for (const h of history) if (h && h.n > 0 && h.from && h.to) byRange.set(h.from + h.to, h);
  const runs = [...byRange.values()].sort((a, b) => a.to.localeCompare(b.to)).slice(-12).map(h => ({
    from: h.from, to: h.to, n: h.n, passt: h.passt, pct: pct(h.passt, h.n), gefaehrlich: h.gefaehrlich || 0, zuStreng: h.zuStreng || 0,
    berg: h.berg ? { n: h.berg.n, gefaehrlich: h.berg.gefaehrlich || 0, zuMild: h.berg.zuMild || 0, gustBias: h.berg.gustBias ?? null } : null,
    bise: h.bise || null, faelle: Array.isArray(h.faelle) ? h.faelle.slice(0, 10) : []
  }));
  // Summe ohne doppelte Tage: Läufe überlappen sich (14 Tage, jede Woche), darum nur jeder zweite von hinten
  const pick = [];
  for (let i = runs.length - 1, until = null; i >= 0; i--) if (!until || runs[i].to < until) { pick.push(runs[i]); until = runs[i].from; }
  const sum = k => pick.reduce((t, r) => t + (r[k] || 0), 0);
  const total = pick.length ? { from: pick.at(-1).from, to: pick[0].to, n: sum('n'), pct: pct(sum('passt'), sum('n')), gefaehrlich: sum('gefaehrlich'), zuStreng: sum('zuStreng') } : null;
  const v = { richtig: verdicts.richtig || 0, streng: verdicts.streng || 0, mild: verdicts.mild || 0 };
  v.n = v.richtig + v.streng + v.mild;
  return { last: runs.at(-1) || null, runs, total, verdicts: v };
}

const CSS = `
:root{color-scheme:light dark;--bg:#eef1ec;--panel:#fff;--line:#d3dbd1;--ink:#101c15;--muted:#4f5f55;--accent:#0d5b78;--go:#167a3f;--check:#a88c00;--no:#bf2f2f;--bar:#dfe5dc}
@media (prefers-color-scheme:dark){:root{--bg:#0d1410;--panel:#151f19;--line:#2a392f;--ink:#e9f0ea;--muted:#a2b3a7;--accent:#6cc3e2;--go:#4cc27c;--check:#e0c341;--no:#ef6b6b;--bar:#26342b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.55 'Barlow',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:28px 18px 56px}
a{color:var(--accent)}
.brand{font:600 15px/1 inherit;letter-spacing:.08em;color:var(--muted);text-decoration:none}
h1{font:700 clamp(30px,7vw,44px)/1.1 'Barlow Condensed','Barlow',system-ui,sans-serif;margin:14px 0 6px}
h2{font:700 22px/1.2 'Barlow Condensed','Barlow',system-ui,sans-serif;margin:0 0 8px}
.lead{color:var(--muted);margin:0 0 22px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:18px;margin:0 0 14px}
.nums{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;text-align:center}
.nums b{display:block;white-space:nowrap;font:700 clamp(30px,9vw,52px)/1 'Barlow Condensed','Barlow',system-ui,sans-serif}
.nums span{display:block;color:var(--muted);font-size:14px;line-height:1.3;margin-top:4px}
.go{color:var(--go)}.no{color:var(--no)}.check{color:var(--check)}
.fine{color:var(--muted);font-size:14.5px;margin:10px 0 0}
.runs{list-style:none;margin:0;padding:0}
.runs li{display:grid;grid-template-columns:104px 1fr 54px;gap:10px;align-items:center;padding:5px 0;font-size:15px}
.runs .bar{height:10px;border-radius:5px;background:var(--bar);overflow:hidden}
.runs .bar i{display:block;height:100%;border-radius:5px;background:var(--go)}
.runs .bad .bar i{background:var(--no)}
.runs b{text-align:right;font-variant-numeric:tabular-nums}
.runs small{grid-column:2/4;color:var(--no);font-size:13.5px;margin-top:-4px}
ul.plain{margin:6px 0 0;padding-left:20px}
ul.plain li{margin:3px 0}
`;

/** Die ganze Seite als HTML. d: accuracyData(), o: { version } */
export function accuracyHtml(d, o = {}) {
  const L = d.last, T = d.total;
  const head = `<!doctype html><html lang="de-CH"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>So genau war AFC</title><meta name="description" content="AFC prüft jede Woche die eigene Prognose gegen die Messwerte und zeigt das Ergebnis offen.">
<link rel="icon" href="/icon-192.png"><style>${CSS}</style></head><body><main>
<a class="brand" href="/">AFC · ADVANCED FLIGHT CHECK</a>
<h1>So genau war AFC</h1>
<p class="lead">AFC prüft jede Woche die eigene Prognose gegen das, was die Wetterstationen danach wirklich gemessen haben. Hier steht das Ergebnis, auch wenn es einmal schlecht ist.</p>`;
  const foot = `<p class="fine">AFC ist eine Entscheidungshilfe. Keine Gewähr: Der Startentscheid liegt immer bei der Pilotin oder beim Piloten.${o.version ? ` · AFC ${esc(o.version)}` : ''}</p></main></body></html>`;
  if (!L) return `${head}<div class="card"><h2>Noch keine Zahlen</h2><p style="margin:0">Der erste Rückblick läuft automatisch in einer der nächsten Nächte. Danach kommt jede Woche einer dazu.</p></div>${how()}${foot}`;
  const nums = x => `<div class="nums">
<div><b class="${x.pct >= 85 ? 'go' : x.pct >= 70 ? 'check' : 'no'}">${x.pct}&nbsp;%</b><span>der Tage passte die Bewertung</span></div>
<div><b class="${x.gefaehrlich ? 'no' : 'go'}">${x.gefaehrlich}</b><span>gefährlich: «Start» gesagt, Wetter war schlecht</span></div>
<div><b class="check">${x.zuStreng}</b><span>zu streng: «Nein» gesagt, Wetter war gut</span></div></div>`;
  const last = `<div class="card"><h2>Letzte zwei Wochen</h2>${nums(L)}
<p class="fine">${dd(L.from)} bis ${dd(L.to)} · ${L.n} Bewertungen (jedes Fluggebiet an jedem Tag einmal).</p>
${L.faelle.length ? `<p class="fine" style="color:var(--no)"><b>Die gefährlichen Fälle:</b></p><ul class="plain">${L.faelle.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}</div>`;
  const all = T && d.runs.length > 1 ? `<div class="card"><h2>Seit ${dd(T.from)}</h2>${nums(T)}
<p class="fine">${T.n} Bewertungen bis ${dd(T.to)}.</p></div>` : '';
  const runs = d.runs.length > 1 ? `<div class="card"><h2>Verlauf</h2><ul class="runs">${d.runs.slice().reverse().map(r => `<li class="${r.gefaehrlich ? 'bad' : ''}"><span>bis ${dd(r.to)}</span><span class="bar"><i style="width:${r.pct}%"></i></span><b>${r.pct} %</b>${r.gefaehrlich ? `<small>${r.gefaehrlich} gefährlich</small>` : ''}</li>`).join('')}</ul>
<p class="fine">Jede Zeile ist ein Rückblick über 14 Tage. Rot heisst: In diesem Zeitraum gab es mindestens einen gefährlichen Fall.</p></div>` : '';
  const extra = [];
  if (L.berg?.n) extra.push(`<li><b>Wind am Berg:</b> ${L.berg.n} Vergleiche mit Bergstationen zur besten Stunde. ${L.berg.gefaehrlich} gefährlich, ${L.berg.zuMild} zu mild.${L.berg.gustBias != null ? ` Die Böen-Prognose lag im Schnitt ${String(Math.abs(L.berg.gustBias)).replace('.', ',')} km/h ${L.berg.gustBias > 0 ? 'zu hoch' : L.berg.gustBias < 0 ? 'zu tief' : 'daneben'}.` : ''}</li>`);
  if (L.bise?.tage != null) extra.push(`<li><b>Bise:</b> an ${L.bise.tage} Tagen gemessen, davon ${L.bise.verpasst} nicht vorhergesagt. ${L.bise.umsonst} Mal umsonst gewarnt.</li>`);
  const V = d.verdicts;
  if (V.n >= 5) extra.push(`<li><b>Urteil der Piloten nach dem Flug:</b> ${V.n} Rückmeldungen. ${pct(V.richtig, V.n)} % «lag richtig», ${pct(V.streng, V.n)} % «zu streng», ${pct(V.mild, V.n)} % «zu mild».</li>`);
  const more = extra.length ? `<div class="card"><h2>Genauer hingeschaut</h2><ul class="plain">${extra.join('')}</ul></div>` : '';
  return `${head}${last}${all}${runs}${more}${how()}${foot}`;
}

function how() {
  return `<div class="card"><h2>So wird geprüft</h2>
<ul class="plain">
<li>Für jedes Fluggebiet und jeden Tag nimmt AFC die beste Bewertung, die es für diesen Tag gegeben hat: «Start» (ab 80), «Prüfen» (55 bis 79) oder «Nein».</li>
<li>Danach zählt, was die nächste Station von MeteoSchweiz gemessen hat: Föhn, Bise, Wind ab 30 km/h, Böen ab 45 km/h oder Regen gelten als schlecht.</li>
<li><b>Gefährlich</b> ist der Fehler, der nie passieren darf: AFC sagt «Start» und das Wetter war schlecht. <b>Zu streng</b> ist der harmlose Fehler: AFC sagt «Nein» und es wäre gut gewesen.</li>
<li>AFC ist lieber einmal zu streng als einmal gefährlich. Aus jedem Rückblick lernt es dazu.</li>
</ul></div>`;
}
