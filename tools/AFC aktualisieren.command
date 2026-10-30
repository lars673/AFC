#!/bin/bash
# Holt die neueste Version von GitHub und startet den Hintergrunddienst neu. Doppelklicken genügt.
LABEL="ch.afc.server"; PORT="${PORT:-8787}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR" || exit 1
echo "Hole Updates in $APP_DIR …"
if ! git pull --ff-only; then
  echo "❌ Update fehlgeschlagen (siehe oben). Lokale Änderungen? Dann 'git status' prüfen."
  read -r -p "Enter zum Schliessen"; exit 1
fi
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
  echo -n "Starte Server neu "
  for i in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then echo; echo "✅ Aktuell. In der App einmal neu laden (Cmd+R)."; sleep 3; exit 0; fi
    echo -n "."; sleep 1
  done
  echo; echo "❌ Server antwortet nicht. Letzte Zeilen aus data/server.log:"; tail -n 15 data/server.log 2>/dev/null
else
  echo "Autostart ist nicht eingerichtet. Bitte 'AFC Autostart einrichten.command' doppelklicken."
fi
read -r -p "Enter zum Schliessen"
