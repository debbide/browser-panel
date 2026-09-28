#!/usr/bin/env bash
# 一条命令：没装过就安装，装过就升级，最后重启面板服务。
# SSH 粘贴回车即可：
#   curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/bp.sh | bash
set -euo pipefail

REPO="${GITHUB_REPO:-debbide/browser-panel}"
ROOT="${PANEL_ROOT:-/opt/browser-panel}"
SERVICE="${SERVICE_NAME:-browser-automation-panel}"
XVFB_SERVICE="${XVFB_SERVICE:-xvfb-browser}"
X11VNC_SERVICE="${X11VNC_SERVICE:-x11vnc-browser}"

export http_proxy="${http_proxy:-${HTTP_PROXY:-}}"
export https_proxy="${https_proxy:-${HTTPS_PROXY:-}}"

log() { echo "[bp] $*"; }
die() { echo "[bp] ERROR: $*" >&2; exit 1; }

# 显示模式自动检测：物理桌面(:0) → 直显；无头服务器 → Xvfb(:1)
# 原理：Xorg 在 :0 上跑时，/tmp/.X11-unix/X0 这个 socket 一定存在（X11 固定位置），
# 且 Xorg 进程在跑。Xvfb 用的是 X1，不会误判。
detect_display() {
  if [[ -S /tmp/.X11-unix/X0 ]] && pgrep -x Xorg >/dev/null 2>&1; then
    echo ":0"
  else
    echo ":1.0"
  fi
}

# 桌面模式：把 :0 的 X cookie 同步给 browser 用户，否则浏览器连不上 :0
# （面板以 browser 用户跑浏览器，读不到 root/lightdm 的 auth 文件）
sync_xauthority() {
  local auth=""
  local f
  # 常见位置：lightdm / gdm / 当前用户
  for f in /var/run/lightdm/*/:0 /run/user/*/gdm/Xauthority "$HOME/.Xauthority"; do
    [[ -f "$f" ]] && { auth="$f"; break; }
  done
  # 兜底：从 Xorg 命令行的 -auth 参数里找
  if [[ -z "$auth" ]] && command -v pgrep >/dev/null 2>&1; then
    auth="$(pgrep -a Xorg 2>/dev/null | grep -o '\-auth [^ ]*' | awk '{print $2}' | head -1)"
  fi
  [[ -n "$auth" && -f "$auth" ]] || { log "WARN: 找不到 :0 的 Xauthority，浏览器可能无法显示"; return 1; }
  id browser >/dev/null 2>&1 || useradd -m -s /bin/bash browser 2>/dev/null || true
  cp "$auth" /home/browser/.Xauthority 2>/dev/null || return 1
  chown browser:browser /home/browser/.Xauthority 2>/dev/null || true
  chmod 600 /home/browser/.Xauthority 2>/dev/null || true
  log "Xauthority 已从 $auth 同步给 browser 用户"
}

# 给 panel 的 systemd unit 打显示模式补丁（幂等，可反复跑）
# $1: unit 文件路径；依赖外层的 DISPLAY_VAL 和 ROOT
patch_unit_display() {
  local unit="$1"
  # BROWSER_DISPLAY 按本机检测结果（桌面 :0 / 服务器 :1.0）
  if grep -q "^Environment=BROWSER_DISPLAY=" "$unit" 2>/dev/null; then
    sed -i "s|^Environment=BROWSER_DISPLAY=.*|Environment=BROWSER_DISPLAY=${DISPLAY_VAL}|" "$unit"
  fi
  # 桌面模式：每次启动服务前同步 X cookie（开机后 cookie 会变）；
  # 服务器模式：删掉残留的 ExecStartPre
  if [[ "$DISPLAY_VAL" == ":0" ]]; then
    if ! grep -q "sync-xauthority.sh" "$unit" 2>/dev/null; then
      sed -i "s|^ExecStart=|ExecStartPre=${ROOT}/sync-xauthority.sh\nExecStart=|" "$unit"
    fi
  else
    sed -i '/sync-xauthority.sh/d' "$unit" 2>/dev/null || true
  fi
}

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

  # Stamp the installed version. Tarball installs have no .git, so the panel cannot
  # derive a version from tags — but we already resolved the authoritative release
  # tag above. Write it down so the panel reads it locally, with no network call.
  # Empty tag = master snapshot; record that instead of pretending it is a release.
  if [[ -n "$tag" ]]; then
    printf '{"tag":"%s","ref":"%s","source":"release"}\n' "$tag" "$tag" > "$ROOT/data/version.json"
  else
    printf '{"tag":null,"ref":"master","source":"master"}\n' > "$ROOT/data/version.json"
  fi
}

