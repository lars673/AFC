# AFC 8.0 – Advance Flight Check

Flugwetter, Startplatz-Ranking und Startentscheid für das Berner Oberland. Node.js (ESM, `node:sqlite`) mit einer PWA als Oberfläche. Der Server holt und rechnet alles; die App zeigt an.

## Was neu ist (gegenüber 7.x)

* **Server rechnet, App ist dünn.** Prognose, Messwerte, Bewertung und Startfenster entstehen im Server (`lib/`). `GET /api/plan` liefert den ganzen Plan, `GET /api/site/:id` die Stundendetails.
* **Gewichtete Bewertung.** K.-o.-Kriterien (Kaltfront, Gewitter, Föhn, zu starker Wind/Böen, Regen, Wolke am Start, Rückenwind) deckeln den Score. Höhenwind ist nur ein leichter Abzug.
* **Fünf Tage, Gebietskarten, Erfahrungsstufe** (Vorsichtig / Normal / Erfahren) statt freier Windgrenzen.
* **Messung gegen Prognose**: nächste passende Station (höchstens 15 km, ±600 m Höhe, Messung jünger als 30 min) korrigiert die Prognose der nächsten Stunden (Einfluss halbiert sich etwa alle 1.4 h, höchstens ±12 km/h).
* **Windprofil und Scherung** aus DWD-ICON-Druckflächen als Turbulenzindikator. Wolkenbasis aus Temperatur und Taupunkt.
* **Modellvergleich** (MeteoSwiss ICON gegen ECMWF): bei grosser Uneinigkeit gibt es einen kleinen Abzug.
* **Karte** mit swisstopo-Landeskarte, Luftbild, Hangneigung und Hinderniskarte (Leaflet). Ausweichkarte: OpenStreetMap.
* **Prognosegüte pro Station** (Prognose 3 h voraus gegen Messung) statt Gewichts-Optimierung.
* Entfernt: Thermikkarte, Hangwindrechner, Notfallkontakt, IGC-Import, Webcams, Lern-/Backtest-Modell, `/api/forecast-snapshot`, `/api/terrain`.

## Lokal auf dem Mac (ohne Terminal)

* **Autostart einrichten:** `tools/AFC Autostart einrichten.command` doppelklicken. Der Server läuft dann im Hintergrund (launchd), startet beim Anmelden und nach einem Absturz neu. Adresse: http://localhost:8787, Protokoll in `data/server.log`.
* **Update holen:** `tools/AFC aktualisieren.command` doppelklicken (git pull + Neustart), dann Cmd+R in der App.
* **Nach eigenen Änderungen an `server.js` oder `lib/`:** `tools/AFC neu starten.command` doppelklicken, dann die App neu laden (Cmd+R). Änderungen an `app.js`, `app.css`, `index.html` brauchen nur Cmd+R.
* **Entfernen:** `tools/AFC Autostart entfernen.command`.
* Liegt der Ordner auf dem Schreibtisch oder in Dokumente, fragt macOS evtl. nach Zugriff für `node`. Das Einrichtungsskript erkennt das und sagt, was zu tun ist.

## Geländedaten der Startplätze

`node tools/build-terrain.js` berechnet aus einem Höhenmodell (AWS Terrain Tiles, ca. 26 m) für jeden Startplatz Hangneigung, Exposition, Relief und den Horizont in 24 Richtungen (Bergschatten) und schreibt sie in `lib/sites.json`. Nur nötig, wenn Startplätze dazukommen oder sich ändern. Fehlt die Platzhöhe, wird sie aus dem Höhenmodell übernommen (`altSource`).

**Pilotenprofil:** Unter «Profil» trägt man Flüge, Stunden der letzten 12 Monate, Schirmklasse, letzten Flug und Ausbildungsstand ein (`lib/pilot.js`, nur im Browser gespeichert). Daraus folgt die Erfahrungsstufe (Wind- und Böengrenzen); nach über 6 Wochen Pause eine Stufe vorsichtiger, nach 4 Monaten vorsichtig. «Kurz erklärt» zeigt unter «Du» persönliche Hinweise (kräftige Thermik für Einsteiger, Böen, lange Pause).

