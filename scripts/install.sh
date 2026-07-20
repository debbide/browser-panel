#!/usr/bin/env bash
# Thin entry: install deps in current project directory.
# For download-from-GitHub first install, use: scripts/install-from-release.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[install] project stays at: $ROOT"
bash "$ROOT/scripts/install-deps.sh" "$@"

echo
echo "[install] next:"
echo "  cd $ROOT && node server/index.js"
echo "  configure paths/proxy/env in the panel"
echo "  later: bash scripts/update.sh          # release, keeps tasks+data"
echo "         bash scripts/update.sh --git    # optional git pull"
