#!/bin/bash
# Beendet die Freigabe von AFC über Tailscale. AFC läuft auf dem Mac normal weiter.
TS="$(command -v tailscale || true)"
for c in /Applications/Tailscale.app/Contents/MacOS/Tailscale /opt/homebrew/bin/tailscale /usr/local/bin/tailscale; do [ -z "$TS" ] && [ -x "$c" ] && TS="$c"; done
if [ -z "$TS" ]; then echo "Tailscale ist nicht installiert, es gibt nichts zu beenden."; read -r -p "Enter zum Schliessen"; exit 0; fi
"$TS" serve reset && echo "Handy-Zugang beendet."
read -r -p "Enter zum Schliessen"
