#!/bin/bash
# Holt jede Nacht eine ganze Sicherung von AFC im Internet (alle Konten, Flugbücher, Gruppe, Gelerntes) auf diesen Mac.
# Die Kopien landen in iCloud Drive › AFC-Sicherung › Server (sonst ~/AFC-Sicherung/Server), die letzten 30 bleiben.
# Zurückspielen: genau wie der Umzug (die Datei ist ein Umzugs-Archiv).
echo "AFC-Sicherung auf den Mac einrichten"
echo
echo "In AFC: Profil › Testphase › Übersicht öffnen › Sicherung › «Mac jede Nacht sichern lassen»."
echo "Dort «Kopieren» drücken und hier einfügen."
echo
read -r -p "1. Adresse von AFC (z. B. https://afc-xyz.up.railway.app): " URL
URL="${URL#Adresse: }"; URL="$(echo "$URL" | tr -d '[:space:]')"; URL="${URL%/}"
read -r -p "2. Schlüssel: " KEY
KEY="${KEY#Schlüssel: }"; KEY="$(echo "$KEY" | tr -d '[:space:]')"
# Wer beide Zeilen auf einmal eingefügt hat
case "$URL" in *Schlüssel:*) KEY="${URL#*Schlüssel:}"; URL="${URL%%Schlüssel:*}";; esac
if [ -z "$URL" ] || [ ${#KEY} -lt 20 ]; then echo "Adresse oder Schlüssel fehlt."; read -r -p "Enter zum Schliessen"; exit 1; fi

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
