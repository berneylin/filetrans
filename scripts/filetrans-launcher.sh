#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
UNPACKED="$APP_DIR/dist/linux-unpacked"
BIN="$UNPACKED/filetrans"

if [ ! -x "$BIN" ]; then
  echo "未找到打包产物: $BIN" >&2
  echo "请先在项目目录运行: npm run package:linux" >&2
  exit 1
fi

if [ -n "${DISPLAY:-}" ] && [ "${FILETRANS_OZONE:-}" != "wayland" ]; then
  export ELECTRON_OZONE_PLATFORM_HINT=x11
fi

ARGS=()
if [ -n "${DISPLAY:-}" ] && [ "${FILETRANS_OZONE:-}" != "wayland" ]; then
  ARGS+=(--ozone-platform=x11)
fi
SANDBOX_OWNER="$(stat -c '%u' "$UNPACKED/chrome-sandbox" 2>/dev/null || echo none)"
SANDBOX_MODE="$(stat -c '%a' "$UNPACKED/chrome-sandbox" 2>/dev/null || echo 0)"
if [ "$SANDBOX_OWNER" != "0" ] || [ "${SANDBOX_MODE:0:1}" != "4" ]; then
  ARGS+=(--no-sandbox)
fi

exec "$BIN" "${ARGS[@]}" "$@"
