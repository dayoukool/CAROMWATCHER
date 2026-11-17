#!/usr/bin/env bash
# Installe le serveur Carambole sur un Raspberry Pi (Raspberry Pi OS Bookworm) et le lance au démarrage.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "== Carambole : installation depuis $DIR"

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  echo "== Installation de Node.js"
  sudo apt-get update && sudo apt-get install -y nodejs
fi
if ! command -v rpicam-vid >/dev/null && ! command -v libcamera-vid >/dev/null; then
  echo "== Installation des outils caméra"
  sudo apt-get install -y rpicam-apps
fi

echo "== Caméras détectées :"
(rpicam-hello --list-cameras || libcamera-hello --list-cameras) 2>&1 | head -20 || true

echo "== Construction de l'application servie par le Pi"
(cd "$DIR" && node build.js)

echo "== Service systemd (démarrage automatique)"
sed -e "s#@DIR@#$DIR#g" -e "s#@USER@#$USER#g" "$DIR/pi/carambole.service" | sudo tee /etc/systemd/system/carambole.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable carambole
sudo systemctl restart carambole

IP=$(hostname -I | awk '{print $1}')
echo
echo "== Prêt."
echo "   Dans l'application : bouton « Raspberry Pi », adresse  $IP:8080"
echo "   Ou dans le navigateur du téléphone :  http://$IP:8080"
echo "   Journal en direct :  journalctl -u carambole -f"
