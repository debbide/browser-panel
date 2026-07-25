#!/usr/bin/env bash
# One-shot browser + system Python stack for browser-panel.
# - Single system Chrome (no Playwright-bundled browser)
# - Xvfb, fonts, xdotool, ffmpeg, etc.
# - System-wide pip (--break-system-packages): SB / DP / Playwright(py) / woiden&hax deps
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
# Google Chrome (single system browser) — no Playwright browser download
# ---------------------------------------------------------------------------
install_chrome() {
  if have google-chrome-stable || have google-chrome; then
    log "Chrome already present: $(command -v google-chrome-stable || command -v google-chrome)"
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
  fi

  if ! have google-chrome-stable && ! have google-chrome; then
    log "installing Chromium from apt"
    apt-get install -y chromium-browser 2>/dev/null \
      || apt-get install -y chromium 2>/dev/null \
      || die "could not install Chrome/Chromium"
  fi
}

install_chrome

resolve_chrome_path() {
  for c in \
    /usr/bin/google-chrome-stable \
    /usr/bin/google-chrome \
    /usr/bin/chromium-browser \
    /usr/bin/chromium \
    "$(command -v google-chrome-stable 2>/dev/null || true)" \
    "$(command -v google-chrome 2>/dev/null || true)" \
    "$(command -v chromium-browser 2>/dev/null || true)" \
    "$(command -v chromium 2>/dev/null || true)"
  do
    if [[ -n "$c" && -x "$c" ]]; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

CHROME_PATH="$(resolve_chrome_path || true)"
[[ -n "${CHROME_PATH:-}" ]] || die "Chrome/Chromium binary not found after install"
log "Chrome path: $CHROME_PATH"
"$CHROME_PATH" --version || true

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
# ---------------------------------------------------------------------------
mkdir -p "$ROOT"
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
  log "updating Chrome path in $ENV_FILE"
  touch "$ENV_FILE"
  set_kv() {
    local k="$1" v="$2"
    if grep -qE "^${k}=" "$ENV_FILE" 2>/dev/null; then
      sed -i "s|^${k}=.*|${k}=${v}|" "$ENV_FILE"
    else
      echo "${k}=${v}" >>"$ENV_FILE"
    fi
  }
  set_kv BROWSER_CHROME_PATH "$CHROME_PATH"
  set_kv PLAYWRIGHT_CHROME_PATH "$CHROME_PATH"
  set_kv BROWSER_DISPLAY "$DISPLAY_NUM"
  set_kv BROWSER_USER "$BROWSER_USER"
  set_kv BROWSER_HOME "$BROWSER_HOME"
  set_kv BROWSER_WORK_DIR "$BROWSER_WORK"
  set_kv BROWSER_XAUTHORITY "${BROWSER_HOME}/.Xauthority"
  set_kv PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD 1
fi

# ---------------------------------------------------------------------------
# System Python packages (NO venv) — forced system-wide
# Covers: SeleniumBase, DrissionPage, Playwright(py lib only),
#         woiden/hax: pyrogram, Pillow, speech audio, requests, ...
# ---------------------------------------------------------------------------
log "pip system packages (break-system-packages)"
python3 -m pip install --break-system-packages -U pip setuptools wheel || \
  python3 -m pip install -U pip setuptools wheel

# Core stacks
python3 -m pip install --break-system-packages -U \
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
  "numpy>=1.24.0" \
  || python3 -m pip install -U \
    requests urllib3 Pillow DrissionPage selenium seleniumbase playwright \
    pyrogram TgCrypto SpeechRecognition pydub numpy

# Prefer panel requirement files when present
if [[ -f "$ROOT/requirements-dp.txt" ]]; then
  python3 -m pip install --break-system-packages -U -r "$ROOT/requirements-dp.txt" || true
fi
if [[ -f "$ROOT/requirements-sb.txt" ]]; then
  python3 -m pip install --break-system-packages -U -r "$ROOT/requirements-sb.txt" || true
fi
if [[ -f "$ROOT/requirements-playwright.txt" ]]; then
  # Install package only — do NOT run playwright install chromium
  python3 -m pip install --break-system-packages -U -r "$ROOT/requirements-playwright.txt" || true
fi

# SeleniumBase chromedriver matching system Chrome (not a second browser)
log "seleniumbase install chromedriver (matches system Chrome)"
python3 -m seleniumbase install chromedriver 2>/dev/null \
  || log "WARN: seleniumbase install chromedriver failed (SB may still auto-fetch later)"

# Explicitly skip Playwright browser downloads
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export PLAYWRIGHT_BROWSERS_PATH=0
# Do not run: python3 -m playwright install

# ---------------------------------------------------------------------------
# Xvfb systemd unit (if panel deploy files exist)
# ---------------------------------------------------------------------------
if [[ -f "$ROOT/deploy/xvfb-browser.service" ]]; then
  log "installing xvfb-browser.service"
  install -m 644 "$ROOT/deploy/xvfb-browser.service" /etc/systemd/system/xvfb-browser.service
  systemctl daemon-reload
  systemctl enable xvfb-browser.service
  systemctl restart xvfb-browser.service || true
elif ! pgrep -a Xvfb >/dev/null 2>&1; then
  log "starting temporary Xvfb on ${DISPLAY_NUM%:*} (no unit file found)"
  # DISPLAY like :1.0 → :1
  dnum="${DISPLAY_NUM%%.*}"
  dnum="${dnum#:}"
  Xvfb ":${dnum}" -screen 0 1920x1080x24 >/tmp/Xvfb.log 2>&1 &
  sleep 1
fi

# Restart panel if present so it picks up .env.panel
if systemctl list-unit-files | grep -q browser-automation-panel.service; then
  log "restarting browser-automation-panel"
  systemctl restart browser-automation-panel.service || true
fi

# ---------------------------------------------------------------------------
# Summary / verify
# ---------------------------------------------------------------------------
log "======== verify ========"
echo "Chrome:     $CHROME_PATH"
"$CHROME_PATH" --version 2>/dev/null || true
echo "DISPLAY:    $DISPLAY_NUM"
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
log "  - Only system Chrome is used; Playwright browsers were NOT downloaded."
log "  - Python packages are system-wide (pip --break-system-packages), not venv."
log "  - Woiden/Hax need panel VISION_* + CAPTCHA_API_* for math/reCAPTCHA."
log "  - Set TG_API_ID / TG_API_HASH / session on the task for Telegram login."
log "  - If panel was already running, confirm global Chrome path = $CHROME_PATH"
