#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$APP_DIR/dist.noindex"
TARGET="/Applications/FileTrans.app"
LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

DMG="$(ls -t "$OUTPUT_DIR"/*.dmg 2>/dev/null | head -1 || true)"
if [ -z "$DMG" ]; then
  echo "未找到 dmg，请先运行: npm run package:mac" >&2
  exit 1
fi

if pgrep -f "$TARGET/Contents/MacOS/" >/dev/null 2>&1; then
  osascript -e 'tell application "FileTrans" to quit' >/dev/null 2>&1 || true
  sleep 1
  pkill -f "$TARGET/Contents/MacOS/" 2>/dev/null || true
fi

MOUNT_DIR="$(mktemp -d)"
cleanup() {
  hdiutil detach "$MOUNT_DIR" >/dev/null 2>&1 || true
  rmdir "$MOUNT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

diskutil image attach --mountOptions nobrowse --readOnly --mountPoint "$MOUNT_DIR" "$DMG" >/dev/null

if [ ! -d "$MOUNT_DIR/FileTrans.app" ]; then
  echo "dmg 中未找到 FileTrans.app: $DMG" >&2
  exit 1
fi

rm -rf "$TARGET"
ditto "$MOUNT_DIR/FileTrans.app" "$TARGET"
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true
"$LSREG" -f "$TARGET" >/dev/null 2>&1 || true

echo "已安装: ${TARGET}（来源: ${DMG}）"
