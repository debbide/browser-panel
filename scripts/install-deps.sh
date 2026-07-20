#!/usr/bin/env bash
# 兼容：只重装依赖时用 install.sh 已装过的目录再跑 npm/pip
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npm install --omit=dev
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip setuptools wheel
pip install -r requirements-dp.txt
deactivate || true
python3 -m pip install --break-system-packages -r requirements-dp.txt 2>/dev/null || true
echo "deps ok"
