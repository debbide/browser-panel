#!/usr/bin/env bash
# Quick install for browser-automation-panel on Linux VPS (x86_64 / aarch64).
# Usage:
#   curl -fsSL ... | bash          # if hosted
#   bash scripts/install.sh
#   bash scripts/install.sh --with-sb --with-playwright --port 3210
set -euo pipefail

APP_NAME="browser-automation-panel"
DEFAULT_ROOT="/opt/${APP_NAME}"
BROWSER_USER="${BROWSER_USER:-abc61154321}"
APP_PORT="${APP_PORT:-3210}"
INSTALL_SB=0
INSTALL_PW=0
SKIP_SYSTEMD=0
SKIP_BROWSER=0
APP_ROOT=""

log()  { echo -e "\033[1;32m[install]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
err()  { echo -e "\033[1;31m[error]\033[0m $*" >&2; }

usage() {
  cat <<'EOF'
Usage: bash scripts/install.sh [options]

Options:
  --root DIR           Install / use project at DIR (default: current repo or /opt/browser-automation-panel)
  --user NAME          Browser Linux user (default: abc61154321)
  --port N             Panel port (default: 3210)
  --with-sb            Also install SeleniumBase (x86 recommended)
  --with-playwright    Also install Playwright (node + python browsers)
  --skip-systemd       Do not install systemd unit
  --skip-browser       Skip Chrome/Chromium + Xvfb setup
  -h, --help           Show help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) APP_ROOT="$2"; shift 2 ;;
    --user) BROWSER_USER="$2"; shift 2 ;;
    --port) APP_PORT="$2"; shift 2 ;;
    --with-sb) INSTALL_SB=1; shift ;;
    --with-playwright) INSTALL_PW=1; shift ;;
    --skip-systemd) SKIP_SYSTEMD=1; shift ;;
    --skip-browser) SKIP_BROWSER=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown option: $1"; usage; exit 1 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  err "Please run as root (sudo)."
  exit 1
fi

# Resolve project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
if [[ -z "${APP_ROOT}" ]]; then
  if [[ -f "${REPO_ROOT}/package.json" && -d "${REPO_ROOT}/server" ]]; then
    APP_ROOT="${REPO_ROOT}"
  else
    APP_ROOT="${DEFAULT_ROOT}"
  fi
fi

ARCH="$(uname -m)"
log "Arch=${ARCH}  root=${APP_ROOT}  browser_user=${BROWSER_USER}  port=${APP_PORT}"

# ---------- packages ----------
export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then
  log "Installing system packages (apt)..."
  apt-get update -y
  apt-get install -y \
    ca-certificates curl git build-essential python3 python3-pip python3-venv \
    pkg-config libsqlite3-dev \
    xvfb xauth fonts-liberation fonts-noto-cjk \
    unzip
  # Node 20 if missing / too old
  if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v//;s/\..*//')" -lt 18 ]]; then
    log "Installing Node.js 20.x..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
elif command -v dnf >/dev/null 2>&1; then
  log "Installing system packages (dnf)..."
  dnf install -y gcc-c++ make python3 python3-pip git sqlite-devel \
    xorg-x11-server-Xvfb xauth curl unzip
  if ! command -v node >/dev/null 2>&1; then
    warn "Please install Node.js >= 18 manually on this distro."
  fi
else
  warn "Unknown package manager. Install node>=18 python3 git build tools yourself."
fi

command -v node >/dev/null 2>&1 || { err "node not found"; exit 1; }
command -v npm >/dev/null 2>&1 || { err "npm not found"; exit 1; }
command -v python3 >/dev/null 2>&1 || { err "python3 not found"; exit 1; }

log "node=$(node -v)  npm=$(npm -v)  python3=$(python3 --version 2>&1)"

# ---------- browser user & dirs ----------
if ! id -u "${BROWSER_USER}" >/dev/null 2>&1; then
  log "Creating browser user: ${BROWSER_USER}"
  useradd -m -s /bin/bash "${BROWSER_USER}" || true
fi
BROWSER_HOME="$(getent passwd "${BROWSER_USER}" | cut -d: -f6)"
WORK_DIR="${BROWSER_HOME}/browser-work"
mkdir -p \
  "${WORK_DIR}/persistent" \
  "${WORK_DIR}/screenshots" \
  "${WORK_DIR}/task-results" \
  "${WORK_DIR}/node_modules" \
  "${APP_ROOT}/data" \
  "${APP_ROOT}/logs" \
  "${APP_ROOT}/screenshots" \
  "${APP_ROOT}/runtime-data"
