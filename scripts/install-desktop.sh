#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="$APP_DIR/dist.noindex"
INSTALL_DIR="$HOME/.local/opt/FileTrans"
APPLICATIONS_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
ICON_SRC="$APP_DIR/build/icon.png"
DESKTOP_NAME="filetrans.desktop"

UNPACKED="$(ls -dt "$OUTPUT_DIR"/linux*-unpacked 2>/dev/null | head -1 || true)"
if [ -z "$UNPACKED" ] || [ ! -x "$UNPACKED/filetrans" ]; then
  echo "未找到打包产物，请先运行: npm run package:linux" >&2
  exit 1
fi

if [ ! -f "$ICON_SRC" ]; then
  echo "缺少图标: $ICON_SRC，请先运行: node scripts/generate-icon.mjs" >&2
  exit 1
fi

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$APPLICATIONS_DIR" "$ICON_DIR"
cp -R "$UNPACKED/." "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/filetrans"
cp "$ICON_SRC" "$ICON_DIR/filetrans.png"

cat > "$INSTALL_DIR/run.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
ARGS=()
if [ -n "\${DISPLAY:-}" ] && [ "\${FILETRANS_OZONE:-}" != "wayland" ]; then
  ARGS+=(--ozone-platform=x11)
fi
SANDBOX_OWNER="\$(stat -c '%u' '$INSTALL_DIR/chrome-sandbox' 2>/dev/null || echo none)"
if [ "\$SANDBOX_OWNER" != "0" ] || [ ! -u '$INSTALL_DIR/chrome-sandbox' ]; then
  ARGS+=(--no-sandbox)
fi
exec "$INSTALL_DIR/filetrans" \${ARGS[@]+\"\${ARGS[@]}\"} "\$@"
EOF
chmod +x "$INSTALL_DIR/run.sh"

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
Exec="$INSTALL_DIR/run.sh"
Icon=filetrans
Terminal=false
Categories=Network;FileTransfer;Utility;
Keywords=sftp;ssh;file;transfer;ftp;
StartupNotify=true
StartupWMClass=filetrans
EOF
chmod +x "$DESKTOP_FILE"

rm -f "$HOME/Desktop/FileTrans.desktop"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPLICATIONS_DIR" 2>/dev/null || true
fi

echo "已安装: ${INSTALL_DIR}（来源: ${UNPACKED}）"
echo "应用入口: $DESKTOP_FILE"
