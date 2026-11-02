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
* **Update holen:** AFC schaut alle 3 Stunden (per `git fetch`) nach einer neuen Version und zeigt dann oben einen Hinweis mit «Jetzt aktualisieren», aber nur, wenn die automatischen Tests auf GitHub (`.github/workflows/tests.yml`, `npm test` mit Node 22 und 24) für genau diesen Stand bestanden haben. Laufen sie noch oder sind sie durchgefallen, steht das unter Profil, und es gibt kein Update. «Jetzt aktualisieren» spielt genau den geprüften Stand ein (`git merge --ff-only <commit>`), beendet den Server, launchd startet ihn mit der neuen Version neu und die App lädt sich selbst neu. Unter Profil > «Verbrauch und Updates» lässt sich auch von Hand suchen. Der Knopf erscheint nur auf dem eigenen Mac (localhost) mit eingerichtetem Autostart. Ohne Autostart: `tools/AFC aktualisieren.command` doppelklicken.
* **Open-Meteo-Verbrauch:** Profil > «Verbrauch und Updates» zeigt die Aufrufe des Tages (wie Open-Meteo sie zählt) gegen das Gratislimit von 10 000.
* **Einführung:** erscheint beim ersten Öffnen, später unter Profil > Hilfe.
* **Nach eigenen Änderungen an `server.js` oder `lib/`:** `tools/AFC neu starten.command` doppelklicken, dann die App neu laden (Cmd+R). Änderungen an `app.js`, `app.css`, `index.html` brauchen nur Cmd+R.
* **Entfernen:** `tools/AFC Autostart entfernen.command`.
* Liegt der Ordner auf dem Schreibtisch oder in Dokumente, fragt macOS evtl. nach Zugriff für `node`. Das Einrichtungsskript erkennt das und sagt, was zu tun ist.

## Geländedaten der Startplätze

`node tools/build-terrain.js` berechnet aus einem Höhenmodell (AWS Terrain Tiles, ca. 26 m) für jeden Startplatz Hangneigung, Exposition, Relief und den Horizont in 24 Richtungen (Bergschatten) und schreibt sie in `lib/sites.json`. Nur nötig, wenn Startplätze dazukommen oder sich ändern. Fehlt die Platzhöhe, wird sie aus dem Höhenmodell übernommen (`altSource`).

**Pilotenprofil:** Unter «Profil» trägt man Flüge, Stunden der letzten 12 Monate, Schirmklasse, letzten Flug und Ausbildungsstand ein (`lib/pilot.js`, nur im Browser gespeichert). Daraus folgt die Erfahrungsstufe (Wind- und Böengrenzen); nach über 6 Wochen Pause eine Stufe vorsichtiger, nach 4 Monaten vorsichtig. «Kurz erklärt» zeigt unter «Du» persönliche Hinweise (kräftige Thermik für Einsteiger, Böen, lange Pause).

**XC-Routenplaner:** Auf der Karte «Route», dann Start A und Ziel B antippen (`lib/route.js`). Gesucht wird die schnellste Route über ein 500-m-Raster mit der Flughöhe als Zustand: Gleiten kostet Höhe (Gleitzahl und Geschwindigkeit aus dem Schirm im Profil: EN-A 6.5/34 km/h, EN-B 7/36, EN-C 7.5/38, EN-D 8/40), brauchbare Thermik bringt sie bis zur Obergrenze zurück, reine Gleitflüge ab Starthöhe gehen auch ohne Thermik; dazu Abstand zum Gelände, Wind auf Flughöhe (Gegen- und Seitenwind), Landeplätze im Gleitbereich (300 m Reserve). Das Wetter der folgenden Stunden (bis 4 h, höchstens 20 Uhr) fliesst mit ein, je nachdem wann man an einer Stelle ankommt. «Sicher» meidet schwache Abschnitte und fehlende Landeplätze stärker als «Schnell». Kritische Stellen werden nummeriert angezeigt. Lufträume: siehe unten.

**Thermik-Wärmekarte:** `node tools/build-thermal-grid.js` schreibt das Geländeraster `lib/terrain-grid.bin` (ca. 250 m: Höhe, Neigung, Exposition, Geländeform). Die App schätzt daraus je Stunde, wo Thermik ablöst (Ansicht «Thermik») oder wo der Wind frontal auf steile Hänge trifft (Ansicht «Soaring», Wind auf Geländehöhe aus Boden, 2000 m und 3000 m): Sonne auf dem Hang (Einfallswinkel, diese und die vorherige Stunde), Thermikobergrenze aus dem Temperaturprofil, Kreten und Kuppen, tiefe Wolken und Regen. Antippen der Karte zeigt die Begründung.

