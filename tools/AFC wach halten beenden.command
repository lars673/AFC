#!/bin/bash
# Entfernt das morgendliche Wecken (alle wiederkehrenden Weck-Zeiten von pmset).
# AFC hält den Mac dann tagsüber weiterhin wach, solange er läuft (abschalten mit AFC_STAY_AWAKE=0).
echo "AFC: morgendliches Wecken entfernen"
if sudo pmset repeat cancel; then echo "✅ Entfernt."; else echo "❌ Hat nicht geklappt."; fi
read -r -p "Enter zum Schliessen"
