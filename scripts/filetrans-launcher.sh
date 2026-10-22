#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
UNPACKED="$(ls -dt "$APP_DIR"/dist.noindex/linux*-unpacked 2>/dev/null | head -1 || true)"
BIN="$UNPACKED/filetrans"

if [ -z "$UNPACKED" ] || [ ! -x "$BIN" ]; then
  echo "未找到打包产物（$APP_DIR/dist.noindex/linux*-unpacked）" >&2
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
if [ "$SANDBOX_OWNER" != "0" ] || [ ! -u "$UNPACKED/chrome-sandbox" ]; then
  ARGS+=(--no-sandbox)
fi

exec "$BIN" ${ARGS[@]+"${ARGS[@]}"} "$@"