chown -R "${BROWSER_USER}:${BROWSER_USER}" "${BROWSER_HOME}"
# panel process (often root) writes runtime-data; browser user needs read scripts copied into work dir
chmod 755 "${BROWSER_HOME}" "${WORK_DIR}" || true

# ---------- Chromium / Chrome ----------
CHROME_PATH=""
if [[ "${SKIP_BROWSER}" -eq 0 ]]; then
  log "Installing browser (Chromium preferred for ARM)..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get install -y chromium-browser 2>/dev/null || apt-get install -y chromium 2>/dev/null || true
    # Google Chrome only on amd64 usually
    if [[ "${ARCH}" == "x86_64" ]] && ! command -v google-chrome >/dev/null 2>&1; then
      warn "Optional: install google-chrome manually if you prefer it over chromium."
    fi
  fi
  for c in google-chrome google-chrome-stable chromium-browser chromium; do
    if command -v "$c" >/dev/null 2>&1; then
      CHROME_PATH="$(command -v "$c")"
      break
    fi
  done
  # snap chromium path
  if [[ -z "${CHROME_PATH}" && -x /snap/bin/chromium ]]; then
    CHROME_PATH=/snap/bin/chromium
  fi
  if [[ -z "${CHROME_PATH}" ]]; then
    warn "No Chrome/Chromium found. Set BROWSER_CHROME_PATH later."
    CHROME_PATH="/usr/bin/chromium-browser"
  else
    log "Chrome path: ${CHROME_PATH}"
  fi

  # Xvfb display :1 for non-headless automation
  log "Configuring Xvfb on display :1 ..."
  cat >/etc/systemd/system/xvfb-browser.service <<EOF
[Unit]
Description=Xvfb for browser automation (:1)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/Xvfb :1 -screen 0 1440x900x24 -ac +extension GLX +render -noreset
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now xvfb-browser.service || warn "Failed to start Xvfb service"

  # Xauthority for browser user (loose cookie for :1)
  if command -v xauth >/dev/null 2>&1; then
    COOKIE="$(mcookie 2>/dev/null || openssl rand -hex 16)"
    su - "${BROWSER_USER}" -c "touch ~/.Xauthority; xauth remove :1 2>/dev/null || true; xauth add :1 . ${COOKIE}" || true
  fi
fi

# ---------- Node deps ----------
cd "${APP_ROOT}"
if [[ ! -f package.json ]]; then
  err "package.json not found in ${APP_ROOT}. Clone the repo first."
  exit 1
fi

log "npm install..."
npm install --omit=dev

# Node binary for browser user (launcher expects /tmp/node-openclaw)
NODE_BIN="$(command -v node)"
cp -f "${NODE_BIN}" /tmp/node-openclaw
chmod 755 /tmp/node-openclaw
# also keep a copy under work dir
cp -f "${NODE_BIN}" "${WORK_DIR}/node" || true
chown "${BROWSER_USER}:${BROWSER_USER}" "${WORK_DIR}/node" 2>/dev/null || true

# Link node_modules into browser-work for JS browser tasks
if [[ -d "${APP_ROOT}/node_modules" ]]; then
  rm -rf "${WORK_DIR}/node_modules"
  ln -sfn "${APP_ROOT}/node_modules" "${WORK_DIR}/node_modules"
fi

# ---------- Python venv (panel task-runner uses .venv/bin/python for foreground) ----------
log "Creating Python venv + DP deps..."
python3 -m venv "${APP_ROOT}/.venv"
# shellcheck disable=SC1091
source "${APP_ROOT}/.venv/bin/activate"
pip install -U pip setuptools wheel
if [[ -f "${APP_ROOT}/requirements-dp.txt" ]]; then
  pip install -r "${APP_ROOT}/requirements-dp.txt"
else
  pip install DrissionPage requests Pillow urllib3
fi

if [[ "${INSTALL_PW}" -eq 1 ]]; then
  log "Installing Playwright (python + browsers)..."
  if [[ -f "${APP_ROOT}/requirements-playwright.txt" ]]; then
    pip install -r "${APP_ROOT}/requirements-playwright.txt"
  else
    pip install playwright
  fi
  python -m playwright install chromium || warn "playwright install chromium failed"
  npx playwright install chromium || warn "npx playwright install failed"
fi

