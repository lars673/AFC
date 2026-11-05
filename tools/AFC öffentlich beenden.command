#!/bin/bash
# Nimmt AFC wieder aus dem Internet. Danach kommen nur noch deine eigenen Tailscale-Geräte an AFC heran (wie bei «AFC aufs Handy»).
set -uo pipefail
PORT="${PORT:-8787}"
TS="$(command -v tailscale || true)"
for c in /Applications/Tailscale.app/Contents/MacOS/Tailscale /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do [ -z "$TS" ] && [ -x "$c" ] && TS="$c"; done
if [ -z "$TS" ]; then echo "Tailscale ist nicht installiert, AFC ist also auch nicht öffentlich."; read -r -p "Enter zum Schliessen"; exit 0; fi
"$TS" funnel reset >/dev/null 2>&1 || true
if "$TS" serve --bg "$PORT" >/dev/null 2>&1; then
  echo "Erledigt. AFC ist nicht mehr öffentlich. Auf deinen eigenen Geräten (Handy mit Tailscale) läuft es weiter wie bisher."
else
  echo "AFC ist nicht mehr öffentlich. Den Handy-Zugang bitte mit «AFC aufs Handy» wieder einschalten."
fi
read -r -p "Enter zum Schliessen"
