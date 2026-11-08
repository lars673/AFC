#!/usr/bin/env bash
# Richtet AFC auf einem frischen Ubuntu-Server ein (Oracle Cloud «Always Free», Hetzner o. ä.).
# Aufruf auf dem Server:  curl -fsSL https://raw.githubusercontent.com/lars673/AFC/feature/autostart-terrain-score/deploy/server-einrichten.sh | sudo bash
set -euo pipefail
BRANCH=${AFC_BRANCH:-feature/autostart-terrain-score}
echo "== Pakete"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates >/dev/null
if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "Node $(node -v)"
echo "== Benutzer und Code"
id afc >/dev/null 2>&1 || useradd -m -s /bin/bash afc
if [ ! -d /home/afc/AFC/.git ]; then
  sudo -u afc git clone -q -b "$BRANCH" https://github.com/lars673/AFC.git /home/afc/AFC
fi
sudo -u afc mkdir -p /home/afc/AFC/data
echo "== Dienst"
cp /home/afc/AFC/deploy/afc.service /etc/systemd/system/afc.service
systemctl daemon-reload
systemctl enable --now afc
sleep 3
systemctl --no-pager --lines=0 status afc | head -3
echo "== Tailscale (sichere Adresse für Handy und Freunde)"
command -v tailscale >/dev/null || curl -fsSL https://tailscale.com/install.sh | sh
echo
echo "Fertig. Jetzt noch:  sudo tailscale up   (Link im Browser öffnen und mit deinem Tailscale-Konto anmelden)"
echo "danach:              sudo tailscale funnel --bg 8787"
