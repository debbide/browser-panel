#!/usr/bin/env bash
# First install from GitHub Release into the **current directory** (or create it).
# Does not move an existing install. Does not ship business task scripts.
#
#   mkdir -p /opt/browser-panel && cd /opt/browser-panel
#   curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/install-from-release.sh | bash
#   # or, already have repo:
#   bash scripts/install-from-release.sh
set -euo pipefail

# If executed via curl|bash, BASH_SOURCE may be empty — use cwd
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$HERE/lib/release-sync.sh" ]]; then
    ROOT="$(cd "$HERE/.." && pwd)"
    # shellcheck source=lib/release-sync.sh
    source "$HERE/lib/release-sync.sh"
  else
    ROOT="$(pwd)"
  fi
else
  ROOT="$(pwd)"
fi

TAG="${TAG:-latest}"
REPO_SLUG="${GITHUB_REPO:-debbide/browser-panel}"
WITH_SB=0
WITH_PW=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --repo) REPO_SLUG="$2"; shift 2 ;;
    --dir) ROOT="$2"; shift 2 ;;
    --sb) WITH_SB=1; shift ;;
    --playwright|--pw) WITH_PW=1; shift ;;
    -h|--help)
      echo "Usage: $0 [--dir PATH] [--tag TAG] [--repo owner/name] [--sb] [--playwright]"
      exit 0
      ;;
    *) echo "Unknown: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$ROOT"
ROOT="$(cd "$ROOT" && pwd)"
echo "[install-release] target dir (fixed): $ROOT"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl required" >&2
  exit 1
fi

# Bootstrap liberate-sync if we only have curl|bash into empty dir
if ! type safe_sync_release_into >/dev/null 2>&1; then
  TMPLIB="$(mktemp -d)"
  curl -fsSL "https://raw.githubusercontent.com/${REPO_SLUG}/master/scripts/lib/release-sync.sh" -o "$TMPLIB/release-sync.sh"
  # shellcheck disable=SC1090
  source "$TMPLIB/release-sync.sh"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP" ${TMPLIB:-}' EXIT

download_release_tree "$REPO_SLUG" "$TMP" "$TAG"

if [[ -f "$ROOT/package.json" ]]; then
  echo "[install-release] existing install — safe sync (keep tasks/data)"
  safe_sync_release_into "$TMP/tree" "$ROOT"
else
  echo "[install-release] fresh extract into $ROOT"
  # Fresh: copy everything from tarball; tasks/ in repo is only templates
  shopt -s dotglob
  cp -a "$TMP/tree"/* "$ROOT"/
  shopt -u dotglob
  mkdir -p "$ROOT/tasks" "$ROOT/data" "$ROOT/logs" "$ROOT/screenshots" "$ROOT/runtime-data"
fi

cd "$ROOT"
DEPS_ARGS=()
[[ "$WITH_SB" -eq 1 ]] && DEPS_ARGS+=(--sb)
[[ "$WITH_PW" -eq 1 ]] && DEPS_ARGS+=(--playwright)

if [[ -f "$ROOT/scripts/install-deps.sh" ]]; then
  bash "$ROOT/scripts/install-deps.sh" "${DEPS_ARGS[@]+"${DEPS_ARGS[@]}"}"
else
  echo "[install-release] scripts/install-deps.sh missing after extract" >&2
  exit 1
fi

echo
echo "[install-release] done @ $ROOT (tag ${RELEASE_TAG_RESOLVED:-unknown})"
echo "  Start:  cd $ROOT && node server/index.js"
echo "  Update: bash scripts/update.sh"
echo "  Local tasks/ and data/ are yours — updates will not wipe them."
