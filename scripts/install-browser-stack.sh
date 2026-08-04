#!/usr/bin/env bash
# One-shot browser + system Python stack for browser-panel.
# - Single system Chrome (no Playwright-bundled browser)
# - Xvfb, fonts, xdotool, ffmpeg, etc.
# - System-wide pip (--break-system-packages): SB / DP / Playwright(py) + common task deps
#
# Usage (root on Ubuntu/Debian):
#   bash /opt/browser-panel/scripts/install-browser-stack.sh
#   # or from repo:
#   curl -fsSL https://raw.githubusercontent.com/debbide/browser-panel/master/scripts/install-browser-stack.sh | bash
#
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

ROOT="${PANEL_ROOT:-/opt/browser-panel}"
ENV_FILE="${PANEL_ENV:-$ROOT/.env.panel}"
BROWSER_USER="${BROWSER_USER:-browser}"
BROWSER_HOME="${BROWSER_HOME:-/home/${BROWSER_USER}}"
BROWSER_WORK="${BROWSER_WORK_DIR:-${BROWSER_HOME}/browser-work}"
DISPLAY_NUM="${BROWSER_DISPLAY:-:1.0}"
CHROME_PATH_DEFAULT="/usr/bin/google-chrome-stable"

log() { echo "[install-browser-stack] $*"; }
die() { echo "[install-browser-stack] ERROR: $*" >&2; exit 1; }

need_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    die "run as root (sudo bash $0)"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) ARCH_OK=1 ;;
  *) ARCH_OK=0; log "WARN: arch=$arch — Google Chrome amd64 deb may not apply; will try chromium" ;;
esac

need_root

# ---------------------------------------------------------------------------
# apt base
# ---------------------------------------------------------------------------
log "apt update + base packages"
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  wget \
  gnupg \
  apt-transport-https \
  software-properties-common \
  build-essential \
  python3 \
  python3-pip \
  python3-dev \
  python3-tk \
  python3-setuptools \
  python3-wheel \
  xvfb \
  xauth \
  xdotool \
  scrot \
  fonts-liberation \
  fonts-noto-cjk \
  fonts-noto-color-emoji \
  ffmpeg \
  libnss3 \
  libatk-bridge2.0-0 \
  libgtk-3-0 \
  libx11-xcb1 \
  libxcb-dri3-0 \
  libdrm2 \
  libgbm1 \
  libasound2 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libpango-1.0-0 \
  libcups2 \
  unzip \
  procps \
  || true

# Some distros split libasound
apt-get install -y --no-install-recommends libasound2t64 2>/dev/null || true

# ---------------------------------------------------------------------------
# Google Chrome / Chromium (single system browser) — no Playwright browser download
# ---------------------------------------------------------------------------
# ARM/Ubuntu often only has snap Chromium. Prefer a real ELF binary over
# /usr/bin/chromium-browser wrappers. Never clobber an existing working path
# in .env.panel with a worse default (e.g. google-chrome-stable on ARM).

is_exec() { [[ -n "${1:-}" && -x "$1" && -f "$1" ]]; }

