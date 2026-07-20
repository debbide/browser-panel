#!/usr/bin/env bash
# 原地升级：拉最新 Release，不覆盖 tasks/data，然后 npm install，有服务则重启。
#   cd /opt/browser-panel && bash scripts/update.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${GITHUB_REPO:-debbide/browser-panel}"
TAG="${1:-latest}"
SERVICE="${SERVICE_NAME:-browser-automation-panel}"

cd "$ROOT"
echo "[update] $ROOT"

command -v curl >/dev/null || { echo "need curl"; exit 1; }
command -v node >/dev/null || { echo "need node"; exit 1; }

resolve_tag() {
  local json tag
  json="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null || true)"
  tag=""
  if [[ -n "$json" ]]; then
    tag="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tag_name") or "")' <<<"$json" 2>/dev/null || true)"
    [[ -z "$tag" ]] && tag="$(echo "$json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  fi
  echo "$tag"
}

if [[ "$TAG" == "latest" ]]; then
  T="$(resolve_tag || true)"
  TAG="${T:-}"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [[ -n "$TAG" ]]; then
  echo "[update] $TAG"
  curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/tags/${TAG}" -o "$TMP/src.tgz" \
    || curl -fsSL "https://github.com/${REPO}/archive/refs/tags/${TAG}.tar.gz" -o "$TMP/src.tgz"
else
  echo "[update] master"
  curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/master" -o "$TMP/src.tgz"
fi

mkdir -p "$TMP/tree"
tar -xzf "$TMP/src.tgz" -C "$TMP/tree" --strip-components=1

preserve() {
  case "$1" in
    tasks|data|logs|screenshots|runtime-data|node_modules|.venv|.git|.env|.env.panel|.env.local) return 0 ;;
    .env*) return 0 ;;
    *) return 1 ;;
  esac
}

shopt -s dotglob nullglob
for p in "$TMP/tree"/*; do
  n="$(basename "$p")"
  preserve "$n" && continue
  if [[ -d "$p" ]]; then
    rm -rf "$ROOT/$n"
    cp -a "$p" "$ROOT/$n"
  else
    cp -a "$p" "$ROOT/$n"
  fi
done
shopt -u dotglob nullglob

echo "[update] npm install"
npm install --omit=dev

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "${SERVICE}.service" 2>/dev/null | grep -q "${SERVICE}.service"; then
  if [[ "$(id -u)" -eq 0 ]]; then
    systemctl restart "${SERVICE}.service" || true
  else
    sudo systemctl restart "${SERVICE}.service" || true
  fi
fi

echo "[update] done (tasks/data kept)"
