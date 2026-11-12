#!/bin/bash
# Zieht AFC vom Mac auf den Server im Internet um (Railway): Konten, Flugbücher, Profile, Rückmeldungen,
# Gelerntes und die Push-Schlüssel. Auf dem Mac wird nichts gelöscht.
# Vorher in Railway die Variable AFC_UMZUG_CODE setzen (siehe Anleitung). Einmal doppelklicken.
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$DIR/data"
echo "AFC-Umzug ins Internet"
echo "======================"
echo
if [ ! -f "$DATA/afc.sqlite" ]; then echo "Keine AFC-Daten gefunden ($DATA/afc.sqlite)."; read -r -p "Enter zum Schliessen"; exit 1; fi

read -r -p "1. Adresse deines AFC im Internet (z. B. https://afc-production.up.railway.app): " URL
URL="$(printf '%s' "$URL" | tr -d '[:space:]')"; URL="${URL%/}"
case "$URL" in http*://*) ;; *) URL="https://$URL" ;; esac
read -r -p "2. Umzugs-Code (gleich wie AFC_UMZUG_CODE in Railway): " CODE
CODE="$(printf '%s' "$CODE" | tr -d '[:space:]')"
echo
if ! curl -fsS --max-time 20 "$URL/healthz" >/dev/null 2>&1; then
  echo "Unter $URL antwortet kein AFC. Bitte die Adresse prüfen (in Railway unter Settings › Networking)."
  read -r -p "Enter zum Schliessen"; exit 1
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/data"
echo "Packe die Daten ein …"
# Datenbank als saubere Kopie, auch wenn AFC gerade läuft
if ! /usr/bin/sqlite3 "$DATA/afc.sqlite" ".backup '$TMP/data/afc.sqlite'"; then
  echo "Die Datenbank liess sich nicht kopieren."; read -r -p "Enter zum Schliessen"; exit 1
fi
# Der Rest: Push-Schlüssel, Gelerntes, letzte Prognose. Ohne grosse Zwischenspeicher, Sicherungen und Protokoll.
rsync -a \
  --exclude 'afc.sqlite*' --exclude 'afc-vor-*' --exclude 'backups' --exclude 'tmp-*' --exclude 'server.log' \
  --exclude '.DS_Store' --exclude 'backtest-cache-*' --exclude 'luftfahrthindernis.kmz' --exclude 'airspace' \
  "$DATA/" "$TMP/data/"
( cd "$TMP" && COPYFILE_DISABLE=1 tar -czf umzug.tgz data )
echo "Grösse: $(du -h "$TMP/umzug.tgz" | cut -f1)"

send() {
  curl -sS --max-time 600 -o "$TMP/antwort.txt" -w '%{http_code}' -X PUT \
    -H "X-AFC-Umzug: $CODE" -H "X-AFC-Umzug-Ersetzen: $1" -H 'Content-Type: application/gzip' \
    --data-binary "@$TMP/umzug.tgz" "$URL/api/umzug"
}
echo "Schicke sie an $URL …"
CODEHTTP="$(send nein)"
if [ "$CODEHTTP" = "409" ]; then
  echo
  echo "Auf dem Server gibt es schon Konten (vielleicht von einem früheren Umzug)."
  read -r -p "Alles dort durch den Stand von diesem Mac ersetzen? (j/n) " J
  if [ "$J" = "j" ] || [ "$J" = "J" ]; then CODEHTTP="$(send ja)"; else echo "Abgebrochen, nichts geändert."; read -r -p "Enter zum Schliessen"; exit 0; fi
fi
if [ "$CODEHTTP" != "200" ]; then
  echo
  echo "Das hat nicht geklappt (Fehler $CODEHTTP): $(cat "$TMP/antwort.txt" 2>/dev/null)"
  echo "Bei Fehler 403: Den Umzugs-Code in Railway (Variables › AFC_UMZUG_CODE) und hier genau gleich eingeben."
  read -r -p "Enter zum Schliessen"; exit 1
fi

echo
echo "Angekommen. Der Server startet jetzt mit deinen Daten neu (etwa 1 Minute)."
for i in $(seq 1 40); do sleep 3; if curl -fsS --max-time 5 "$URL/api/auth/state" 2>/dev/null | grep -q '"auth":true'; then OK=1; break; fi; done
if [ "${OK:-}" = "1" ]; then echo "Fertig: AFC läuft im Internet mit deinen Daten. Melde dich unter $URL mit deinem Konto an."
else echo "Der Server braucht noch etwas. Öffne in ein paar Minuten $URL und melde dich an."; fi
echo
echo "Wichtig: Push-Mitteilungen gehörten zur alten Adresse. Bitte in der App (neue Adresse) unter Profil › Benachrichtigungen neu einschalten."
echo
read -r -p "AFC auf diesem Mac jetzt ausschalten, damit nicht zwei AFC gleichzeitig laufen? (j/n) " J
if [ "$J" = "j" ] || [ "$J" = "J" ]; then
  launchctl bootout "gui/$(id -u)/ch.afc.server" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/ch.afc.server.plist"
  TS="$(command -v tailscale || true)"
  for c in /Applications/Tailscale.app/Contents/MacOS/Tailscale /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do [ -z "$TS" ] && [ -x "$c" ] && TS="$c"; done
  [ -n "$TS" ] && "$TS" funnel reset >/dev/null 2>&1 || true
  echo "AFC auf dem Mac ist aus. Die Daten bleiben im Ordner data. Zurück: «AFC Autostart einrichten» doppelklicken."
fi
read -r -p "Enter zum Schliessen"
