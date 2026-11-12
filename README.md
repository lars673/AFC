# AFC 8.0 – Advanced Flight Check

Flugwetter, Startplatz-Ranking und Startentscheid für das Berner Oberland. Node.js (ESM, `node:sqlite`) mit einer PWA als Oberfläche. Der Server holt und rechnet alles; die App zeigt an.

## Was neu ist (gegenüber 7.x)

* **Server rechnet, App ist dünn.** Prognose, Messwerte, Bewertung und Startfenster entstehen im Server (`lib/`). `GET /api/plan` liefert den ganzen Plan, `GET /api/site/:id` die Stundendetails.
* **Gewichtete Bewertung.** K.-o.-Kriterien (Kaltfront, Gewitter, Föhn, zu starker Wind/Böen, Regen, Wolke am Start, Rückenwind) deckeln den Score. Höhenwind ist nur ein leichter Abzug.
* **Fünf Tage, Gebietskarten, Erfahrungsstufe** (Vorsichtig / Normal / Erfahren) statt freier Windgrenzen.
* **Messung gegen Prognose**: nächste passende Station (höchstens 15 km, ±600 m Höhe, Messung jünger als 30 min) korrigiert die Prognose der nächsten Stunden (Einfluss halbiert sich etwa alle 1.4 h, höchstens ±12 km/h).
* **Windprofil und Scherung** aus DWD-ICON-Druckflächen als Turbulenzindikator. Wolkenbasis aus Temperatur und Taupunkt.
* **Modellvergleich** (MeteoSwiss ICON gegen ECMWF): bei grosser Uneinigkeit gibt es einen kleinen Abzug.
* **Karte** mit swisstopo-Landeskarte, Luftbild, Hangneigung (Leaflet). Ausweichkarte: OpenStreetMap.
* **Kabel und Hindernisse** (Knopf «Kabel» auf der Karte): Luftfahrthindernisse des BAZL (Seilbahnen violett, Kabel rot gestrichelt, Masten/Krane als Punkt), antippbar mit Höhe über Grund, m ü. M., Länge, Markierung. Der Server lädt `luftfahrthindernis_4326.kmz` von data.geo.admin.ch einmal am Tag (das BAZL stellt die Daten täglich ab 04 Uhr neu bereit), speichert sie in `data/luftfahrthindernis.kmz` und liefert `/api/obstacles?b=süd,west,nord,ost` bzw. `?near=lat,lon&r=m`. Die Startplatz-Ansicht zeigt Kabel im Umkreis von 1,5 km um den Start und 1 km um den Landeplatz. Erfasst sind nur meldepflichtige Hindernisse; `AFC_OBSTACLE_URL` ändert die Quelle.
* **Prognosegüte pro Station** (Prognose 3 h voraus gegen Messung) statt Gewichts-Optimierung.
* Entfernt: Thermikkarte, Hangwindrechner, Notfallkontakt, IGC-Import, Webcams, Lern-/Backtest-Modell, `/api/forecast-snapshot`, `/api/terrain`.

## Lokal auf dem Mac (ohne Terminal)