# npm 的 "up to date" 只表示 arborist 算出的 diff 为空，不校验包内文件完整性。
# 安装被中断/网络抖动可能留下"目录+package.json 在、代码文件缺失"的残包，
# 之后每次 npm install 都会被骗过而永久跳过（ws 漏装事件，2026-09-28，两台机器）。
# 这里对 dependencies 逐个 require.resolve，残缺就删 node_modules 干净重装。
verify_deps() {
  node -e '
    const { createRequire } = require("module");
    const path = require("path");
    const cwd = process.cwd();
    const pkg = require(path.join(cwd, "package.json"));
    const req = createRequire(path.join(cwd, "package.json"));
    const deps = Object.keys(pkg.dependencies || {});
    const bad = [];
    for (const d of deps) {
      try { req.resolve(d); } catch { bad.push(d); }
    }
    if (bad.length) {
      console.error("[bp] broken deps: " + bad.join(", "));
      process.exit(1);
    }
  '
}

install_deps() {
  cd "$ROOT"
  # PATH 上的 npm 可能是垫片（7vt4x 的 /usr/local/bin/npm 只打印不干活）；
  # 用 npm 同目录的 node 去跑它上级 lib 下的真身 npm-cli.js（正常机器上两者是同一个）。
  # 注意：不用 command -v node 定位，因为管道 bash 的 PATH 顺序可能不同。
  local -a npm_cmd=("npm")
  local npm_dir node_bin cli
  npm_dir="$(dirname "$(command -v npm)")"
  node_bin="$npm_dir/node"
  cli="$npm_dir/../lib/node_modules/npm/bin/npm-cli.js"
  if [[ -f "$cli" && -x "$node_bin" ]]; then
    npm_cmd=("$node_bin" "$cli")
    log "使用真身 npm: $cli"
  fi
  log "npm install"
  "${npm_cmd[@]}" install --omit=dev
  if ! verify_deps; then
    log "node_modules 不完整，干净重装"
    rm -rf node_modules
    "${npm_cmd[@]}" install --omit=dev
    if ! verify_deps; then
      # 整包安装被 npm 误判为 up to date（如 7vt4x 的 arborist 异常）时，
      # 逐个用 --force 硬装，绕过整包误判。正常机器走不到这里。
      log "整包安装无效，逐个强制安装依赖"
      rm -rf node_modules
      local spec node_for_read
      node_for_read="$(command -v node)"
      while IFS= read -r spec; do
        [[ -n "$spec" ]] || continue
        log "强制安装 $spec"
        "${npm_cmd[@]}" install "$spec" --no-save --force --omit=dev || die "安装 $spec 失败，请检查网络/npm"
      done < <("$node_for_read" -e "
try {
  const pkg = require('./package.json');
  for (const [k, v] of Object.entries(pkg.dependencies || {})) console.log(k + '@' + v);
} catch (e) { process.exit(1); }
" 2>/dev/null)
      verify_deps || die "逐个安装后依赖仍残缺，请检查磁盘/网络/npm 是否正常"
    fi
  fi

  # Python 浏览器任务统一使用 install-browser-stack.sh 准备的系统 Python。
  # bp.sh 只安装/更新面板本身，不创建 venv，也不重复修改 Python 依赖。

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
  local unit_panel="/etc/systemd/system/${SERVICE}.service"
  local unit_xvfb="/etc/systemd/system/${XVFB_SERVICE}.service"
  local unit_x11vnc="/etc/systemd/system/${X11VNC_SERVICE}.service"
  local units_changed=0

  # 显示模式自动检测：有物理桌面(:0) → 浏览器直显；无头服务器 → Xvfb(:1)
  local DISPLAY_VAL
  DISPLAY_VAL="$(detect_display)"
  if [[ "$DISPLAY_VAL" == ":0" ]]; then
    log "桌面模式：检测到物理显示 :0，浏览器将直接显示到桌面"
    sync_xauthority || log "WARN: Xauthority 同步失败，浏览器可能无法显示到桌面"
    # 生成开机同步脚本：X cookie 重启会变，systemd 每次启动服务前重新同步
    # （此文件不在 release 包里，一键脚本升级不会删它）
    cat >"${ROOT}/sync-xauthority.sh" <<'SCRIPT_EOF'
#!/bin/bash
# 桌面模式：把 :0 的 X cookie 同步给 browser 用户
for f in /var/run/lightdm/*/:0 /run/user/*/gdm/Xauthority; do
  [[ -f "$f" ]] && cp "$f" /home/browser/.Xauthority 2>/dev/null && break
done
if [[ ! -s /home/browser/.Xauthority ]] && command -v pgrep >/dev/null 2>&1; then
  auth="$(pgrep -a Xorg 2>/dev/null | grep -o '\-auth [^ ]*' | awk '{print $2}' | head -1)"
  [[ -n "$auth" && -f "$auth" ]] && cp "$auth" /home/browser/.Xauthority 2>/dev/null
fi
chown browser:browser /home/browser/.Xauthority 2>/dev/null
chmod 600 /home/browser/.Xauthority 2>/dev/null
SCRIPT_EOF
    chmod +x "${ROOT}/sync-xauthority.sh"
  else
    log "服务器模式：无物理显示，使用 Xvfb :1"
  fi

  # BROWSER_DISPLAY 改由 bp.sh 自动检测统一管理（写进 systemd unit），
  # 从 .env.panel 里删掉——否则 EnvironmentFile 在 unit 里排在 Environment=
  # 后面，systemd 按"后出现的生效"，.env.panel 的旧值会把 unit 的覆盖掉。
  if [[ -f "${ROOT}/.env.panel" ]] && grep -q "^BROWSER_DISPLAY=" "${ROOT}/.env.panel" 2>/dev/null; then
    log "从 .env.panel 移除 BROWSER_DISPLAY（改由 bp.sh 自动检测管理）"
    sed -i '/^BROWSER_DISPLAY=/d' "${ROOT}/.env.panel"
  fi

  # Prefer packaged unit templates when present (keeps disk units in sync after upgrades).
  if [[ -f "$ROOT/deploy/xvfb-browser.service" ]]; then
    if [[ ! -f "$unit_xvfb" ]] || ! cmp -s "$ROOT/deploy/xvfb-browser.service" "$unit_xvfb" 2>/dev/null; then
      log "install/update ${XVFB_SERVICE}.service"
      install -m 644 "$ROOT/deploy/xvfb-browser.service" "$unit_xvfb"
      units_changed=1
    fi
  fi

  # x11vnc：给面板内嵌 noVNC 用的 VNC 服务端（:1 → 127.0.0.1:5901），掉线自动拉起。
  # 只在服务器模式（Xvfb :1）下装：桌面模式 :0 的 X authority 归属登录用户，服务里挂 x11vnc 容易权限翻车。
  if [[ "$DISPLAY_VAL" != ":0" ]] && [[ -f "$ROOT/deploy/x11vnc-browser.service" ]]; then
    if [[ ! -f "$unit_x11vnc" ]] || ! cmp -s "$ROOT/deploy/x11vnc-browser.service" "$unit_x11vnc" 2>/dev/null; then
      log "install/update ${X11VNC_SERVICE}.service"
      install -m 644 "$ROOT/deploy/x11vnc-browser.service" "$unit_x11vnc"
      units_changed=1
    fi
  fi

  # 没有 panel unit 就写一个最小的并启用
  if ! systemctl list-unit-files "${SERVICE}.service" 2>/dev/null | grep -q "${SERVICE}.service" \
    || [[ ! -f "$unit_panel" ]]; then
    log "create systemd units"
    if [[ -x /usr/bin/Xvfb ]] && [[ ! -f "$unit_xvfb" ]]; then
      cat >"$unit_xvfb" <<'EOF'
[Unit]
Description=Xvfb :1
After=network.target
[Service]
ExecStart=/usr/bin/Xvfb :1 -screen 0 1440x900x24 -ac
Restart=always
[Install]
WantedBy=multi-user.target
EOF
      units_changed=1
    fi
    if [[ -f "$ROOT/deploy/browser-automation-panel.service" ]]; then
      sed "s|ExecStart=.*node server/index.js|ExecStart=${node_bin} server/index.js|" \
        "$ROOT/deploy/browser-automation-panel.service" >"$unit_panel"
      sed -i "s|^WorkingDirectory=.*|WorkingDirectory=${ROOT}|" "$unit_panel"
      sed -i "s|^EnvironmentFile=.*|EnvironmentFile=-${ROOT}/.env.panel|" "$unit_panel" 2>/dev/null || true
      # Never leave a hard-coded Chrome path in the unit — Environment= beats EnvironmentFile=
      # and google-chrome-stable does not exist on ARM / snap-only hosts.
      sed -i '/^Environment=BROWSER_CHROME_PATH=/d' "$unit_panel" 2>/dev/null || true
      sed -i '/^Environment=PLAYWRIGHT_CHROME_PATH=/d' "$unit_panel" 2>/dev/null || true
      # 显示模式：BROWSER_DISPLAY + ExecStartPre（桌面 :0 / 服务器 :1.0）
      patch_unit_display "$unit_panel"
    else
      # Minimal unit: Chrome path only from .env.panel (do not hard-code amd64 Chrome).
      cat >"$unit_panel" <<EOF
[Unit]
Description=Browser Panel
After=network.target ${XVFB_SERVICE}.service
Wants=${XVFB_SERVICE}.service
[Service]
WorkingDirectory=${ROOT}
Environment=PORT=3210
Environment=BROWSER_DISPLAY=${DISPLAY_VAL}
Environment=BROWSER_USER=browser
Environment=BROWSER_WORK_DIR=/home/browser/browser-work
EnvironmentFile=-${ROOT}/.env.panel
ExecStart=${node_bin} server/index.js
Restart=on-failure
User=root
[Install]
WantedBy=multi-user.target
EOF
      # 显示模式：BROWSER_DISPLAY + ExecStartPre（桌面 :0 / 服务器 :1.0）
      patch_unit_display "$unit_panel"
    fi
    units_changed=1
    # browser 用户
    id browser >/dev/null 2>&1 || useradd -m -s /bin/bash browser 2>/dev/null || true
    mkdir -p /home/browser/browser-work
    chown -R browser:browser /home/browser 2>/dev/null || true
  elif [[ -f "$ROOT/deploy/browser-automation-panel.service" ]]; then
    # Existing install: refresh ExecStart node path + WorkingDirectory if template drifted
    local tmp_unit
    tmp_unit="$(mktemp)"
    sed "s|ExecStart=.*node server/index.js|ExecStart=${node_bin} server/index.js|" \
      "$ROOT/deploy/browser-automation-panel.service" >"$tmp_unit"
    sed -i "s|^WorkingDirectory=.*|WorkingDirectory=${ROOT}|" "$tmp_unit"
    sed -i "s|^EnvironmentFile=.*|EnvironmentFile=-${ROOT}/.env.panel|" "$tmp_unit" 2>/dev/null || true
    # Strip hard-coded chrome paths from old units / templates so .env.panel wins
    sed -i '/^Environment=BROWSER_CHROME_PATH=/d' "$tmp_unit" 2>/dev/null || true
    sed -i '/^Environment=PLAYWRIGHT_CHROME_PATH=/d' "$tmp_unit" 2>/dev/null || true
    # 显示模式：BROWSER_DISPLAY + ExecStartPre（桌面 :0 / 服务器 :1.0）
    patch_unit_display "$tmp_unit"
    # Also strip from the live unit when refreshing, even if other fields match
    if [[ -f "$unit_panel" ]]; then
      if grep -qE '^Environment=BROWSER_CHROME_PATH=|^Environment=PLAYWRIGHT_CHROME_PATH=' "$unit_panel" 2>/dev/null; then
        log "remove hard-coded Chrome path from ${SERVICE}.service (use .env.panel)"
        sed -i '/^Environment=BROWSER_CHROME_PATH=/d' "$unit_panel" 2>/dev/null || true
        sed -i '/^Environment=PLAYWRIGHT_CHROME_PATH=/d' "$unit_panel" 2>/dev/null || true
        units_changed=1
      fi
    fi
    if ! cmp -s "$tmp_unit" "$unit_panel" 2>/dev/null; then
      log "update ${SERVICE}.service from deploy template"
      install -m 644 "$tmp_unit" "$unit_panel"
      units_changed=1
    fi
    rm -f "$tmp_unit"
  fi

  # ALWAYS reload before enable/restart — avoids:
  # "unit file changed on disk. Run systemctl daemon-reload"
  log "systemctl daemon-reload"
  systemctl daemon-reload
  systemctl enable "${XVFB_SERVICE}.service" 2>/dev/null || true
  systemctl enable "${SERVICE}.service" 2>/dev/null || true
  # x11vnc：二进制不存在就不启用（比如没装 x11vnc 的机器），避免服务一直 failed 刷屏
  if [[ -f "$unit_x11vnc" ]] && command -v x11vnc >/dev/null 2>&1; then
    systemctl enable "${X11VNC_SERVICE}.service" 2>/dev/null || true
  fi

  log "restart services"
  systemctl reset-failed "${XVFB_SERVICE}.service" 2>/dev/null || true
  systemctl restart "${XVFB_SERVICE}.service" 2>/dev/null || true
  if [[ -f "$unit_x11vnc" ]] && command -v x11vnc >/dev/null 2>&1; then
    systemctl reset-failed "${X11VNC_SERVICE}.service" 2>/dev/null || true
    systemctl restart "${X11VNC_SERVICE}.service" 2>/dev/null || true
  fi
  # 杀掉残留的浏览器进程：面板"关闭浏览器"可能没杀干净，或手动启动的残留；
  # 不杀的话，旧 Chrome（可能是错的 DISPLAY）会继续占着，新的起不来或显示错乱
  # （用 user-data-dir 定位，只杀本面板的浏览器，不误伤用户自己的 Chrome）
  pkill -f "user-data-dir=.*browser-work" 2>/dev/null || true
  pkill -f "firefox.*browser-work" 2>/dev/null || true
  sleep 1
  # :1 被占用时不强求
  systemctl restart "${SERVICE}.service"
  sleep 1
  systemctl --no-pager --full is-active "${SERVICE}.service" || true
  if [[ "$units_changed" -eq 1 ]]; then
    log "systemd units refreshed + reloaded"
  fi
  log "panel: http://0.0.0.0:3210"
}

# ----- main -----
log "root=$ROOT"
download_and_merge
install_deps
restart_panel
log "done"
