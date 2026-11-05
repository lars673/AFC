#!/bin/bash
# Macht AFC öffentlich im Internet erreichbar, über Tailscale Funnel (gratis):
# Freunde brauchen nichts zu installieren, nur die Adresse und ihre Einladung. Die Adresse bleibt dieselbe wie auf deinem Handy.
# Schutz: Ohne Anmeldung sieht niemand etwas. Der Update-Knopf und das Einrichten des ersten Kontos gehen nie über den öffentlichen Zugang.
# Einmal doppelklicken. Erneut ausführen ist unbedenklich; die Freigabe bleibt auch nach einem Neustart bestehen.
# Zurück zu «nur meine Geräte»: «AFC öffentlich beenden» doppelklicken.
set -uo pipefail
PORT="${PORT:-8787}"

TS="$(command -v tailscale || true)"
for c in /Applications/Tailscale.app/Contents/MacOS/Tailscale /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do [ -z "$TS" ] && [ -x "$c" ] && TS="$c"; done
if [ -z "$TS" ]; then
  echo "Tailscale ist auf diesem Mac nicht installiert. Bitte zuerst «AFC aufs Handy» einrichten."
  read -r -p "Enter zum Schliessen"; exit 1
fi
if ! "$TS" status >/dev/null 2>&1; then
  echo "Tailscale ist nicht verbunden. Oben in der Menüleiste auf das Tailscale-Symbol klicken und «Connect» wählen."
  read -r -p "Danach Enter drücken …"
fi

# Läuft AFC, und gibt es schon Konten? Ohne Konto wäre das Flugbuch offen: dann nicht öffentlich machen.
STATE="$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/auth/state" 2>/dev/null || true)"
if [ -z "$STATE" ]; then
  echo "AFC antwortet auf diesem Mac nicht (Port $PORT). Bitte zuerst «AFC Autostart einrichten» doppelklicken."
  read -r -p "Enter zum Schliessen"; exit 1
fi
if ! printf '%s' "$STATE" | grep -q '"auth":true'; then
  echo "In AFC gibt es noch kein Konto. Bitte zuerst in der App unter Profil › «Mein Konto einrichten» dein Konto anlegen,"
  echo "dann dieses Programm nochmals doppelklicken."
  read -r -p "Enter zum Schliessen"; exit 1
fi

echo "Mache AFC öffentlich erreichbar …"
echo "(Falls unten ein Link erscheint: ihn öffnen, in Tailscale «Funnel» erlauben, dann kommt es hier von selbst weiter.)"
echo
if ! "$TS" funnel --bg "$PORT"; then
  echo
  echo "Das hat nicht geklappt. Meist fehlt in Tailscale noch die Erlaubnis für Funnel:"
  echo "Oben steht dann ein Link. Ihn öffnen, bestätigen und dieses Programm nochmals doppelklicken."
  read -r -p "Enter zum Schliessen"; exit 1
fi

NAME="$("$TS" status --json 2>/dev/null | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
echo
echo "Fertig. AFC ist jetzt öffentlich unter:"
if [ -n "$NAME" ]; then echo "   https://$NAME"; else "$TS" funnel status; fi
echo
echo "So kommen deine Freunde rein: In AFC unter Profil › Testphase › «Freund einladen» einen Link erstellen und schicken."
echo "Sie brauchen kein Tailscale. Der erste Aufruf kann bis zu einer Minute dauern, bis die Adresse überall bekannt ist."
echo
echo "Wichtig: Der Mac muss eingeschaltet und wach sein. Updates kommen wie bisher über den Hinweis oben in der App."
read -r -p "Enter zum Schliessen"
