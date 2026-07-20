#!/usr/bin/env bash
# 首次安装：下载最新 Release 到当前目录（或 --dir），再装依赖。
#   mkdir -p /opt/browser-panel && cd /opt/browser-panel
#   curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/install.sh | bash
set -euo pipefail

REPO="${GITHUB_REPO:-debbide/browser-panel}"
TAG="${TAG:-latest}"
ROOT=""
WITH_SB=0
WITH_PW=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) ROOT="$2"; shift 2 ;;
    --tag) TAG="$2"; shift 2 ;;
    --sb) WITH_SB=1; shift ;;
    --playwright|--pw) WITH_PW=1; shift ;;
    -h|--help) echo "Usage: install.sh [--dir PATH] [--tag TAG] [--sb] [--playwright]"; exit 0 ;;
    *) echo "Unknown: $1" >&2; exit 1 ;;
  esac
done

# 当前目录，或 --dir；curl|bash 时用 pwd
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # 已在仓库 scripts/ 里执行时，ROOT=仓库根
  if [[ -z "$ROOT" && -f "$HERE/../package.json" ]]; then
    ROOT="$(cd "$HERE/.." && pwd)"
  fi
fi
ROOT="${ROOT:-$(pwd)}"
mkdir -p "$ROOT"
ROOT="$(cd "$ROOT" && pwd)"
echo "[install] $ROOT"

command -v curl >/dev/null || { echo "need curl"; exit 1; }
command -v tar >/dev/null || { echo "need tar"; exit 1; }
command -v node >/dev/null || { echo "need Node.js >= 18"; exit 1; }
command -v python3 >/dev/null || { echo "need python3"; exit 1; }

# 解析 latest tag
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
  echo "[install] release $TAG"
  curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/tags/${TAG}" -o "$TMP/src.tgz" \
    || curl -fsSL "https://github.com/${REPO}/archive/refs/tags/${TAG}.tar.gz" -o "$TMP/src.tgz"
else
  echo "[install] no release, use master"
  curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/master" -o "$TMP/src.tgz"
fi

mkdir -p "$TMP/tree"
tar -xzf "$TMP/src.tgz" -C "$TMP/tree" --strip-components=1

# 已有安装：只覆盖代码，不动 tasks/data 等
preserve() {
  case "$1" in
    tasks|data|logs|screenshots|runtime-data|node_modules|.venv|.git|.env|.env.panel|.env.local) return 0 ;;
    .env*) return 0 ;;
    *) return 1 ;;
  esac
}

if [[ -f "$ROOT/package.json" ]]; then
  echo "[install] update files (keep tasks/data)"
  shopt -s dotglob nullglob
  for p in "$TMP/tree"/*; do
    n="$(basename "$p")"
    preserve "$n" && { echo "  skip $n"; continue; }
    if [[ -d "$p" ]]; then
      rm -rf "$ROOT/$n"
      cp -a "$p" "$ROOT/$n"
    else
      cp -a "$p" "$ROOT/$n"
    fi
  done
  shopt -u dotglob nullglob
else
  echo "[install] fresh copy"
  shopt -s dotglob
  cp -a "$TMP/tree"/* "$ROOT"/
  shopt -u dotglob
fi

mkdir -p "$ROOT/tasks" "$ROOT/data" "$ROOT/logs" "$ROOT/screenshots" "$ROOT/runtime-data"
cd "$ROOT"

echo "[install] npm + python deps"
npm install --omit=dev
python3 -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -U pip setuptools wheel
pip install -r requirements-dp.txt
[[ "$WITH_PW" -eq 1 ]] && pip install -r requirements-playwright.txt && (python -m playwright install chromium || true)
[[ "$WITH_SB" -eq 1 ]] && (pip install -r requirements-sb.txt || true) && (python -m seleniumbase install chromedriver || true)
deactivate || true
python3 -m pip install --break-system-packages -r requirements-dp.txt 2>/dev/null \
  || python3 -m pip install -r requirements-dp.txt 2>/dev/null || true
[[ "$WITH_SB" -eq 1 ]] && python3 -m pip install --break-system-packages -r requirements-sb.txt 2>/dev/null || true
cp -f "$(command -v node)" /tmp/node-openclaw 2>/dev/null || true
chmod 755 /tmp/node-openclaw 2>/dev/null || true

echo "[install] done → $ROOT"
echo "  start:  cd $ROOT && node server/index.js"
echo "  update: cd $ROOT && bash scripts/update.sh"
