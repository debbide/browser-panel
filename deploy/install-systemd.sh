#!/usr/bin/env bash
# Install Xvfb + panel as system services (run on the server as root).
# Usage: bash deploy/install-systemd.sh
set -euo pipefail

ROOT="${PANEL_ROOT:-/opt/browser-panel}"
if [[ ! -f "$ROOT/server/index.js" ]]; then
  echo "Panel not found at $ROOT" >&2
  exit 1
fi

# Resolve node binary
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "node not found in PATH" >&2
  exit 1
fi
if [[ ! -x /usr/bin/Xvfb ]]; then
  echo "Xvfb not installed (apt install xvfb)" >&2
  exit 1
fi
if [[ ! -x /usr/bin/google-chrome-stable && ! -x /usr/bin/google-chrome ]]; then
  echo "warn: google-chrome-stable not found; set BROWSER_CHROME_PATH in .env.panel"
fi

# .env.panel
if [[ ! -f "$ROOT/.env.panel" ]]; then
  if [[ -f "$ROOT/deploy/env.panel.example" ]]; then
    cp "$ROOT/deploy/env.panel.example" "$ROOT/.env.panel"
    echo "Created $ROOT/.env.panel — edit BROWSER_USER / proxy if needed"
  else
    cat >"$ROOT/.env.panel" <<EOF
PORT=3210
HOST=0.0.0.0
BROWSER_DISPLAY=:1.0
BROWSER_CHROME_PATH=/usr/bin/google-chrome-stable
BROWSER_USER=browser
BROWSER_WORK_DIR=/home/browser/browser-work
EOF
  fi
fi

# Ensure browser user + work dir (generic defaults from .env)
# shellcheck disable=SC1090
set -a
# only export simple KEY=VAL lines
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" =~ ^[[:space:]]*$ ]] && continue
  export "$line" 2>/dev/null || true
done <"$ROOT/.env.panel"
set +a

BU="${BROWSER_USER:-browser}"
BW="${BROWSER_WORK_DIR:-/home/${BU}/browser-work}"
if ! id -u "$BU" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$BU" || true
  echo "Created user $BU"
fi
mkdir -p "$BW/persistent" "$BW/screenshots" "$BW/task-results"
chown -R "$BU:$BU" "$(getent passwd "$BU" | cut -d: -f6)" 2>/dev/null || chown -R "$BU:$BU" "$BW"

# Write unit files with absolute node path
install -m 644 "$ROOT/deploy/xvfb-browser.service" /etc/systemd/system/xvfb-browser.service

sed "s|ExecStart=.*node server/index.js|ExecStart=${NODE_BIN} server/index.js|" \
  "$ROOT/deploy/browser-automation-panel.service" \
  > /etc/systemd/system/browser-automation-panel.service
# ensure WorkingDirectory
sed -i "s|^WorkingDirectory=.*|WorkingDirectory=${ROOT}|" /etc/systemd/system/browser-automation-panel.service
sed -i "s|^EnvironmentFile=.*|EnvironmentFile=-${ROOT}/.env.panel|" /etc/systemd/system/browser-automation-panel.service

systemctl daemon-reload
systemctl enable xvfb-browser.service browser-automation-panel.service
systemctl restart xvfb-browser.service
sleep 1
systemctl restart browser-automation-panel.service
sleep 1
systemctl --no-pager --full status xvfb-browser.service browser-automation-panel.service || true

echo
echo "Done."
echo "  Panel:  http://0.0.0.0:3210  (open firewall/security group)"
echo "  Logs:   journalctl -u browser-automation-panel -f"
echo "  Env:    ${ROOT}/.env.panel"
echo "  Stop:   systemctl stop browser-automation-panel xvfb-browser"
