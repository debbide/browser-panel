#!/usr/bin/env bash
# Update panel code + node modules, then restart service if present.
# Does NOT reconfigure directories, browser users, or proxies (use the panel).
#
#   cd /path/to/browser-automation-panel
#   bash scripts/update.sh
#   bash scripts/update.sh --deps    # also refresh python DP deps
set -euo pipefail

# Always operate in the repo that contains this script — never relocate the project.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WITH_DEPS=0
SERVICE="${SERVICE_NAME:-browser-automation-panel}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deps) WITH_DEPS=1; shift ;;
    -h|--help)
      echo "Usage: $0 [--deps]"
      echo "  --deps   also run install-deps.sh (DP only)"
      echo "  Updates stay in: $(cd "$(dirname "$0")/.." && pwd)"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

cd "$ROOT"
echo "[update] fixed project dir (will not move): $ROOT"

if [[ -d .git ]]; then
  echo "[update] git pull in place..."
  # Never change remote checkout path; only update files in $ROOT
  git -C "$ROOT" pull --ff-only || git -C "$ROOT" pull
else
  echo "[update] not a git repo, skip pull"
fi

echo "[update] npm install..."
npm install --omit=dev

if [[ "$WITH_DEPS" -eq 1 ]]; then
  bash "$ROOT/scripts/install-deps.sh"
fi

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "${SERVICE}.service" 2>/dev/null | grep -q "${SERVICE}.service"; then
  echo "[update] restart ${SERVICE}..."
  if [[ "$(id -u)" -eq 0 ]]; then
    systemctl restart "${SERVICE}.service"
    systemctl --no-pager --full status "${SERVICE}.service" || true
  else
    sudo systemctl restart "${SERVICE}.service"
    sudo systemctl --no-pager --full status "${SERVICE}.service" || true
  fi
else
  echo "[update] no systemd unit '${SERVICE}' — start manually: node server/index.js"
fi

echo "[update] done."
