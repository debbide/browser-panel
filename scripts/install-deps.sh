#!/usr/bin/env bash
# Install runtime dependencies only (Node + Python).
# Directory / browser-user / proxy etc. are configured in the panel or .env — not here.
#
#   sudo bash scripts/install-deps.sh
#   sudo bash scripts/install-deps.sh --sb
#   sudo bash scripts/install-deps.sh --playwright
set -euo pipefail

WITH_SB=0
WITH_PW=0
# Always the directory that holds this repo (parent of scripts/) — never /opt hardcode move.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sb) WITH_SB=1; shift ;;
    --playwright|--pw) WITH_PW=1; shift ;;
    -h|--help)
      echo "Usage: $0 [--sb] [--playwright]"
      echo "Installs deps into: $(cd "$(dirname "$0")/.." && pwd)"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

cd "$ROOT"
echo "[deps] project dir (fixed, not relocated): $ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "[deps] node not found. Install Node.js >= 18 first." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[deps] python3 not found." >&2
  exit 1
fi

echo "[deps] npm install..."
npm install --omit=dev

echo "[deps] python venv + DP packages..."
python3 -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -U pip setuptools wheel
pip install -r requirements-dp.txt

if [[ "$WITH_PW" -eq 1 ]]; then
  echo "[deps] playwright..."
  pip install -r requirements-playwright.txt
  python -m playwright install chromium || true
  npx playwright install chromium || true
fi

if [[ "$WITH_SB" -eq 1 ]]; then
  echo "[deps] seleniumbase (may fail on ARM)..."
  pip install -r requirements-sb.txt || true
  python -m seleniumbase install chromedriver || true
fi
deactivate || true

# Browser tasks often run with system python3 via su — install DP there too.
echo "[deps] system python3 DP packages..."
if python3 -m pip install --break-system-packages -r requirements-dp.txt 2>/dev/null; then
  :
elif python3 -m pip install -r requirements-dp.txt 2>/dev/null; then
  :
else
  echo "[deps] warn: could not install system-wide DP packages; browser su path may miss modules"
fi

if [[ "$WITH_SB" -eq 1 ]]; then
  python3 -m pip install --break-system-packages -r requirements-sb.txt 2>/dev/null || true
fi

# Convenience binary name used by browser-launcher on some hosts
if [[ -x "$(command -v node)" ]]; then
  cp -f "$(command -v node)" /tmp/node-openclaw 2>/dev/null || true
  chmod 755 /tmp/node-openclaw 2>/dev/null || true
fi

echo "[deps] done."
echo "  node=$(node -v)  venv=$ROOT/.venv"
echo "  Panel paths / browser user / proxy → configure in panel or environment."
