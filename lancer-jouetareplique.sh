#!/usr/bin/env sh
# @Raphicollas sur Mac ou Linux. Laisse cette fenêtre ouverte pendant l'utilisation.
cd "$(dirname "$0")"
command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
echo ""
echo "  @Raphicollas démarre. La première fois, l'installation prend 10 à 20 minutes."
echo "  La page s'ouvrira toute seule dans ton navigateur."
echo ""
uv run start.py --web
