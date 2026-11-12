#!/bin/bash
# Holt jede Nacht eine ganze Sicherung von AFC im Internet (alle Konten, Flugbücher, Gruppe, Gelerntes) auf diesen Mac.
# Die Kopien landen in iCloud Drive › AFC-Sicherung › Server (sonst ~/AFC-Sicherung/Server), die letzten 30 bleiben.
# Zurückspielen: genau wie der Umzug (die Datei ist ein Umzugs-Archiv).
echo "AFC-Sicherung auf den Mac einrichten"
echo
echo "In AFC: Profil › Testphase › Übersicht öffnen › Sicherung › «Mac jede Nacht sichern lassen»."
echo "Dort «Kopieren» drücken."
echo
# Adresse und Schlüssel aus einem Text holen, egal wie er eingefügt wurde (eine oder zwei Zeilen, mit oder ohne Beschriftung)
grab() {
  local t="$1"
  [ -z "$URL" ] && URL="$(printf '%s' "$t" | grep -oE 'https?://[A-Za-z0-9.:/_-]+' | head -n 1)"
  [ -z "$KEY" ] && KEY="$(printf '%s' "$t" | sed -E 's#https?://[A-Za-z0-9.:/_-]+##g' | grep -oE '[A-Za-z0-9_-]{30,}' | head -n 1)"
}
URL=""; KEY=""
# Zuerst die Zwischenablage: wer in AFC «Kopieren» gedrückt hat, muss nichts einfügen
grab "$(pbpaste 2>/dev/null)"
if [ -n "$URL" ] && [ -n "$KEY" ]; then
  echo "Adresse und Schlüssel aus der Zwischenablage übernommen: $URL"
else
  URL=""; KEY=""
  echo "Bitte den kopierten Text hier einfügen (Cmd+V) und Enter drücken:"
  for i in 1 2 3; do
    read -r LINE
    grab "$LINE"
    [ -n "$URL" ] && [ -n "$KEY" ] && break
    if [ -z "$URL" ]; then echo "Jetzt noch die Adresse (beginnt mit https://):"; else echo "Jetzt noch den Schlüssel (die lange Zeichenfolge):"; fi
  done
fi
URL="${URL%/}"
if [ -z "$URL" ]; then echo "Die Adresse fehlt. Bitte in AFC nochmals «Kopieren» drücken und neu starten."; read -r -p "Enter zum Schliessen"; exit 1; fi
if [ -z "$KEY" ]; then echo "Der Schlüssel fehlt. Bitte in AFC «Neuer Schlüssel für den Mac» tippen, «Kopieren» drücken und neu starten."; read -r -p "Enter zum Schliessen"; exit 1; fi

ICLOUD="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
if [ -d "$ICLOUD" ]; then DEST="$ICLOUD/AFC-Sicherung/Server"; else DEST="$HOME/AFC-Sicherung/Server"; fi
HOME_DIR="$HOME/Library/Application Support/AFC-Sicherung"
mkdir -p "$DEST" "$HOME_DIR"

SCRIPT="$HOME_DIR/holen.sh"
cat > "$SCRIPT" <<SH
#!/bin/bash
# Von «AFC Sicherung auf den Mac.command» angelegt
DEST="$DEST"
TMP="\$(mktemp)"
CODE=\$(curl -sS --max-time 900 -o "\$TMP" -w '%{http_code}' -H "X-AFC-Sicherung: $KEY" "$URL/api/sicherung")
if [ "\$CODE" = "200" ] && [ "\$(head -c 2 "\$TMP" | xxd -p)" = "1f8b" ]; then
  mv "\$TMP" "\$DEST/afc-sicherung-\$(date +%Y-%m-%d).tgz"
  ls -1t "\$DEST"/afc-sicherung-*.tgz 2>/dev/null | tail -n +31 | while read -r f; do rm -f "\$f"; done
  echo "\$(date '+%d.%m.%Y %H:%M') ok" >> "$HOME_DIR/protokoll.txt"
else
  echo "\$(date '+%d.%m.%Y %H:%M') Fehler \$CODE: \$(head -c 200 "\$TMP")" >> "$HOME_DIR/protokoll.txt"
  rm -f "\$TMP"
fi
SH
chmod 700 "$SCRIPT"

PLIST="$HOME/Library/LaunchAgents/ch.afc.sicherung.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ch.afc.sicherung</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$SCRIPT</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>30</integer></dict>
  <key>RunAtLoad</key><true/>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null
launchctl load "$PLIST"

echo
echo "Hole die erste Sicherung …"
bash "$SCRIPT"
LAST="$(tail -n 1 "$HOME_DIR/protokoll.txt" 2>/dev/null)"
case "$LAST" in
  *ok) echo "Fertig. Die erste Sicherung liegt in: $DEST"
       echo "Ab jetzt holt der Mac jede Nacht um 3:30 eine neue (oder beim nächsten Aufwachen).";;
  *)   echo "Das hat nicht geklappt: $LAST"
       echo "Bitte Adresse und Schlüssel prüfen und nochmals starten.";;
esac
read -r -p "Enter zum Schliessen"
