#!/usr/bin/env bash
# Update panel **in place** (directory never moves).
#
# Default: pull latest GitHub Release code (safe sync).
# Never overwrites: tasks/ data/ logs/ screenshots/ runtime-data/ .env* .venv/ node_modules/
#
#   bash scripts/update.sh
#   bash scripts/update.sh --tag v1.0.0
#   bash scripts/update.sh --git          # use git pull instead of release
#   bash scripts/update.sh --deps         # also refresh python/node via install-deps
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/release-sync.sh
source "$ROOT/scripts/lib/release-sync.sh"

MODE="release"   # release | git
TAG="latest"
WITH_DEPS=0
SERVICE="${SERVICE_NAME:-browser-automation-panel}"
REPO_SLUG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --git) MODE="git"; shift ;;
    --release) MODE="release"; shift ;;
    --tag) TAG="$2"; shift 2 ;;
    --repo) REPO_SLUG="$2"; shift 2 ;;
    --deps) WITH_DEPS=1; shift ;;
    -h|--help)
      cat <<EOF
Usage: $0 [--release|--git] [--tag TAG] [--deps] [--repo owner/name]

  Default --release  Download latest GitHub Release (or --tag) and sync code
                     ONLY. Preserves tasks/, data/, logs/, screenshots/,
                     runtime-data/, .env*, .venv/, node_modules/
  --git              git pull in this directory (still does not wipe tasks/)
  --deps             run install-deps.sh after update
  --tag vX.Y.Z       release tag (default: latest)
  --repo owner/name  override GitHub repo (default: origin or debbide/browser-panel)

Project stays at: $ROOT
EOF
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

cd "$ROOT"
echo "[update] fixed project dir: $ROOT"

if [[ "$MODE" == "git" ]]; then
  if [[ ! -d "$ROOT/.git" ]]; then
    echo "[update] no .git here; use default release mode or clone first" >&2
    exit 1
  fi
  echo "[update] git pull in place..."
  git -C "$ROOT" pull --ff-only || git -C "$ROOT" pull
else
  if ! command -v curl >/dev/null 2>&1; then
    echo "[update] curl required for release mode" >&2
    exit 1
  fi
  if [[ -z "$REPO_SLUG" ]]; then
    REPO_SLUG="$(detect_repo_slug "$ROOT")"
  fi
  echo "[update] release sync from github.com/${REPO_SLUG}"

  TMP="$(mktemp -d)"
  cleanup() { rm -rf "$TMP"; }
  trap cleanup EXIT

  download_release_tree "$REPO_SLUG" "$TMP" "$TAG"
  # Safety: refuse if preserve paths would be wiped — sync function skips them
  if [[ -d "$ROOT/tasks" ]]; then
    echo "[update] keep existing tasks/ ($(find "$ROOT/tasks" -type f 2>/dev/null | wc -l | tr -d ' ') files)"
  fi
  if [[ -d "$ROOT/data" ]]; then
    echo "[update] keep existing data/"
  fi
  safe_sync_release_into "$TMP/tree" "$ROOT"
  echo "[update] applied ${RELEASE_TAG_RESOLVED:-release}"
fi

echo "[update] npm install..."
npm install --omit=dev

if [[ "$WITH_DEPS" -eq 1 ]]; then
  bash "$ROOT/scripts/install-deps.sh"
fi

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "${SERVICE}.service" 2>/dev/null | grep -q "${SERVICE}.service"; then
  echo "[update] restart ${SERVICE}..."
  if [[ "$(id -u)" -eq 0 ]]; then
    systemctl restart "${SERVICE}.service" || true
    systemctl --no-pager --full status "${SERVICE}.service" || true
  else
    sudo systemctl restart "${SERVICE}.service" || true
    sudo systemctl --no-pager --full status "${SERVICE}.service" || true
  fi
else
  echo "[update] no systemd unit '${SERVICE}' — restart node manually if needed"
fi

echo "[update] done @ $ROOT"
echo "[update] preserved: tasks data logs screenshots runtime-data .env* .venv node_modules"
