#!/bin/bash
# Rechnet AFC für die letzten 90 Tage nach und vergleicht mit den Messungen der MeteoSchweiz.
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR" || exit 1
NODE="$(command -v node || true)"
for c in /opt/homebrew/bin/node /usr/local/bin/node; do [ -z "$NODE" ] && [ -x "$c" ] && NODE="$c"; done
"$NODE" tools/backtest.js --days "${1:-90}" && open "$(ls -t data/backtest-*.txt | head -1)"
read -r -p "Enter zum Schliessen"