if [[ "${INSTALL_SB}" -eq 1 ]]; then
  if [[ "${ARCH}" == "aarch64" || "${ARCH}" == "arm64" ]]; then
    warn "ARM detected: SeleniumBase/ChromeDriver often broken. Installing anyway..."
  fi
  log "Installing SeleniumBase..."
  if [[ -f "${APP_ROOT}/requirements-sb.txt" ]]; then
    pip install -r "${APP_ROOT}/requirements-sb.txt"
  else
    pip install seleniumbase selenium requests
  fi
  python -m seleniumbase install chromedriver || warn "chromedriver install failed (expected on some ARM)"
fi

# System python3 packages for su browser-user path (launcher uses /usr/bin/python3)
log "Installing DP packages for system python3 (browser su path)..."
python3 -m pip install --break-system-packages -U pip setuptools wheel 2>/dev/null || python3 -m pip install -U pip setuptools wheel
if [[ -f "${APP_ROOT}/requirements-dp.txt" ]]; then
  python3 -m pip install --break-system-packages -r "${APP_ROOT}/requirements-dp.txt" 2>/dev/null \
    || python3 -m pip install -r "${APP_ROOT}/requirements-dp.txt"
else
  python3 -m pip install --break-system-packages DrissionPage requests Pillow 2>/dev/null \
    || python3 -m pip install DrissionPage requests Pillow
fi
if [[ "${INSTALL_SB}" -eq 1 ]]; then
  python3 -m pip install --break-system-packages seleniumbase selenium 2>/dev/null || true
fi

deactivate || true

# ---------- env file ----------
ENV_FILE="${APP_ROOT}/.env.panel"
cat >"${ENV_FILE}" <<EOF
PORT=${APP_PORT}
HOST=0.0.0.0
BROWSER_USER=${BROWSER_USER}
BROWSER_DISPLAY=:1.0
BROWSER_XAUTHORITY=${BROWSER_HOME}/.Xauthority
BROWSER_USER_DATA_DIR=${WORK_DIR}/persistent
BROWSER_CHROME_PATH=${CHROME_PATH:-/usr/bin/chromium-browser}
BROWSER_LOCALE=zh-CN
BROWSER_TIMEZONE=Asia/Shanghai
# BROWSER_PROXY=socks5://127.0.0.1:1080
EOF
log "Wrote ${ENV_FILE}"

# ---------- systemd ----------
if [[ "${SKIP_SYSTEMD}" -eq 0 ]] && command -v systemctl >/dev/null 2>&1; then
  log "Installing systemd service..."
  SERVICE_PATH="/etc/systemd/system/${APP_NAME}.service"
  cat >"${SERVICE_PATH}" <<EOF
[Unit]
Description=Browser Automation Panel
After=network.target xvfb-browser.service
Wants=xvfb-browser.service

[Service]
Type=simple
WorkingDirectory=${APP_ROOT}
EnvironmentFile=-${ENV_FILE}
ExecStart=$(command -v node) server/index.js
Restart=on-failure
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "${APP_NAME}.service"
  systemctl restart "${APP_NAME}.service"
  sleep 1
  systemctl --no-pager --full status "${APP_NAME}.service" || true
else
  warn "Skipping systemd. Start manually:"
  echo "  cd ${APP_ROOT} && set -a && source .env.panel && set +a && node server/index.js"
fi

# ---------- summary ----------
IP_HINT="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

============================================================
 ${APP_NAME} install finished
============================================================
 Project:     ${APP_ROOT}
 Panel:       http://${IP_HINT:-SERVER_IP}:${APP_PORT}
 Browser user:${BROWSER_USER}
 Work dir:    ${WORK_DIR}
 Chrome:      ${CHROME_PATH:-'(set BROWSER_CHROME_PATH)'}
 Display:     :1 (Xvfb)
 Env file:    ${ENV_FILE}

 Next steps:
  1) Open panel → 全局配置 → 变量与密钥 (VISION_*, etc.)
  2) 任务 → 临时配置 + 代理 socks5://127.0.0.1:YOUR_PORT
  3) Import scripts under tasks/

 Useful commands:
  systemctl status ${APP_NAME}
  systemctl restart ${APP_NAME}
  journalctl -u ${APP_NAME} -f
  systemctl status xvfb-browser

 Notes:
  - ARM: use DrissionPage tasks; avoid SeleniumBase unless you know it works
  - Browser tasks run via: su ${BROWSER_USER}
  - Default proxy in config.js is only a fallback; prefer task/global env
============================================================
EOF
