#!/usr/bin/env bash
set -euo pipefail
MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
APP_NAME="NativeRichEditor"
BUNDLE_ID="dev.rawkode.NativeRichEditor"
APP_BUNDLE="$ROOT_DIR/dist/$APP_NAME.app"
case "$MODE" in run|--verify|--debug|--logs|--telemetry|--build) ;; *) echo "Usage: $0 [--build|--verify|--debug|--logs|--telemetry]" >&2; exit 2 ;; esac
if [[ "$MODE" != "--build" ]]; then pkill -x "$APP_NAME" >/dev/null 2>&1 || true; fi
./script/setup_d2.sh
./script/setup_mermaid.sh
swift build
BUILD_DIR="$(swift build --show-bin-path)"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"
cp "$BUILD_DIR/$APP_NAME" "$APP_BUNDLE/Contents/MacOS/$APP_NAME"
cp Resources/Info.plist "$APP_BUNDLE/Contents/Info.plist"
cp .tools/d2 .tools/D2-LICENSE.txt .tools/D2-THIRD_PARTY_NOTICES.txt "$APP_BUNDLE/Contents/Resources/"
cp .tools/mermaid.min.js .tools/MERMAID-LICENSE.txt "$APP_BUNDLE/Contents/Resources/"
.tools/d2 --theme=0 --dark-theme=200 --pad=24 Resources/sample.d2 "$APP_BUNDLE/Contents/Resources/sample.svg"
codesign --force --sign - "$APP_BUNDLE"
if [[ "$MODE" == "--build" ]]; then echo "Built $APP_BUNDLE"; exit 0; fi
if [[ "$MODE" == "--debug" ]]; then exec lldb -- "$APP_BUNDLE/Contents/MacOS/$APP_NAME"; fi
/usr/bin/open -n "$APP_BUNDLE"
case "$MODE" in
  --verify) sleep 1; pgrep -x "$APP_NAME"; ;;
  --logs) /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\"" ;;
  --telemetry) /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\"" ;;
esac