**XC-Routenplaner:** Auf der Karte «Route», dann Start A und Ziel B antippen (`lib/route.js`). Gesucht wird die schnellste Route über ein 500-m-Raster mit der Flughöhe als Zustand: Gleiten kostet Höhe (Gleitzahl und Geschwindigkeit aus dem Schirm im Profil: EN-A 6.5/34 km/h, EN-B 7/36, EN-C 7.5/38, EN-D 8/40), brauchbare Thermik bringt sie bis zur Obergrenze zurück, reine Gleitflüge ab Starthöhe gehen auch ohne Thermik; dazu Abstand zum Gelände, Wind auf Flughöhe (Gegen- und Seitenwind), Landeplätze im Gleitbereich (300 m Reserve). Das Wetter der folgenden Stunden (bis 4 h, höchstens 20 Uhr) fliesst mit ein, je nachdem wann man an einer Stelle ankommt. «Sicher» meidet schwache Abschnitte und fehlende Landeplätze stärker als «Schnell». Kritische Stellen werden nummeriert angezeigt. Luftraum ist noch nicht berücksichtigt.

**Thermik-Wärmekarte:** `node tools/build-thermal-grid.js` schreibt das Geländeraster `lib/terrain-grid.bin` (ca. 250 m: Höhe, Neigung, Exposition, Geländeform). Die App schätzt daraus je Stunde, wo Thermik ablöst (Ansicht «Thermik») oder wo der Wind frontal auf steile Hänge trifft (Ansicht «Soaring», Wind auf Geländehöhe aus Boden, 2000 m und 3000 m): Sonne auf dem Hang (Einfallswinkel, diese und die vorherige Stunde), Thermikobergrenze aus dem Temperaturprofil, Kreten und Kuppen, tiefe Wolken und Regen. Antippen der Karte zeigt die Begründung.

