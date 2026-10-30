#!/bin/bash
# Startet den AFC-Hintergrunddienst neu, z.B. nach Änderungen an server.js oder lib/.
LABEL="ch.afc.server"; PORT="${PORT:-8787}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "Autostart ist nicht eingerichtet. Bitte zuerst 'AFC Autostart einrichten.command' doppelklicken."
  read -r -p "Enter zum Schliessen"; exit 1
fi
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo -n "Starte neu "
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then echo; echo "✅ AFC läuft wieder. In der App einmal neu laden (Cmd+R)."; sleep 2; exit 0; fi
  echo -n "."; sleep 1
done
echo; echo "❌ Keine Antwort. Letzte Zeilen aus data/server.log:"; tail -n 15 "$APP_DIR/data/server.log" 2>/dev/null
read -r -p "Enter zum Schliessen"
