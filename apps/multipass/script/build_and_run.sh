#!/usr/bin/env bash
set -euo pipefail
MODE="${1:-run}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="$ROOT_DIR/dist/Multipass.app"
case "$MODE" in
  run|--build|--debug|--logs|--telemetry|--verify) ;;
  *) echo "usage: $0 [--build|--debug|--logs|--telemetry|--verify]" >&2; exit 2 ;;
esac
cd "$ROOT_DIR"
if [[ "$MODE" != --build ]]; then pkill -x Multipass >/dev/null 2>&1 || true; fi
swift build
BUILD_BINARY="$(swift build --show-bin-path)/Multipass"
mkdir -p "$APP_BUNDLE/Contents/MacOS"
cp "$BUILD_BINARY" "$APP_BUNDLE/Contents/MacOS/Multipass"
cp Resources/Info.plist "$APP_BUNDLE/Contents/Info.plist"
codesign --force --sign "${MULTIPASS_SIGNING_IDENTITY:--}" "$APP_BUNDLE"
case "$MODE" in
  --build) echo "$APP_BUNDLE" ;;
  --debug) lldb -- "$APP_BUNDLE/Contents/MacOS/Multipass" ;;
  --logs|--telemetry)
    open -n "$APP_BUNDLE"
    /usr/bin/log stream --info --style compact --predicate 'process == "Multipass"'
    ;;
  --verify)
    swift test
    codesign --verify --strict "$APP_BUNDLE"
    open -n "$APP_BUNDLE"
    sleep 1
    pgrep -x Multipass >/dev/null
    ;;
  run) open -n "$APP_BUNDLE" ;;
esac