**Abgleich mit echten Flügen:** `node tools/calibrate-kk7.js` vergleicht die Wärmekarte mit [thermal.kk7.ch](https://thermal.kk7.ch) (Auswertung von rund 3,8 Mio. Flügen, CC BY-NC-SA 4.0, nur nicht-kommerziell) und sucht die Gewichtung, die am besten zu den Flügen passt. Ergebnis in `data/kk7-abgleich.txt`. Muss auf dem Mac laufen. Die kk7-Thermik und -Skyways lassen sich auch direkt als Kartenebene einblenden.

## Rückblick-Test

`node tools/backtest.js --days 90` (oder Doppelklick auf `tools/AFC Rückblick-Test.command`) rechnet AFC mit archivierten Prognosen von Open-Meteo für vergangene Tage durch und vergleicht das Urteil je Gebiet mit den Messungen der MeteoSchweiz (Föhn, Starkwind, Regen). Ergebnis in `data/backtest-<datum>.txt` und `.csv`. Getestet wird die Bewertungslogik mit kurzfristigen Prognosen; die Messung stammt von Talstationen.

## Deployment

* **Render**: `render.yaml` (Disk auf `/app/data`).
* **Railway**: Volume auf `/app/data` mounten, Public Domain erzeugen, `railway.json` ist vorbereitet.
* Die Icons `icon-192.png` und `icon-512.png` müssen im Projektstamm liegen (Dockerfile kopiert sie).

Healthcheck: `/healthz` (ohne DB-Zugriff). Vollstatus mit Quellenzustand: `/api/health`.

## Umgebungsvariablen

| Variable | Default | Bedeutung |
|---|---|---|
| `PORT` | `8787` | HTTP-Port |
| `AFC_DATA_DIR` | `./data` | SQLite, Backups und Zwischenspeicher der Prognose |
| `AFC_TRUSTED_PROXY_HOPS` | `1` | Wie viele Proxys vor dem Server stehen (für die IP des Rate-Limits). Ohne Proxy `0` |
| `CORS_ORIGIN` | leer | Leer = nur gleiche Herkunft. Nur setzen, wenn die App von einer anderen Domain kommt |
| `AFC_OBS_MIN` / `AFC_FORECAST_MIN` / `AFC_WINDGRID_MIN` | `10` / `60` / `180` | Abrufrhythmus in Minuten. Open-Meteo zählt jeden Punkt (und je 10 Variablen) als Abruf, gratis 10 000/Tag. Die Vorgaben brauchen rund 6 500. Die Modelle (ICON-CH1/CH2) rechnen ohnehin nur alle 3–6 h neu |
| `AFC_FETCH_TIMEOUT_MS` | `20000` | Timeout externer Abrufe |
| `PUBLIC_APP_URL` | – | nur informativ (`/api/meta`) |

Für Tests überschreibbar: `AFC_OPENMETEO_URL`, `AFC_SMN_URL`, `AFC_STATION_META_URL`.

## API

| Route | Zweck |
|---|---|
| `GET /api/plan?level=careful\|normal\|expert` | Plan für 5 Tage: Gebiete, Startplätze, Lage, Stationen, Quellenstatus. ETag, gzip. `202`, solange die ersten Daten laden |
| `GET /api/site/:id?level=…` | Stundendetails, Windprofil, Messvergleich, «Kurz erklärt» |
| `GET /api/wind?level=10m\|800\|700&t=ISO` | Windfeld für die Karte (Raster ca. 9 km, u/v in km/h), alle 3 h aktualisiert |
| `GET /api/thermal?t=ISO` | Thermikwerte je Rasterpunkt (Sonne, tiefe Wolken, Regen, Thermikobergrenze, w*) und Sonnenstand; gleiche Abrufe wie das Windfeld |
| `GET /terrain-grid.bin` | Geländeraster der Wärmekarte |
| `POST /api/flight-report` | Flugmeldung (Header `X-AFC-Client`), validiert: bekannter Startplatz, Zeit der letzten 14 Tage, Bewertung 1–5, höchstens 20 pro Tag |
| `GET /api/privacy/export`, `DELETE /api/privacy/delete` | Export und Löschung der Meldungen dieses Geräts |
| `GET /api/health`, `GET /api/meta`, `GET /healthz` | Status |

Rate-Limits pro IP (über `X-Forwarded-For`, `AFC_TRUSTED_PROXY_HOPS`): 180 Anfragen/min allgemein, 10/min für Schreibzugriffe. Body höchstens 16 KB.

## Tests

```
npm test
```

* `test/scoring.test.js`: Bewertungslogik (Front-K.-o., Höhenwind leicht, Föhn/Gewitter, Scherung, Startfenster).
* `test/server.test.js`: startet den Server gegen einen simulierten Datenanbieter (`test/mock-upstream.js`) und prüft Plan, Detail, Validierung, Rate-Limit, Datenschutz.

## Datenquellen

* Prognose: MeteoSwiss ICON-CH1/CH2 (`meteoswiss_icon_seamless`), DWD ICON (Druckflächen), ECMWF IFS (Modellvergleich) – alle über Open-Meteo. **Open-Meteo ist in der kostenlosen Version nur für nicht-kommerzielle Nutzung erlaubt.**
* Messwerte: MeteoSchweiz SwissMetNet (`VQHA80.csv`, Rückfall `ogd-smn/*_t_now.csv`), Föhnindex der MeteoSchweiz.
* Startplätze: DHV-Geländedatenbank (Stand siehe `lib/sites.json`). Plätze ohne bekannte Höhe, gesperrte und Landeplätze werden nicht bewertet; Landeplätze erscheinen auf der Karte.
* Karte: swisstopo-WMTS, Leaflet 1.9.4 von cdnjs.

## Grenzen

* Der Score ist eine Entscheidungshilfe, keine Flugfreigabe.
* Es gibt keine Push-Benachrichtigungen (würden einen Zusatzdienst und Schlüsselverwaltung erfordern).
* Die Auflagen «Hangneigung» und «Hindernisse» der Karte sind Orientierungshilfen; die Ebenennamen sind bei swisstopo/BAZL zu prüfen (siehe Hinweis im Code `app.js`, `OVERLAYS`).
