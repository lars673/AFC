#!/bin/bash
# Beendet den AFC-Hintergrunddienst und entfernt den Autostart. Die Daten in data/ bleiben erhalten.
LABEL="ch.afc.server"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Autostart entfernt. Manuell starten: im AFC-Ordner 'npm start'."
read -r -p "Enter zum Schliessen"
