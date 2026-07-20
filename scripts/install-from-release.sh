#!/usr/bin/env bash
# 兼容旧链接 → install.sh
exec bash "$(cd "$(dirname "$0")" && pwd)/install.sh" "$@"
