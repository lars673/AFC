#!/bin/bash
# Richtet den AFC-Server als Hintergrunddienst ein (macOS launchd):
# startet beim Anmelden, läuft ohne Terminal weiter und startet nach einem Absturz neu.
# Einmal doppelklicken. Erneut ausführen ist unbedenklich (z.B. nach Verschieben des Ordners).
set -euo pipefail
LABEL="ch.afc.server"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-8787}"

NODE="$(command -v node || true)"
for c in /opt/homebrew/bin/node /usr/local/bin/node; do [ -z "$NODE" ] && [ -x "$c" ] && NODE="$c"; done
if [ -z "$NODE" ]; then echo "Node.js nicht gefunden. Bitte zuerst Node 22.13 oder neuer installieren (https://nodejs.org)."; read -r -p "Enter zum Schliessen"; exit 1; fi
echo "Node:   $NODE ($("$NODE" --version))"
echo "Ordner: $APP_DIR"

mkdir -p "$APP_DIR/data" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>server.js</string></array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>PORT</key><string>$PORT</string>
    <key>HOST</key><string>127.0.0.1</string>
    <key>AFC_TRUSTED_PROXY_HOPS</key><string>0</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$APP_DIR/data/server.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/data/server.log</string>
</dict>
</plist>
PL

# Läuft der Server noch in einem Terminal, belegt er den Port.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -v launchd | grep -q node && ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "Achtung: Auf Port $PORT läuft schon ein Server (wohl in einem Terminal). Dort mit Ctrl+C beenden, dann dieses Skript nochmals starten."
  read -r -p "Enter zum Schliessen"; exit 1
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo -n "Starte Server "
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo; echo "✅ AFC läuft im Hintergrund: http://localhost:$PORT"
    echo "   Startet ab jetzt automatisch beim Anmelden. Protokoll: data/server.log"
    read -r -p "Enter zum Schliessen"; exit 0
  fi
  echo -n "."; sleep 1
done
echo; echo "❌ Der Server antwortet nicht. Letzte Zeilen aus data/server.log:"
tail -n 15 "$APP_DIR/data/server.log" 2>/dev/null || true
if grep -q "EPERM\|Operation not permitted" "$APP_DIR/data/server.log" 2>/dev/null; then
  echo; echo "macOS erlaubt dem Hintergrunddienst keinen Zugriff auf diesen Ordner (Schreibtisch/Dokumente)."
  echo "Lösung: Systemeinstellungen > Datenschutz & Sicherheit > Festplattenvollzugriff > '+' > $NODE hinzufügen,"
  echo "oder den AFC-Ordner z.B. nach ~/AFC verschieben und dieses Skript dort erneut starten."
fi
read -r -p "Enter zum Schliessen"; exit 1
