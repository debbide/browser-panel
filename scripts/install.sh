#!/usr/bin/env bash
# First-time / full dependency install (thin wrapper).
# Paths, browser profile, proxy → panel UI or env vars, not this script.
#
#   bash scripts/install.sh
#   bash scripts/install.sh --sb --playwright
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[install] project stays at: $ROOT"
echo "[install] installing dependencies in place..."
bash "$ROOT/scripts/install-deps.sh" "$@"

echo
echo "[install] next:"
echo "  1) export PORT=3210   # optional"
echo "  2) cd $ROOT && node server/index.js"
echo "  3) open panel → configure browser/proxy/env vars (paths stay here)"
echo "  later updates (same directory): bash scripts/update.sh"