* **Autostart einrichten:** `tools/AFC Autostart einrichten.command` doppelklicken. Der Server läuft dann im Hintergrund (launchd), startet beim Anmelden und nach einem Absturz neu. Adresse: http://localhost:8787, Protokoll in `data/server.log`.
* **Update holen:** AFC schaut alle 3 Stunden (per `git fetch`) nach einer neuen Version und zeigt dann oben einen Hinweis mit «Jetzt aktualisieren», aber nur, wenn die automatischen Tests auf GitHub (`.github/workflows/tests.yml`, `npm test` mit Node 22 und 24) für genau diesen Stand bestanden haben. Laufen sie noch oder sind sie durchgefallen, steht das unter Profil, und es gibt kein Update. «Jetzt aktualisieren» spielt genau den geprüften Stand ein (`git merge --ff-only <commit>`), beendet den Server, launchd startet ihn mit der neuen Version neu und die App lädt sich selbst neu. Unter Profil > «AFC und Updates» lässt sich auch von Hand suchen. Der Knopf erscheint nur auf dem eigenen Mac (localhost) mit eingerichtetem Autostart. Ohne Autostart: `tools/AFC aktualisieren.command` doppelklicken.
* **Open-Meteo-Verbrauch:** Profil > «Technik und Daten» (eingeklappt) > «Verbrauch und Lernen» zeigt die Aufrufe des Tages (wie Open-Meteo sie zählt) gegen das Gratislimit von 10 000.
* **Einführung:** erscheint beim ersten Öffnen, später unter Profil > Hilfe.
* **Bedienung:** «Entscheid» ist eine kompakte Liste je Gebiet, sortierbar nach «Beste» oder «In der Nähe» (Standort, nur im Browser). Die Startplatz-Ansicht zeigt zuerst Bewertung und «Kurz erklärt», danach Wächter, Favorit, Karte, Flug melden und Webcam; auf dem Handy füllt sie den Bildschirm. «Flugtag» zeigt die Messwerte als Karten: Stationen nahe den Favoriten (sonst nahe dir, sonst die hohen) zuerst, gefärbt ab Böen 25/35 km/h (vorsichtig 22/30, erfahren 30/40). Die Stundentabelle unter «Lage» zeigt auf dem Handy alle 3 Stunden und passt ohne Wischen. «Profil» hat drei Bereiche: Mein Fliegen, App, und eingeklappt Technik und Daten.
* **Am Startplatz:** Nach jedem Laden speichert AFC die Startplatz-Details der Favoriten und Wächter-Plätze im Browser (höchstens 12). Ohne Empfang erscheinen sie mit dem Hinweis «gespeicherter Stand» und dem Alter; das Alter der Messwerte wird ab dem Messzeitpunkt gerechnet. Der Sonnen-Knopf oben (oder Profil > Darstellung > Sonne) schaltet auf Weiss/Schwarz, kräftige Farben und grössere Schrift.
* **Landeplatz:** In der Startplatz-Ansicht der nächste Landeplatz im Gebiet mit Prognose zur gewählten Stunde und, für heute, der nächsten Messstation (höchstens 12 km, 400 m Höhenunterschied). Farbig ab 22 / 28 km/h (Böen zu drei Vierteln gezählt), wie in der Bewertung.
* **Wochenblick und Vergleichen** (Knöpfe unter «Entscheid»): bester Score und Fenster je Favorit und Gebiet für alle Prognosetage; bis zu drei Startplätze Stunde für Stunde nebeneinander (Auswahl bleibt gespeichert).
* **Flugbuch-Statistik:** Flugstunden je Monat (gewähltes Jahr oder letzte 12 Monate), Flugarten und die meistgeflogenen Plätze mit Stunden und Bewertung.
* **Karte:** Startplätze, die näher als 38 Pixel beieinander liegen, werden zu einem Punkt mit dem besten Score und der Anzahl zusammengefasst; Antippen zeigt alle in einer Liste («Hineinzoomen» trennt sie). In der Gebietsliste stehen Starts am selben Berg (höchstens 1.5 km auseinander) unter einer Überschrift, beste Richtung zuerst.
* **Flugtag-Rückblick:** Beim Speichern oder IGC-Import eines Flugs hält AFC die Prognose zur Startzeit fest (Score, Wind, Böen, Thermik-Obergrenze, Basis, Steigen, Fenster; Feld `afcFc`). Im Flug steht dann «Prognose gegen Flug» (`flightReview` in `lib/logbook.js`): Thermikhöhe und Steigen aus der IGC-Spur gegen die Prognose. Abends (19 bis 21 Uhr) kommt für heutige Flüge ohne Rückmeldung eine Mitteilung (abschaltbar unter Benachrichtigungen).
* **Einhand-Bedienung:** Auf dem Handy liegt «Schliessen» in der Startplatz-Ansicht unten, und die Kartenknöpfe sitzen unten rechts.
* **Regenradar:** Karte > Ebenen > «Regenradar» (RainViewer, gratis für persönliche Nutzung, Zoom bis 7, alle 10 Minuten). Der Mac holt die Bilder (`/api/radar`, `lib/media.js`), die App bleibt auf der eigenen Adresse. In der Startplatz-Ansicht (heute) steht «Regen jetzt»: nächster Regen im Umkreis von 30 km mit Richtung und ob er in den letzten 20 Minuten näher kam.
* **Webcam-Bild:** Ist bei «eigene festlegen» die Adresse eines Bildes hinterlegt (lange auf das Webcam-Bild drücken > «Bildadresse kopieren»), zeigt die Startplatz-Ansicht das Bild mit Uhrzeit. Der Mac lädt es (`/api/camimg`, nur https, nichts aus dem lokalen Netz, höchstens 4 MB).
* **Föhn- und Bisedruck:** Unter «Lage» je Stunde der prognostizierte Druckunterschied Lugano–Zürich (Föhn, ab +4 / +8 hPa) und Zürich–Genf (Bise, ab +2 / +4 hPa), unter «Jetzt gemessen» die gemessenen Werte (QFF von LUG, KLO, GVE).
* **Bise** (nach dem 1.11.2026 in Interlaken): Stufe je Stunde aus Bisedruck, Nordostwind auf 2000 m und Messungen (`biseLevel` in `lib/scoring.js`). Startplätze am Nordrand (nördlich 46.6°, also Thuner-/Brienzersee, Interlaken, Haslital) zählen voll: bei starker Bise ist ein von Nordost abgewandter Hang (Lee) K.-o., ein Nordost-Hang höchstens 70. Tiefere Täler bekommen nur einen Hinweis. Mitteilung am Vorabend und am Morgen zusammen mit der Föhnwarnung. Prognose-Schwellen nach dem Rückblick Januar–Mai 2026 (Lars' Mac): Vorsicht ab +2 hPa Kloten–Genf (März–Mai: ab 2 hPa an 8 von 15 Tagen Bise gemessen, darunter an 1 von 77), Gefahr ab +4 hPa. Bei «Vorsicht» sind Startplätze am Nordrand höchstens «Prüfen» (74), weil AFC am 22.4. und 28./29.5. trotz gemessener Bise «Start» sagte. Im Winter brachten 3–4 hPa keine gemessene Bise, darum bleibt die Gefahrenschwelle bei 4 hPa. Eine Bise-Warnung zwischen 6 und 20 Uhr gilt für den ganzen Tag mindestens als Vorsicht (28./29.5.: Warnung am Morgen, um 15 Uhr nachlassender Druckunterschied, gemessen aber starke Bise).
  Die Messregeln sind mit den echten Daten vom 30.10. bis 2.11.2026 geprüft: Am 1.11. zeigten Brienz (Ostwind über den Brienzersee, Böen bis 43 km/h), Meiringen (Nordwest über den Brünig, Böen bis 46) und Interlaken (Nordwind, Böen bis 30) das typische Bödeli-Muster. Diese Stationen zählen jetzt mit, aber nur wenn im Vorland (Bern, Thun, Plaffeien oder Druck) Bise ist und am Grimsel kein Föhn. Ergebnis: am 1.11. Warnung ab 09:20, Gefahr von 10:40 bis 16:20; an den Tagen davor und danach keine Warnung.
  Der Rückblick-Test (`tools/backtest.js`) prüft die Bise-Prognose: er lädt zusätzlich den Druck in Lugano, Kloten und Genf (gemessen und Prognose) sowie Brienz und Plaffeien und zeigt im Bericht unter «BISE-PROGNOSE», an wie vielen Bisetagen AFC gewarnt hat und wo nicht. Ältere Zwischenspeicher werden ergänzt, nicht neu geladen.
* **Für Profis:** In der Startplatz-Ansicht stehen oben nur Wind, Böen, Wolkenbasis und Regen. Gegenwind, CAPE, Thermik, Landewind, Scherung, Modellunterschied und das Windprofil liegen eingeklappt unter «Für Profis». AFC merkt sich, ob du es offen hast.
* **Landevolte:** Beim Landeplatz eine Skizze der Volte (Gegenanflug, Queranflug, Endanflug) mit Windpfeil. Ohne eigene Angabe schlägt AFC einen Endanflug gegen den Wind vor. Unter «Volte eintragen» legst du Richtung und Seite fest (gespeichert im Flugbuch, `settings.lands`). Kommt der Wind von hinten auf deinen Endanflug, warnt AFC.
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

## Öffentlich für Freunde (Tailscale Funnel)

`tools/AFC öffentlich machen.command` doppelklicken (`tailscale funnel --bg 8787`): AFC ist dann unter derselben Adresse `https://<mac>.<tailnet>.ts.net` aus dem ganzen Internet erreichbar, Freunde brauchen kein Tailscale, nur einen Einladungslink. Gratis, die Daten bleiben auf dem Mac, Updates kommen wie bisher über den Hinweis in der App. Das Skript macht nur weiter, wenn es schon ein Konto gibt. Anfragen über Funnel (Kopfzeile `Tailscale-Funnel-Request`) zählen nie als «dieser Rechner»: kein Update-Knopf, kein Einrichten des ersten Kontos, und ohne Konten sind alle `/api`-Aufrufe gesperrt. Zurück zu «nur meine Geräte»: `tools/AFC öffentlich beenden.command`. Der Mac muss wach sein.

## Testphase: Konten, Profil, Rückmeldungen
- Ohne Konto läuft AFC wie bisher. Das erste Konto (Profil › «Mein Konto einrichten») wird Admin und übernimmt Flugbuch, Wächter, Benachrichtigungen und Einstellungen. Vorher legt AFC eine Kopie der Datenbank an (`data/afc-vor-konten-*.sqlite`, `data/backups/afc-vor-erstem-konto-*.sqlite`).
- Danach braucht jede Anfrage eine Anmeldung (Cookie 90 Tage, Passwort mit scrypt). Neue Piloten nur über einen Einladungslink (Profil › Testphase › «Freund einladen», gilt 30 Tage, einmal). Passwort vergessen: Admin erstellt in der Übersicht einen «Passwort-Link» (3 Tage).
- Jeder Pilot hat sein eigenes Flugbuch, Ausrüstung, Wächter, Push-Abos, Favoriten, Erfahrungsstufe und Pilotenprofil (Ausbildung, Schirm, Flächenbelastung, Flugstil, Hausgebiete, eigene Wind- und Böengrenzen, Notfallkontakt, Profilbild). Rückmeldungen nach Flügen aller Piloten fliessen gemeinsam in die Bewertung.
- Werkzeuge: Sprechblase oben (Idee, Fehler, Prognose, Lob, mit Bildschirmfoto), «Heute nicht gestartet» (Flugtag und Startplatz), automatische JS-Fehlerberichte, Admin-Übersicht (Piloten, Meldungen, Einladungen, Fehler), Abschluss-Umfrage zum Einschalten.
- Konto: Daten herunterladen, Passwort ändern, Abmelden, Konto löschen. Datenschutz unter /privacy.
- Teilen mit Freunden: den Mac in Tailscale mit ihnen teilen (Machines › Share), sie öffnen dann `https://<mac>.<tailnet>.ts.net`.

## Zuverlässigkeit

* **Mac wach halten:** Läuft AFC als Autostart auf dem Mac, verhindert es von 6 bis 22 Uhr, dass der Mac von selbst einschläft (`caffeinate -i`, der Bildschirm darf dunkel werden). Zugeklappt schläft ein MacBook trotzdem. `tools/AFC wach halten einrichten.command` weckt den Mac zusätzlich jeden Morgen um 06:40 (`pmset repeat`, fragt einmal nach dem Passwort). Abschalten: `AFC wach halten beenden.command` bzw. `AFC_STAY_AWAKE=0`. Stand unter Profil > AFC und Updates.
* **Selbstüberwachung:** Zwischen 6 und 22 Uhr prüft AFC alle 10 Minuten: Prognose älter als 4 Stunden, Messwerte älter als 3 Stunden, Flugbuch-Sicherung fehlgeschlagen, Speicher nicht beschreibbar, Open-Meteo-Kontingent über 90 %. Probleme stehen unter Profil und kommen als Benachrichtigung (einmal pro Tag und Art, dazu «läuft wieder normal», abschaltbar). Die ersten 30 Minuten nach dem Start wird nicht geprüft (`AFC_HEALTH_GRACE_MIN`).

## Selbstlernen mit Selbstprüfung

Seit Version 10.0 (November 2026):

* **Aus Messwerten, ohne Flüge** (`lib/learn.js` `stationLearn`): Für jede Station hält AFC die Prognose der nächsten 1–6 Stunden fest (pro Stunde die mit rund 3 h Vorlauf, Tabelle `fc_pred`) und vergleicht sie mit der Messung. Gelernt wird der Böenfehler der letzten 30 Tage (jüngere Tage zählen mehr, Halbwertszeit 7 Tage) insgesamt und je Tageszeit (Vormittag, Mittag, Nachmittag) und Windrichtung (8 Sektoren oder wenig Wind). Für jeden Tag wird aus den übrigen Tagen gelernt und geprüft, ob die Korrektur ihn besser getroffen hätte; nur dann gilt sie (`mode`: bucket, overall, none). An Startplätzen bis 20 km von einer Bergstation werden Böen um 60 % davon angehoben (höchstens 10 km/h) oder halb so stark gesenkt (höchstens 4 km/h, nie wenn die Station jetzt mehr misst).
* **Selbstprüfung in Stufen:** Der wöchentliche Rückblick-Test läuft dreimal: ohne Lernen, nur das Einfache (`--lernen-einfach`: Stationsmittel, nur anheben) und alles. Behalten wird die beste Stufe, die nicht gefährlicher ist als ohne Lernen (`data/learn-guard.json`, `mode` full, simple, off).
* **Runde 2 (10.1):** Gelernt wird jetzt auch:
  * **Föhn- und Bisedruck** (`pressureLearn`, Tabellen `reg_fc`, `reg_obs`, 90 Tage): Abweichung des prognostizierten Druckunterschieds Lugano–Kloten bzw. Kloten–Genf von der Messung, geprüft Tag für Tag, höchstens ±2 hPa (Verkleinern nur halb). Kam Föhn oder Bise an mindestens 2 Tagen unter der Warngrenze, wird die Warngrenze gesenkt (nie unter die Hälfte, nie automatisch angehoben).
  * **Wettermodell** (`modelLearn`, Tabelle `model_fc`): Trifft ECMWF die Böen an der Gebietsstation klar besser als ICON (mind. 10 %, 40 Stunden, 4 Tage), zählt ECMWF bis zur Hälfte mit.
  * **Talwind an der Landung:** Talstationen (unter 1100 m, bis 15 km) korrigieren Wind und Böen an der Landung; mehr Wind voll, weniger nur halb und höchstens 3 km/h.
  * **Grundwind am Start:** Bergstationen lernen auch den mittleren Wind. Zählt nur, wenn er die Bewertung verschlechtert.
  * Der wöchentliche Rückblick-Test nutzt zusätzlich die eigenen gespeicherten Prognosen aus `afc.sqlite`. In der Stufe «einfach» gelten Druck und Modell nicht.
* **Nachlernen aus den letzten 90 Tagen** (10.2, `lib/backfill.js`): Nach dem Start und danach alle 3 Tage holt AFC die stündlichen Messungen der MeteoSchweiz (`…_h_recent.csv`, 12 Stationen) und die Druckprognose Lugano/Kloten/Genf aus dem Prognose-Archiv von Open-Meteo (rund 25 Aufrufe) und füllt damit `reg_obs` und `reg_fc`, wo AFC selber noch nichts gesammelt hat. So kennt das Föhn- und Bise-Lernen sofort die vergangenen Föhn- und Bisetage (Anzeige unter Profil > Technik). `AFC_BACKFILL=0` schaltet es ab.
* **Aus Rückmeldungen je Startplatz:** Urteile nach Flügen zählen voll, Flüge ohne Urteil halb (unter 55 trotzdem gut geflogen = zu streng, ab 70 ordentlich = lag richtig), «nicht gestartet» wegen Wind, Thermik, Föhn, Wolken oder Regen bei 70 und mehr als «zu mild». Halbwertszeit ein Jahr, getrennt nach Stufe.
* **Steigen aus IGC-Flügen:** `site_fc` speichert auch das prognostizierte Steigen (w*). Je Gebiet ab 3 Flügen ein Faktor (0.75–1.3) aufs Steigen, nur wenn er die übrigen Flüge besser erklärt hätte.
* Anzeige unter Profil > Technik und Daten: Böenfehler je Station vorher und nachher, Startplätze mit Anpassung, Thermik und Steigen je Gebiet, die drei Testläufe.

Früher:

* **Böen an Bergstationen** (seit 04672d6): Der wöchentliche Rückblick-Test läuft jetzt zweimal, ohne und mit dem Gelernten (`--vergleich --ohne-lernen`, dann `--auto`). Gibt es mit dem Gelernten mehr gefährliche Fälle oder klar mehr «zu mild» am Berg, pausiert AFC das Gelernte bis zur nächsten Prüfung (`data/learn-guard.json`, `lib/learn.js`). Anzeige unter Profil > Technik und Daten.
* **Thermik aus deinen IGC-Flügen:** AFC hält jede Stunde die Prognose je Startplatz fest (Thermik-Obergrenze, höchstens 3 h voraus, Tabelle `site_fc`). Ein IGC-Flug mit Thermiken wird mit der Prognose zur Flugzeit verglichen. Je Gebiet ab 3 Flügen gibt es eine Korrektur der Thermik-Obergrenze (nach oben 60 % des Medians, höchstens +500 m; nach unten 30 %, höchstens −300 m), aber nur, wenn sie jeden bisherigen Flug ohne diesen Flug besser erklärt hätte als keine Korrektur. Steht als Grund bei der Bewertung und unter Profil > «Aus deinen Flügen gelernt». Sicherheitsgrenzen ändert das nie.
* **Rückmeldungen nach dem Flug:** siehe Flugbuch.

## Flugtag-Wächter

In der Startplatz-Ansicht (Tag «Heute»): «Heute fliege ich hier». Von 7 bis 20 Uhr prüft AFC dann alle 10 Minuten den Platz (`lib/watch.js`) und schickt sofort eine Benachrichtigung, wenn an der nächsten Station Böen über etwa der eigenen Grenze gemessen werden (Stufe: Böen-K.-o. minus 4 km/h) oder die Bewertung jetzt bzw. in den nächsten 2 Stunden unter 55 fällt oder ein K.-o. auftaucht (mit Grund), und eine Entwarnung, wenn es sich beruhigt. Gleiche Art höchstens einmal pro Stunde. Bis zu 3 Plätze, gilt nur für den Tag. Oben im «Entscheid» steht, welche Plätze bewacht werden.

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

* **Railway (empfohlen, so läuft AFC im Internet)**: Neues Projekt › «Deploy from GitHub repo» › `lars673/AFC`, Branch `feature/autostart-terrain-score`. `railway.json` und das `Dockerfile` regeln den Rest (Healthcheck, Neustart immer, Zeitzone Zürich, `AFC_HOSTED=1`, `AFC_SERVER=1`, Rückblick-Test automatisch, keine Git-Update-Prüfung). Von Hand: Volume auf `/app/data`, Public Domain, unter Settings «Wait for CI» einschalten (dann kommt jede Version erst nach bestandenen GitHub-Tests online). Jeder Push auf den Branch wird so automatisch eingespielt.
* **Ganze Sicherung (alle Konten)**: Profil › Testphase › Übersicht › «Sicherung». «Jetzt herunterladen» liefert ein tar.gz im Umzugs-Format (Datenbank als saubere Kopie, `vapid.json`, Lern-Dateien) über `GET /api/admin/backup`. Für jede Nacht auf den Mac: dort einen Schlüssel erstellen und `tools/AFC Sicherung auf den Mac.command` doppelklicken (launchd `ch.afc.sicherung`, 3:30 Uhr, holt `GET /api/sicherung` mit Kopfzeile `X-AFC-Sicherung`, legt die letzten 30 in iCloud Drive › AFC-Sicherung › Server ab). Zurückspielen: Archiv wie beim Umzug an `PUT /api/umzug` schicken (mit `X-AFC-Umzug-Ersetzen: ja`).
* **Umzug vom Mac**: In Railway die Variable `AFC_UMZUG_CODE` (mindestens 12 Zeichen) setzen, auf dem Mac `tools/AFC Umzug ins Internet.command` doppelklicken. Es schickt eine saubere Kopie der Datenbank (`sqlite3 .backup`), `vapid.json` und das Gelernte als tar.gz an `PUT /api/umzug` (Kopfzeile `X-AFC-Umzug`). Der Server legt es als `umzug.tgz` ab, startet neu und packt es vor dem Öffnen der Datenbank aus (`lib/umzug.js`, alte Datenbank und Archiv landen in `backups/`). Gibt es schon Konten, braucht es `X-AFC-Umzug-Ersetzen: ja`. Push-Abos werden dabei gelöscht, weil sie zur alten Adresse gehören. Ohne gesetzten Code ist der Umzug aus. Solange der Code gesetzt ist, lässt sich auf dem Server kein erstes Konto anlegen. Danach die Variable wieder löschen.
* **Render**: `render.yaml` (Disk auf `/app/data`).

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
| `AFC_HOSTED` | – | `1` = läuft im Internet (setzt das Dockerfile): die App sagt, dass Updates automatisch kommen |
| `AFC_UMZUG_CODE` | – | Erlaubt einmalig den Umzug vom Mac (`PUT /api/umzug`), mindestens 12 Zeichen |

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
| `GET`/`POST /api/watch` | Flugtag-Wächter: bewachte Startplätze heute, an- und abschalten |
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
* Die Auflage «Hangneigung» und die Hindernisdaten sind Orientierungshilfen. Tiefe Kabel (Heuseile, viele Materialseilbahnen) sind beim BAZL nicht erfasst.

## Austausch unter den Piloten (10.2)

Reiter «Gruppe» (`lib/community.js`, `/api/community`, Tabellen `posts` und `post_likes`, nur mit Konto):
* **Heute an den Startplätzen:** aus den Flugbüchern aller Piloten und «nicht gestartet»: Anzahl Flüge, Sterne, weiteste Strecke, längster Flug, Urteile über die AFC-Bewertung, Gründe fürs Nicht-Starten, daneben der AFC-Score. Namen nur von Piloten, die «Meinen Namen bei meinen Flügen zeigen» eingeschaltet haben. Auch für gestern.
* **Beiträge:** Bericht vom Flug, Ich gehe fliegen (mit Tag, bis 7 Tage voraus, oben unter «Wer geht fliegen?» mit «Bin dabei»), Frage oder Tipp, Achtung. Antworten, Daumen hoch, eigene löschen (der Admin alle). Sichtbar 14 Tage.
* In der Startplatz-Ansicht steht «Heute in der Gruppe: …», und am Reiter erscheint ein Punkt bei neuen Beiträgen. Das Profil öffnet sich oben rechts über das eigene Bild.

## Ideen aus Burnair und der SHV-App (10.3)

* **Prognose-Sicherheit je Tag** (`lib/plan.js` `dayConfidence`): aus dem Vorlauf und wie stark ICON und ECMWF bei Wind, Regen und Bewölkung (9–17 Uhr, alle Gebiete) auseinanderliegen. «gut», «mittel» (eher unsicher) oder «unsicher» mit Gründen, im Entscheid unter der Schlagzeile, in der Tagesleiste und im Wochenblick. Ändert den Score nicht. ECMWF wird dafür zusätzlich mit Niederschlag und Bewölkung geholt (gleiche Anzahl Open-Meteo-Aufrufe).
* **Lee-Karte:** Karte > Wind-Leiste > Ebenen > «Lee» (violett). Thermik, Soaring und Lee lassen sich seit 10.4 einzeln und zusammen einblenden. Hinter einer Krete, die gegen den Wind bis 6 km entfernt deutlich höher liegt (ab 120 m, Lee reicht etwa 8-mal ihre Höhe), ab 12 km/h Wind auf Kretenhöhe. Antippen erklärt warum. Wie alle Ebenen von Haus aus aus.
* **Live-Wind der Stationen:** Pfeile zeigen jetzt «Wind/Böen», Farbe nach den Böen (ab 25 orange, ab 35 rot), blass bei Messungen über 40 Minuten. Ebene «Messstationen» lässt sich ausschalten.
