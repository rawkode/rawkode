#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
MODE="${1:-run}"
case "$MODE" in run|--build|--verify) ;; *) echo "Usage: $0 [--build|--verify]" >&2; exit 2 ;; esac
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
if [[ ! -d ../web-rich-editor/node_modules ]]; then (cd ../web-rich-editor && npm ci); fi
node ../web-rich-editor/node_modules/vite/bin/vite.js build --config web/vite.config.mjs
swift build
BUILD_DIR="$(swift build --show-bin-path)"
APP_BUNDLE="$ROOT_DIR/dist/FieldnotesWeb.app"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"
cp "$BUILD_DIR/FieldnotesWeb" "$APP_BUNDLE/Contents/MacOS/FieldnotesWeb"
rsync -a --delete dist/web/ "$APP_BUNDLE/Contents/Resources/web/"
cat > "$APP_BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>FieldnotesWeb</string>
<key>CFBundleIdentifier</key><string>dev.rawkode.FieldnotesWeb</string>
<key>CFBundleName</key><string>Fieldnotes Web</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
codesign --force --sign - "$APP_BUNDLE"
if [[ "$MODE" == "--build" ]]; then echo "Built $APP_BUNDLE"; exit 0; fi
/usr/bin/open "$APP_BUNDLE"
if [[ "$MODE" == "--verify" ]]; then sleep 1; pgrep -x FieldnotesWeb; fi
