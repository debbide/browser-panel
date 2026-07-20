#!/usr/bin/env bash
# 兼容：转调 bp.sh（装过则升级并重启）
export PANEL_ROOT="${PANEL_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
exec bash "$(cd "$(dirname "$0")" && pwd)/bp.sh" "$@"
