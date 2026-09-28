#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
ICON_SRC="$APP_DIR/build/icon.png"
ICON_NAME="filetrans"
DESKTOP_NAME="filetrans.desktop"
APPLICATIONS_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
LAUNCHER="$APP_DIR/scripts/filetrans-launcher.sh"

if [ ! -f "$ICON_SRC" ]; then
  echo "缺少图标: $ICON_SRC" >&2
  echo "请先运行: node scripts/generate-icon.mjs" >&2
  exit 1
fi

if [ ! -x "$LAUNCHER" ]; then
  chmod +x "$LAUNCHER"
fi

mkdir -p "$APPLICATIONS_DIR" "$ICON_DIR"
cp "$ICON_SRC" "$ICON_DIR/$ICON_NAME.png"

DESKTOP_FILE="$APPLICATIONS_DIR/$DESKTOP_NAME"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=FileTrans
GenericName=SFTP File Transfer
GenericName[zh_CN]=SFTP 文件传输
Comment=SSH/SFTP 双栏文件传输客户端
Comment[en]=Dual-pane SSH/SFTP file transfer client
Exec="$LAUNCHER"
Icon=$ICON_NAME
Terminal=false
Categories=Network;FileTransfer;Utility;
Keywords=sftp;ssh;file;transfer;ftp;
StartupNotify=true
StartupWMClass=filetrans
EOF
chmod +x "$DESKTOP_FILE"

if [ -d "$HOME/Desktop" ]; then
  cp "$DESKTOP_FILE" "$HOME/Desktop/FileTrans.desktop"
  chmod +x "$HOME/Desktop/FileTrans.desktop"
  gio set "$HOME/Desktop/FileTrans.desktop" metadata::trusted true 2>/dev/null || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPLICATIONS_DIR" 2>/dev/null || true
fi

echo "已创建应用入口:"
echo "  应用列表: $DESKTOP_FILE"
if [ -d "$HOME/Desktop" ]; then
  echo "  桌面图标: $HOME/Desktop/FileTrans.desktop"
fi
echo "运行前请确保已打包: npm run package:linux"
