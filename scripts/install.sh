#!/usr/bin/env bash
# 兼容：转调 bp.sh（一条命令安装/升级）
exec bash "$(cd "$(dirname "$0")" && pwd)/bp.sh" "$@"
