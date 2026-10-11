#!/usr/bin/env sh
# Doublage sur Mac ou Linux : ./lancer-doublage.sh
cd "$(dirname "$0")"
command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
if command -v cloudflared >/dev/null 2>&1; then
  cloudflared tunnel --url http://localhost:8765 > .tunnel.log 2>&1 &
  echo "Tunnel Cloudflare : l'adresse https://….trycloudflare.com est dans .tunnel.log"
fi
uv run start.py --web