**Abgleich mit echten Flügen:** `node tools/calibrate-kk7.js` vergleicht die Wärmekarte mit [thermal.kk7.ch](https://thermal.kk7.ch) (Auswertung von rund 3,8 Mio. Flügen, CC BY-NC-SA 4.0, nur nicht-kommerziell) und sucht die Gewichtung, die am besten zu den Flügen passt. Ergebnis in `data/kk7-abgleich.txt`. Muss auf dem Mac laufen. Die kk7-Thermik und -Skyways lassen sich auch direkt als Kartenebene einblenden.

## Lufträume

Der Server lädt einmal täglich die offiziellen Luftraumdateien des SHV/FSVL (https://airspace.shv-fsvl.ch, OpenAir in Metern: CTR, TMA, Sperr- und Gefahrengebiete sowie Wildschutzgebiete), schneidet sie aufs Berner Oberland zu und liefert sie unter `/api/airspace`. Kopie in `data/airspace-*.txt`, falls der Abruf einmal nicht klappt. Auf der Karte mit dem Knopf «Luftraum» ein- und ausblenden (standardmässig aus; einzeln unter Ebenen). Nur Lufträume, die unter 3000 m beginnen, werden gezeichnet, solche ab Boden flächig. Rot = für Gleitschirme gesperrt (Klasse A–D, CTR, R, P, TMZ), orange = Gefahrengebiet, grün = Wildschutz. Antippen zeigt Name, Klasse und Höhen. Der Routenplaner bleibt unter gesperrten Lufträumen (50 m Abstand) oder darüber und fliegt um solche bis zum Boden herum (`lib/airspace.js`, `lib/route.js`). Aktivzeiten (Militär) und NOTAM sind nicht drin: vor dem Flug im DABS prüfen.

## Flugbuch

Reiter «Flugbuch»: Flüge mit Datum, Startzeit, Dauer, Start- und Landeplatz, Art, Strecke, Höhe, Schirm, Gurtzeug, Retter, Bewertung und Notiz. Dazu die Ausrüstung mit Fristen: AFC zählt die Stunden je Schirm und meldet fällige Schirm-Checks (nach Monaten oder Stunden) und Retter-Packtermine 30 Tage bzw. 10 Stunden im Voraus, auch oben im Reiter «Entscheid». Flüge vor dem Flugbuch lassen sich als Total nachtragen. Das Flugbuch füllt das Pilotenprofil (Flüge, Stunden der letzten 12 Monate, Schirmklasse des Standardschirms). Mit «IGC laden» (oder Dateien aufs Flugbuch ziehen) werden IGC-Dateien vom Vario oder Handy übernommen: Datum, Startzeit, Dauer, max. Höhe, Strecke, Start- und Landeplatz (nächster bekannter Platz im Umkreis von 800 m bzw. 1 km), Thermiken (Ort, Basis, Obergrenze, Steigen) und eine vereinfachte Spur mit Höhenprofil (`lib/igc.js`). Doppelte Flüge werden übersprungen. Es liegt nur auf diesem Rechner in `data/afc.sqlite` (`lib/logbook.js`).

**Rückmeldung nach dem Flug:** Oben im Flugbuch und im Reiter «Entscheid» fragt AFC nach jedem Flug der letzten 14 Tage an einem bekannten Startplatz: «Lag richtig», «Zu streng» oder «Zu mild» (auch im Flugformular änderbar). AFC merkt sich dazu den eigenen Wert zur Startzeit. Ab 3 Rückmeldungen an einem Platz (letzte 2 Jahre) passt AFC die Bewertung dort an: «zu mild» zählt doppelt, höchstens 8 Punkte vorsichtiger oder 4 Punkte grosszügiger, K.-o.-Deckel bleiben. Die Begründung steht beim Platz («Deine Rückmeldungen hier: …»).

**Sichern und exportieren:** AFC sichert das Flugbuch täglich und zwei Minuten nach jeder Änderung als `flugbuch-JJJJ-MM-TT.json` (zum Einspielen, die letzten 30 Tage) und `flugbuch-tabelle.csv` nach `data/backups/flugbuch` und, wenn iCloud Drive auf dem Mac eingeschaltet ist, zusätzlich nach `iCloud Drive/AFC-Sicherung` (anderer Ordner mit `AFC_BACKUP_DIR`, leer = keine Zweitkopie). Im Flugbuch: «Tabelle (Excel)» (CSV mit Semikolon), «Drucken / PDF» (Druckansicht der gewählten Jahres-Ansicht), «Sicherungsdatei» und «Sicherung laden» (führt nach Kennung zusammen, löscht nichts, macht vorher eine Kopie der Datenbank).

## Auf dem Handy (Tailscale)

AFC bleibt auf dem Mac; das Handy greift über Tailscale darauf zu (gratis, privat, HTTPS, nur Geräte im eigenen Tailscale-Konto). Tailscale auf Mac und Handy installieren und mit demselben Konto anmelden, dann `tools/AFC aufs Handy.command` doppelklicken (`tailscale serve --bg 8787`). Die Adresse `https://<mac>.<tailnet>.ts.net` in Safari öffnen, «Zum Home-Bildschirm». Der Server bleibt an 127.0.0.1 gebunden. Schläft der Mac, zeigt die App den letzten Stand mit Warnung; bei schlechtem Empfang erscheint nach 4 s die gespeicherte Version. Leaflet liegt unter `vendor/leaflet` (BSD-2), damit die Karte nicht von cdnjs abhängt. Beenden: `tools/AFC Handy-Zugang beenden.command`.

## Webcams

In der Startplatz-Ansicht steht unter dem Namen «Webcam»: ein Link auf die Windfinder-Seite des Gebiets (alle Webcams im Umkreis mit Entfernung und Zeit der letzten Aufnahme). Mit «eigene festlegen» lässt sich je Startplatz die eigene Lieblings-Webcam hinterlegen (nur https). Sie liegt im Flugbuch (Einstellungen) und gilt damit auf Mac und iPhone und ist in der Sicherung enthalten. Ramslauen (Kiental) hat noch keine Vorgabe.

## Benachrichtigungen (iPhone)

Profil > «Benachrichtigungen» > «Einschalten». Auf dem iPhone (ab iOS 16.4) geht das nur, wenn AFC vom Home-Bildschirm geöffnet ist (über den Tailscale-Zugang). Gratis und ohne fremden Dienst: Der Mac schickt die Meldungen per Web Push (`lib/webpush.js`, VAPID-Schlüssel in `data/vapid.json`) über den Push-Dienst von Apple ans iPhone, verschlüsselt. Abends um 19 Uhr: guter Flugtag morgen (bester Favorit, sonst bester Platz, ab einstellbarem Wert) und Föhn morgen. Morgens um 7 Uhr: Föhn heute, Retter packen und Schirm-Check fällig (14 Tage bzw. 5 Stunden vorher und am Stichtag). Jede Meldung kommt je Gerät nur einmal (`lib/notify.js`). Der Mac muss wach sein. `AFC_PUSH=0` schaltet es ab.

## Rückblick-Test

`node tools/backtest.js --days 90` (oder Doppelklick auf `tools/AFC Rückblick-Test.command`) rechnet AFC mit archivierten Prognosen von Open-Meteo für vergangene Tage durch und vergleicht das Urteil je Gebiet mit den Messungen der MeteoSchweiz (Föhn, Starkwind, Regen). Ergebnis in `data/backtest-<datum>.txt` und `.csv`. Getestet wird die Bewertungslogik mit kurzfristigen Prognosen; die Messung stammt von Talstationen.


Bergstationen (ab 1500 m, höchstens 20 km und 700 m Höhe vom Startplatz): Misst eine am Morgen mehr Wind als prognostiziert, hebt AFC für den Rest des Tages die Böen an diesen Startplätzen an (klingt über etwa 8 Stunden ab). Den Grundwind nicht, sonst sähe Soaring besser aus. Rückblick-Test 2026: im Frühling der letzte gefährliche Fall weg (Haslital 22.04.), im Winter weniger «zu mild» (15 → 11), Böenfehler am Berg etwa halbiert. Option `--ohne-berg` rechnet ohne diese Korrektur.

Selbst nachkalibrieren: Der Server vergleicht laufend die Prognose (3 h voraus) mit den Messungen der Bergstationen. Lagen die Böen in den letzten 14 Tagen (9–17 Uhr, mindestens 30 Stunden) im Schnitt über der Prognose, hebt AFC die Böen an Startplätzen in der Nähe um 60 % davon an (höchstens 10 km/h). Anzeige unter Profil > Verbrauch und Updates > «Selbst gelernt». Im Rückblick-Test nachgebildet (`--ohne-lernen` schaltet es ab).

Automatisch: Mit Autostart rechnet der Server jede Woche nachts (2–5 Uhr) die letzten 14 Tage durch (`--auto`, Zwischenspeicher wird danach gelöscht). Verlauf in `data/backtest-history.json`, Ergebnis unter Profil; dort auch «Jetzt prüfen». `AFC_BACKTEST_AUTO=0` schaltet es ab.

Ruhige Abgleiter: Ohne Thermik, aber mit ruhiger Luft (Böen bis 15, Wind bis 12 km/h) wertet AFC den Tag als schönen Abgleiter, höchstens «Prüfen» (76).
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
| `AFC_UPDATE_CHECK` | `1` | `0` schaltet die Update-Prüfung aus |
| `AFC_AUTOSTART` | – | `1` erlaubt das Update aus der App (setzt das Autostart-Skript) |

Für Tests überschreibbar: `AFC_AIRSPACE_URL`, `AFC_OPENMETEO_URL`, `AFC_SMN_URL`, `AFC_STATION_META_URL`.

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
| `GET /api/logbook`, `PUT`/`DELETE /api/logbook/(flight\|gear\|settings)/:id` | Persönliches Flugbuch (Header `X-AFC-Client`) |
| `GET /api/push/key`, `POST /api/push/(subscribe\|unsubscribe\|test\|status)` | Benachrichtigungen an- und abmelden, Test senden |
| `GET /api/logbook/export.(csv\|json)`, `POST /api/logbook/backup`, `POST /api/logbook/import` | Flugbuch exportieren, jetzt sichern, Sicherung einspielen |
| `GET /api/airspace` | Lufträume und Wildschutzgebiete (SHV/FSVL) im Gebiet |
| `GET /api/status` | Open-Meteo-Verbrauch heute und Update-Stand |
| `POST /api/update/check`, `POST /api/update` | Nach Update suchen / Update einspielen und neu starten (nur localhost, Update nur mit Autostart) |

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
