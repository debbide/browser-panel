#!/usr/bin/env bash
# 一条命令：没装过就安装，装过就升级，最后重启面板服务。
# SSH 粘贴回车即可：
#   curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/bp.sh | bash
set -euo pipefail

REPO="${GITHUB_REPO:-debbide/browser-panel}"
ROOT="${PANEL_ROOT:-/opt/browser-panel}"
SERVICE="${SERVICE_NAME:-browser-automation-panel}"
XVFB_SERVICE="${XVFB_SERVICE:-xvfb-browser}"

export http_proxy="${http_proxy:-${HTTP_PROXY:-}}"
export https_proxy="${https_proxy:-${HTTPS_PROXY:-}}"

log() { echo "[bp] $*"; }
die() { echo "[bp] ERROR: $*" >&2; exit 1; }

command -v curl >/dev/null || die "need curl"
command -v tar >/dev/null || die "need tar"
command -v node >/dev/null || die "need Node.js >= 18 (install node first)"
command -v python3 >/dev/null || die "need python3"

resolve_tag() {
  local json tag
  json="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null || true)"
  tag=""
  if [[ -n "$json" ]]; then
    if command -v python3 >/dev/null; then
      tag="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("tag_name") or "")' <<<"$json" 2>/dev/null || true)"
    fi
    [[ -z "$tag" ]] && tag="$(echo "$json" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  fi
  echo "$tag"
}

preserve() {
  case "$1" in
    tasks|data|logs|screenshots|runtime-data|node_modules|.venv|.git|.env|.env.panel|.env.local) return 0 ;;
    .env*) return 0 ;;
    *) return 1 ;;
  esac
}

# tasks/ is preserved as a whole (user scripts), but shared helpers under tasks/lib/
# must still track the panel version — otherwise `from lib.panel_callback` breaks
# after upgrade on existing installs.
merge_tasks_lib() {
  local src="$1/tasks/lib"
  local dst="$ROOT/tasks/lib"
  if [[ ! -d "$src" ]]; then
    log "no tasks/lib in package (skip merge)"
    return 0
  fi
  mkdir -p "$dst"
  # Only refresh files shipped by the panel; never delete user extras in tasks/lib.
  # -a preserves mode; do not use --delete.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "$src"/ "$dst"/
  else
    # portable fallback: copy tree over (overwrite same names only)
    cp -a "$src"/. "$dst"/
  fi
  log "merged tasks/lib → $dst"
}

download_and_merge() {
  local tag tmp
  tag="$(resolve_tag || true)"
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  if [[ -n "$tag" ]]; then
    log "release $tag"
    curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/tags/${tag}" -o "$tmp/src.tgz" \
      || curl -fsSL "https://github.com/${REPO}/archive/refs/tags/${tag}.tar.gz" -o "$tmp/src.tgz"
  else
    log "no release tag, use master"
    curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/refs/heads/master" -o "$tmp/src.tgz"
  fi

  mkdir -p "$tmp/tree"
  tar -xzf "$tmp/src.tgz" -C "$tmp/tree" --strip-components=1
  [[ -f "$tmp/tree/package.json" ]] || die "bad archive"

  mkdir -p "$ROOT"
  if [[ -f "$ROOT/package.json" ]]; then
    log "upgrade in place (keep tasks/data; merge tasks/lib)"
    shopt -s dotglob nullglob
    for p in "$tmp/tree"/*; do
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
    # After skipping whole tasks/, refresh shared helpers only.
    merge_tasks_lib "$tmp/tree"
  else
    log "fresh install → $ROOT"
    shopt -s dotglob
    cp -a "$tmp/tree"/* "$ROOT"/
    shopt -u dotglob
  fi
  mkdir -p "$ROOT/tasks" "$ROOT/data" "$ROOT/logs" "$ROOT/screenshots" "$ROOT/runtime-data"
  # Fresh install already has tasks/lib if present in package; ensure dir exists either way.
  mkdir -p "$ROOT/tasks/lib"
}

install_deps() {
  cd "$ROOT"
  log "npm install"
  npm install --omit=dev

  # 仅首次或没有 venv 时装 Python；升级不重装整套 pip（快）
  if [[ ! -x "$ROOT/.venv/bin/python" ]]; then
    log "python venv + DrissionPage"
    python3 -m venv "$ROOT/.venv"
    # shellcheck disable=SC1091
    source "$ROOT/.venv/bin/activate"
    pip install -U pip setuptools wheel
    pip install -r requirements-dp.txt
    deactivate || true
    python3 -m pip install --break-system-packages -r requirements-dp.txt 2>/dev/null \
      || python3 -m pip install -r requirements-dp.txt 2>/dev/null || true
  fi

  if [[ -x "$(command -v node)" ]]; then
    cp -f "$(command -v node)" /tmp/node-openclaw 2>/dev/null || true
    chmod 755 /tmp/node-openclaw 2>/dev/null || true
  fi
}

restart_panel() {
  if ! command -v systemctl >/dev/null 2>&1; then
    log "no systemd — start manually: cd $ROOT && node server/index.js"
    return 0
  fi

  local node_bin
  node_bin="$(command -v node)"

  # 没有 unit 就写一个最小的并启用
  if ! systemctl list-unit-files "${SERVICE}.service" 2>/dev/null | grep -q "${SERVICE}.service"; then
    log "create systemd units"
    if [[ -x /usr/bin/Xvfb ]] && ! systemctl list-unit-files "${XVFB_SERVICE}.service" 2>/dev/null | grep -q "${XVFB_SERVICE}.service"; then
      cat >"/etc/systemd/system/${XVFB_SERVICE}.service" <<'EOF'
[Unit]
Description=Xvfb :1
After=network.target
[Service]
ExecStart=/usr/bin/Xvfb :1 -screen 0 1440x900x24 -ac
Restart=always
[Install]
WantedBy=multi-user.target
EOF
    fi
    cat >"/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=Browser Panel
After=network.target ${XVFB_SERVICE}.service
Wants=${XVFB_SERVICE}.service
[Service]
WorkingDirectory=${ROOT}
Environment=PORT=3210
Environment=BROWSER_DISPLAY=:1.0
Environment=BROWSER_CHROME_PATH=/usr/bin/google-chrome-stable
Environment=PLAYWRIGHT_CHROME_PATH=/usr/bin/google-chrome-stable
Environment=BROWSER_USER=browser
Environment=BROWSER_WORK_DIR=/home/browser/browser-work
ExecStart=${node_bin} server/index.js
Restart=on-failure
User=root
[Install]
WantedBy=multi-user.target
EOF
    # browser 用户
    id browser >/dev/null 2>&1 || useradd -m -s /bin/bash browser 2>/dev/null || true
    mkdir -p /home/browser/browser-work
    chown -R browser:browser /home/browser 2>/dev/null || true
    systemctl daemon-reload
    systemctl enable "${XVFB_SERVICE}.service" 2>/dev/null || true
    systemctl enable "${SERVICE}.service"
  fi

  log "restart services"
  systemctl reset-failed "${XVFB_SERVICE}.service" 2>/dev/null || true
  systemctl restart "${XVFB_SERVICE}.service" 2>/dev/null || true
  # :1 被占用时不强求
  systemctl restart "${SERVICE}.service"
  sleep 1
  systemctl --no-pager --full is-active "${SERVICE}.service" || true
  log "panel: http://0.0.0.0:3210"
}

# ----- main -----
log "root=$ROOT"
download_and_merge
install_deps
restart_panel
log "done"
