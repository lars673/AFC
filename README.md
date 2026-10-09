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
| `AFC_OBS_MIN` / `AFC_FORECAST_MIN` | `10` / `30` | Abrufrhythmus in Minuten |
| `AFC_FETCH_TIMEOUT_MS` | `20000` | Timeout externer Abrufe |
| `PUBLIC_APP_URL` | – | nur informativ (`/api/meta`) |

Für Tests überschreibbar: `AFC_OPENMETEO_URL`, `AFC_SMN_URL`, `AFC_STATION_META_URL`.

## API

| Route | Zweck |
|---|---|
| `GET /api/plan?level=careful\|normal\|expert` | Plan für 5 Tage: Gebiete, Startplätze, Lage, Stationen, Quellenstatus. ETag, gzip. `202`, solange die ersten Daten laden |
| `GET /api/site/:id?level=…` | Stundendetails, Windprofil, Messvergleich |
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