# True if path is a snap *launcher* (not the real chrome ELF under /snap/chromium/.../chrome).
# Real ELF path is OK for Playwright/DrissionPage executablePath; wrappers die under systemd.
is_snap_wrapper() {
  local p="$1"
  [[ -z "$p" ]] && return 1
  # Real Chromium ELF inside the snap revision — NOT a wrapper
  case "$p" in
    /snap/chromium/*/usr/lib/*/chrome|/snap/chromium/*/usr/lib/*/chromium)
      return 1
      ;;
    /snap/bin/*)
      return 0
      ;;
  esac
  local real
  real="$(readlink -f "$p" 2>/dev/null || true)"
  case "$real" in
    /snap/chromium/*/usr/lib/*/chrome|/snap/chromium/*/usr/lib/*/chromium)
      return 1
      ;;
    /snap/bin/*)
      return 0
      ;;
  esac
  # Transitional packages: /usr/bin/chromium-browser is often a tiny shell that execs snap
  if [[ -f "$p" ]] && head -c 200 "$p" 2>/dev/null | grep -qE 'snap run|snap/bin|chromium\.chromium'; then
    return 0
  fi
  # Symlink that lands in /snap/ but is not the chrome ELF (e.g. /usr/bin/chromium → /snap/bin/chromium)
  case "$real" in
    /snap/*)
      return 0
      ;;
  esac
  return 1
}

# Prefer the real Chromium ELF inside the snap (works as executablePath for PW/DP).
# Wrapper /usr/bin/chromium-browser under systemd often dies with:
#   "is not a snap cgroup for tag snap.chromium.chromium"
resolve_snap_chromium_elf() {
  local c
  for c in \
    /snap/chromium/current/usr/lib/chromium-browser/chrome \
    /snap/chromium/current/usr/lib/chromium/chrome \
    /snap/chromium/current/usr/lib/chromium-browser/chromium \
    /snap/chromium/current/usr/lib/chromium/chromium
  do
    if is_exec "$c"; then
      echo "$c"
      return 0
    fi
  done
  # Versioned snap dir fallback
  local d
  for d in /snap/chromium/*; do
    [[ -d "$d" ]] || continue
    [[ "$(basename "$d")" == "current" ]] && continue
    for c in \
      "$d/usr/lib/chromium-browser/chrome" \
      "$d/usr/lib/chromium/chrome"
    do
      if is_exec "$c"; then
        echo "$c"
        return 0
      fi
    done
  done
  return 1
}

# Return 0 if path looks usable as a browser binary for the panel.
chrome_path_ok() {
  local p="$1"
  is_exec "$p" || return 1
  # Reject known-bad amd64-only default when file is missing (handled by is_exec)
  # Reject snap *wrappers* — they break under systemd; real ELF under /snap/.../chrome is OK.
  if is_snap_wrapper "$p"; then
    return 1
  fi
  return 0
}

read_env_kv() {
  # read KEY from ENV_FILE if present
  local k="$1"
  [[ -f "$ENV_FILE" ]] || return 1
  local line
  line="$(grep -E "^${k}=" "$ENV_FILE" 2>/dev/null | tail -1 || true)"
  [[ -n "$line" ]] || return 1
  echo "${line#*=}"
}

install_chrome() {
  if have google-chrome-stable || have google-chrome; then
    log "Chrome already present: $(command -v google-chrome-stable || command -v google-chrome)"
    return 0
  fi
  # Already have a usable Chromium (deb or snap ELF) — do not reinstall
  if resolve_chrome_path >/dev/null 2>&1; then
    log "Chromium already resolvable — skip install"
    return 0
  fi

  if [[ "$ARCH_OK" -eq 1 ]]; then
    log "installing Google Chrome (amd64 deb)"
    tmpdeb="/tmp/google-chrome-stable_current_amd64.deb"
    if wget -q -O "$tmpdeb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; then
      apt-get install -y "$tmpdeb" || apt-get -f install -y
      rm -f "$tmpdeb"
    else
      log "WARN: download Chrome deb failed — trying chromium"
    fi
  else
    log "arch=$arch — skip Google Chrome amd64 deb; will use Chromium"
  fi

  if ! have google-chrome-stable && ! have google-chrome; then
    log "installing Chromium from apt (may be snap transitional on Ubuntu)"
    apt-get install -y chromium-browser 2>/dev/null \
      || apt-get install -y chromium 2>/dev/null \
      || true
  fi
}

resolve_chrome_path() {
  local c existing

  # 1) Keep an already-configured path if it still works (do not "upgrade" it away)
  existing="$(read_env_kv BROWSER_CHROME_PATH 2>/dev/null || true)"
  if chrome_path_ok "$existing"; then
    echo "$existing"
    return 0
  fi
  # If env pointed at a snap wrapper, try the real ELF next
  if [[ -n "$existing" ]] && is_snap_wrapper "$existing"; then
    c="$(resolve_snap_chromium_elf || true)"
    if [[ -n "$c" ]]; then
      echo "$c"
      return 0
    fi
  fi

  # 2) Real Google Chrome (deb) — best for amd64 systemd
  for c in \
    /usr/bin/google-chrome-stable \
    /usr/bin/google-chrome \
    "$(command -v google-chrome-stable 2>/dev/null || true)" \
    "$(command -v google-chrome 2>/dev/null || true)"
  do
    if chrome_path_ok "$c"; then
      echo "$c"
      return 0
    fi
  done

  # 3) Non-snap Chromium binaries (Debian/RPi etc.)
  for c in \
    /usr/bin/chromium \
    /usr/lib/chromium/chromium \
    /usr/lib/chromium-browser/chromium-browser \
    "$(command -v chromium 2>/dev/null || true)"
  do
    if chrome_path_ok "$c"; then
      echo "$c"
      return 0
    fi
  done

  # 4) Snap Chromium — use the ELF, never /usr/bin/chromium-browser or /snap/bin/chromium
  c="$(resolve_snap_chromium_elf || true)"
  if [[ -n "$c" ]]; then
    log "using snap Chromium ELF (not the snap wrapper): $c"
    echo "$c"
    return 0
  fi

  # 5) Last resort: wrappers (will likely fail under systemd — warn loudly)
  for c in \
    /usr/bin/chromium-browser \
    "$(command -v chromium-browser 2>/dev/null || true)" \
    /snap/bin/chromium \
    "$(command -v chromium 2>/dev/null || true)"
  do
    if is_exec "$c"; then
      log "WARN: only found snap/wrapper Chromium at $c — systemd tasks may fail with snap cgroup errors"
      log "WARN: set BROWSER_CHROME_PATH to the real ELF, e.g. /snap/chromium/current/usr/lib/chromium-browser/chrome"
      echo "$c"
      return 0
    fi
  done
  return 1
}

install_chrome

CHROME_PATH="$(resolve_chrome_path || true)"
[[ -n "${CHROME_PATH:-}" ]] || die "Chrome/Chromium binary not found after install"
log "Chrome path: $CHROME_PATH"
if is_snap_wrapper "$CHROME_PATH"; then
  log "WARN: resolved path is a snap wrapper — panel under systemd may fail to launch browser"
elif [[ "$CHROME_PATH" == /snap/* ]]; then
  log "note: using snap Chromium ELF directly (avoids snap.chromium cgroup wrapper)"
fi
"$CHROME_PATH" --version 2>/dev/null || log "WARN: --version failed for $CHROME_PATH"

# ---------------------------------------------------------------------------
# browser user + work dir
# ---------------------------------------------------------------------------
if ! id -u "$BROWSER_USER" >/dev/null 2>&1; then
  log "creating user $BROWSER_USER"
  useradd -m -s /bin/bash "$BROWSER_USER" || true
fi
mkdir -p \
  "$BROWSER_WORK/persistent" \
  "$BROWSER_WORK/profiles" \
  "$BROWSER_WORK/screenshots" \
  "$BROWSER_WORK/task-results" \
  "$BROWSER_WORK/downloaded_files" \
  "$BROWSER_WORK/assets" \
  "$BROWSER_WORK/archived_files"
chown -R "${BROWSER_USER}:${BROWSER_USER}" "$BROWSER_HOME" 2>/dev/null \
  || chown -R "${BROWSER_USER}:${BROWSER_USER}" "$BROWSER_WORK"
# allow panel worker copies
chmod -R a+rX "$BROWSER_WORK" 2>/dev/null || true

# ---------------------------------------------------------------------------
# .env.panel — single Chrome for everything
# Never overwrite a still-valid BROWSER_CHROME_PATH with a worse guess.
# ---------------------------------------------------------------------------
mkdir -p "$ROOT"
set_kv() {
  local k="$1" v="$2"
  if grep -qE "^${k}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$ENV_FILE"
  else
    echo "${k}=${v}" >>"$ENV_FILE"
  fi
}
set_kv_if_missing() {
  local k="$1" v="$2"
  if grep -qE "^${k}=" "$ENV_FILE" 2>/dev/null; then
    return 0
  fi
  echo "${k}=${v}" >>"$ENV_FILE"
}

if [[ ! -f "$ENV_FILE" ]]; then
  log "creating $ENV_FILE"
  cat >"$ENV_FILE" <<EOF
PORT=3210
HOST=0.0.0.0
BROWSER_DISPLAY=${DISPLAY_NUM}
BROWSER_CHROME_PATH=${CHROME_PATH}
PLAYWRIGHT_CHROME_PATH=${CHROME_PATH}
BROWSER_USER=${BROWSER_USER}
BROWSER_HOME=${BROWSER_HOME}
BROWSER_WORK_DIR=${BROWSER_WORK}
BROWSER_XAUTHORITY=${BROWSER_HOME}/.Xauthority
BROWSER_USER_DATA_DIR=${BROWSER_WORK}/persistent
# Do not download Playwright browsers — use system Chrome
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
EOF
else
  log "updating $ENV_FILE (preserve valid Chrome path)"
  touch "$ENV_FILE"
  existing_chrome="$(read_env_kv BROWSER_CHROME_PATH 2>/dev/null || true)"
  if chrome_path_ok "$existing_chrome"; then
    log "keep existing BROWSER_CHROME_PATH=$existing_chrome"
    # Keep PLAYWRIGHT in sync only if missing/empty
    existing_pw="$(read_env_kv PLAYWRIGHT_CHROME_PATH 2>/dev/null || true)"
    if ! chrome_path_ok "$existing_pw"; then
      set_kv PLAYWRIGHT_CHROME_PATH "$existing_chrome"
    fi
  else
    if [[ -n "$existing_chrome" ]]; then
      log "replace broken BROWSER_CHROME_PATH=$existing_chrome → $CHROME_PATH"
    else
      log "set BROWSER_CHROME_PATH=$CHROME_PATH"
    fi
    set_kv BROWSER_CHROME_PATH "$CHROME_PATH"
    set_kv PLAYWRIGHT_CHROME_PATH "$CHROME_PATH"
  fi
  # Non-chrome keys: only fill if missing (do not thrash operator overrides)
  set_kv_if_missing BROWSER_DISPLAY "$DISPLAY_NUM"
  set_kv_if_missing BROWSER_USER "$BROWSER_USER"
  set_kv_if_missing BROWSER_HOME "$BROWSER_HOME"
  set_kv_if_missing BROWSER_WORK_DIR "$BROWSER_WORK"
  set_kv_if_missing BROWSER_XAUTHORITY "${BROWSER_HOME}/.Xauthority"
  set_kv PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD 1
fi

# ---------------------------------------------------------------------------
# System Python packages (NO venv)
#
# Ubuntu 23.04+ marks the system interpreter as externally managed (PEP 668),
# hence --break-system-packages. Some apt-owned packages (notably urllib3 /
# requests and their transitive dependencies) cannot be uninstalled cleanly by
# pip. --ignore-installed tells pip to install the requested versions under
# /usr/local without removing apt's copies or deleting apt package metadata.
# This host is intentionally a dedicated browser-task runtime.
# ---------------------------------------------------------------------------
log "pip system packages (PEP 668 compatible)"

PIP_INSTALL=(
  python3 -m pip install
  --break-system-packages
  --ignore-installed
  --disable-pip-version-check
  --no-cache-dir
)

# Do not upgrade the system pip itself: on Ubuntu 24.04 it is apt-owned, and
# replacing it adds no value here. setuptools / wheel are regular build inputs.
"${PIP_INSTALL[@]}" -U setuptools wheel

# Include panel requirement files in the same resolver run when the panel is
# already present. (On a clean VPS this script may run before bp.sh, so the
# explicit core list below remains authoritative.)
REQUIREMENT_ARGS=()
for requirement_file in \
  "$ROOT/requirements-dp.txt" \
  "$ROOT/requirements-sb.txt" \
  "$ROOT/requirements-playwright.txt"; do
  if [[ -f "$requirement_file" ]]; then
    REQUIREMENT_ARGS+=(-r "$requirement_file")
  fi
done

# Core stacks. Keep this one command authoritative: if it fails, the installer
# must fail too instead of printing "done" with a half-installed runtime.
"${PIP_INSTALL[@]}" -U \
  "${REQUIREMENT_ARGS[@]}" \
  "requests>=2.31.0" \
  "urllib3>=2.0.0" \
  "Pillow>=10.0.0" \
  "DrissionPage>=4.1.0" \
  "selenium>=4.20.0" \
  "seleniumbase>=4.30.0" \
  "playwright>=1.40.0" \
  "pyrogram>=2.0.0" \
  "TgCrypto>=1.2.0" \
  "SpeechRecognition>=3.10.0" \
  "pydub>=0.25.0" \
  "numpy>=1.24.0"

# Fail the installer if the runtime it just installed is not importable. This
# catches dependency-resolution and ABI errors before a scheduled task finds
# them hours later.
log "verify Python runtime imports"
python3 - <<'PY'
import importlib
import sys

modules = [
    "DrissionPage", "seleniumbase", "selenium", "playwright",
    "pyrogram", "PIL", "requests", "urllib3",
    "speech_recognition", "pydub", "numpy",
]
failed = []
for name in modules:
    try:
        importlib.import_module(name)
    except Exception as exc:
        failed.append(f"{name}: {exc}")
if failed:
    print("Python runtime verification failed:", file=sys.stderr)
    for item in failed:
        print(f"  - {item}", file=sys.stderr)
    raise SystemExit(1)
print("Python runtime imports: OK")
PY

# SeleniumBase chromedriver matching system Chrome (not a second browser)
log "seleniumbase install chromedriver (matches system Chrome)"
if ! python3 -m seleniumbase install chromedriver; then
  # SeleniumBase can also resolve/download a matching driver lazily when a task
  # starts. Keep this non-fatal because transient network/CDN failures should
  # not discard an otherwise complete browser runtime installation.
  log "WARN: seleniumbase install chromedriver failed; SeleniumBase will retry at task runtime"
fi

# Explicitly skip Playwright browser downloads
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export PLAYWRIGHT_BROWSERS_PATH=0
# Do not run: python3 -m playwright install

# ---------------------------------------------------------------------------
# Xvfb as permanent systemd service (always-on display :1)
# ---------------------------------------------------------------------------
install_xvfb_service() {
  local unit_src="$ROOT/deploy/xvfb-browser.service"
  local unit_dst="/etc/systemd/system/xvfb-browser.service"

  if [[ ! -x /usr/bin/Xvfb ]] && ! have Xvfb; then
    log "installing xvfb package"
    apt-get install -y xvfb
  fi

  # Prefer unit shipped with panel; otherwise write a built-in always-on unit
  if [[ -f "$unit_src" ]]; then
    log "installing xvfb-browser.service from $unit_src"
    install -m 644 "$unit_src" "$unit_dst"
  else
    log "writing built-in xvfb-browser.service (panel deploy file missing)"
    cat >"$unit_dst" <<'UNIT'
[Unit]
Description=Xvfb virtual display :1 for browser automation
After=network.target

[Service]
Type=simple
ExecStartPre=-/usr/bin/pkill -f '[X]vfb :1'
ExecStart=/usr/bin/Xvfb :1 -screen 0 1440x900x24 -ac +extension GLX +render -noreset
Restart=always
RestartSec=2
KillMode=process

[Install]
WantedBy=multi-user.target
UNIT
  fi

  # Stop any ad-hoc/background Xvfb so the service owns :1
  pkill -f '[X]vfb :1' 2>/dev/null || true
  sleep 0.5

  systemctl daemon-reload
  systemctl enable xvfb-browser.service
  systemctl restart xvfb-browser.service
  sleep 1
  if systemctl is-active --quiet xvfb-browser.service; then
    log "xvfb-browser.service is active (DISPLAY :1 permanent)"
  else
    log "WARN: xvfb-browser.service failed to start — check: journalctl -u xvfb-browser -n 50"
    systemctl --no-pager --full status xvfb-browser.service || true
  fi
}

install_xvfb_service

# Restart panel if present so it picks up .env.panel + display
if systemctl list-unit-files 2>/dev/null | grep -q browser-automation-panel.service; then
  # Unit files may have been rewritten above (xvfb) or by prior upgrades —
  # always daemon-reload before restart to silence "unit file changed on disk".
  log "systemctl daemon-reload (before panel restart)"
  systemctl daemon-reload
  if [[ -f /etc/systemd/system/browser-automation-panel.service ]] \
    || [[ -f /lib/systemd/system/browser-automation-panel.service ]]; then
    systemctl enable browser-automation-panel.service 2>/dev/null || true
  fi
  log "restarting browser-automation-panel"
  systemctl restart browser-automation-panel.service || true
fi

# ---------------------------------------------------------------------------
# Summary / verify
# ---------------------------------------------------------------------------
log "======== verify ========"
echo "Chrome:     $CHROME_PATH"
"$CHROME_PATH" --version 2>/dev/null || true
echo "DISPLAY:    $DISPLAY_NUM  (panel uses :1.0 → Xvfb :1)"
echo "Xvfb unit:  $(systemctl is-active xvfb-browser.service 2>/dev/null || echo unknown) / enabled=$(systemctl is-enabled xvfb-browser.service 2>/dev/null || echo unknown)"
pgrep -a Xvfb 2>/dev/null || echo "Xvfb process: (not listed)"
echo "User:       $BROWSER_USER"
echo "Work dir:   $BROWSER_WORK"
echo "Env file:   $ENV_FILE"
python3 - <<'PY'
import importlib
mods = [
  "DrissionPage", "seleniumbase", "selenium", "playwright",
  "pyrogram", "PIL", "requests", "speech_recognition", "pydub",
]
for m in mods:
  try:
    mod = importlib.import_module(m if m != "PIL" else "PIL")
    ver = getattr(mod, "__version__", "?")
    print(f"  OK  {m} {ver}")
  except Exception as e:
    print(f"  FAIL {m}: {e}")
PY

log "done."
log "Notes:"
log "  - Xvfb runs as systemd service xvfb-browser (always-on :1). Do not start Xvfb manually."
log "  - Only system Chrome is used; Playwright browsers were NOT downloaded."
log "  - Python packages are system-wide (pip --break-system-packages), not venv."
log "  - Vision / captcha API keys are configured in the panel when needed."
log "  - Set TG_API_ID / TG_API_HASH / session on tasks that use Telegram login."
log "  - If panel was already running, confirm global Chrome path = $CHROME_PATH"
log "  - Xvfb: systemctl status xvfb-browser | journalctl -u xvfb-browser -n 30"
