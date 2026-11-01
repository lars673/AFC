#!/bin/bash
# Macht AFC auf dem Handy erreichbar, über Tailscale (gratis, privat):
# nur deine eigenen Geräte im Tailscale-Konto kommen an AFC heran, mit HTTPS. Nichts ist öffentlich im Internet.
# Voraussetzung: Tailscale-App auf dem Mac und auf dem Handy, beide mit demselben Konto angemeldet.
# Einmal doppelklicken. Erneut ausführen ist unbedenklich; die Freigabe bleibt auch nach einem Neustart bestehen.
set -uo pipefail
PORT="${PORT:-8787}"

TS="$(command -v tailscale || true)"
for c in /Applications/Tailscale.app/Contents/MacOS/Tailscale /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do [ -z "$TS" ] && [ -x "$c" ] && TS="$c"; done
if [ -z "$TS" ]; then
  echo "Tailscale ist auf diesem Mac nicht installiert."
  echo "1. Im App Store «Tailscale» laden und öffnen, mit Apple, Google oder Microsoft anmelden."
  echo "2. Danach dieses Programm nochmals doppelklicken."
  read -r -p "Enter zum Schliessen"; exit 1
fi

if ! "$TS" status >/dev/null 2>&1; then
  echo "Tailscale läuft, ist aber nicht verbunden. Bitte oben in der Menüleiste auf das Tailscale-Symbol klicken und «Connect» bzw. «Anmelden» wählen."
  read -r -p "Danach Enter drücken …"
fi

# Läuft AFC?
if ! curl -fsS --max-time 5 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "AFC antwortet auf diesem Mac nicht (Port $PORT). Bitte zuerst «AFC Autostart einrichten» doppelklicken."
  read -r -p "Enter zum Schliessen"; exit 1
fi

echo "Gebe AFC für deine Geräte frei …"
if ! "$TS" serve --bg "$PORT"; then
  echo
  echo "Die Freigabe hat nicht geklappt. Meist fehlt in Tailscale noch die HTTPS-Einstellung:"
  echo "Oben steht dann ein Link. Ihn öffnen, «Enable HTTPS» bestätigen und dieses Programm nochmals doppelklicken."
  read -r -p "Enter zum Schliessen"; exit 1
fi

NAME="$("$TS" status --json 2>/dev/null | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)"
echo
echo "Fertig. AFC auf dem Handy:"
if [ -n "$NAME" ]; then echo "   https://$NAME"; else "$TS" serve status; fi
echo
echo "Auf dem iPhone: Tailscale-App öffnen (verbunden), dann die Adresse in Safari öffnen,"
echo "Teilen-Knopf → «Zum Home-Bildschirm». Ab dann startet AFC wie eine App."
echo
echo "Wichtig: Der Mac muss eingeschaltet und wach sein. Schläft er, zeigt AFC auf dem Handy den letzten Stand mit Warnung."
read -r -p "Enter zum Schliessen"
