#!/usr/bin/env sh
# Installs the native-messaging host manifest into Firefox's user-scoped
# host registry so the extension can talk to dl_helper.py.
#
# macOS users should override MANIFEST_DIR to:
#   ~/Library/Application Support/Mozilla/NativeMessagingHosts
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_PATH="$SCRIPT_DIR/dl_helper.py"
MANIFEST_DIR="${MANIFEST_DIR:-$HOME/.mozilla/native-messaging-hosts}"

if ! command -v yt-dlp >/dev/null 2>&1; then
  echo "Warning: yt-dlp not found on PATH. Install it before using the helper:"
  echo "  pip install --user yt-dlp     # or: pacman -S yt-dlp"
fi

chmod +x "$HOST_PATH"
mkdir -p "$MANIFEST_DIR"
sed "s|REPLACED_AT_INSTALL_TIME|$HOST_PATH|" \
  "$SCRIPT_DIR/download_to_index.dl_helper.json" \
  > "$MANIFEST_DIR/download_to_index.dl_helper.json"

echo "Installed to $MANIFEST_DIR/download_to_index.dl_helper.json"
echo "Host script: $HOST_PATH"
