#!/bin/bash
# Weckt den Mac jeden Morgen um 06:40, damit die 7-Uhr-Meldungen (Föhn, Ausrüstung) pünktlich aufs iPhone kommen.
# Tagsüber (6–22 Uhr) hält AFC den Mac danach selbst wach. Zugeklappt schläft ein MacBook trotzdem:
# Deckel offen lassen (Bildschirm darf dunkel werden) und am besten am Strom.
# Fragt einmal nach dem Mac-Passwort (beim Tippen sieht man nichts, das ist normal).
echo "AFC: Mac jeden Morgen um 06:40 wecken"
echo
if sudo pmset repeat wakeorpoweron MTWRFSU 06:40:00; then
  echo
  echo "✅ Eingerichtet. So sieht der Zeitplan aus:"
  pmset -g sched
  echo
  echo "Ausschalten: «AFC wach halten beenden» doppelklicken."
else
  echo "❌ Hat nicht geklappt (Passwort falsch?). Einfach nochmals doppelklicken."
fi
read -r -p "Enter zum Schliessen"
