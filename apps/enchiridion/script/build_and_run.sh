#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="Enchiridion"
BUNDLE_ID="dev.rawkode.enchiridion"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DERIVED_DATA="$ROOT_DIR/.build/DerivedData"
APP_BUNDLE="$DERIVED_DATA/Build/Products/Debug/$APP_NAME.app"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/$APP_NAME"

case "$MODE" in
  run|--debug|debug|--logs|logs|--telemetry|telemetry|--verify|verify)
    ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac

pkill -x "$APP_NAME" >/dev/null 2>&1 || true

cd "$ROOT_DIR"
if command -v xcodegen >/dev/null 2>&1; then
  xcodegen generate
elif [[ ! -d "$ROOT_DIR/Enchiridion.xcodeproj" ]]; then
  echo "xcodegen is required because Enchiridion.xcodeproj is missing" >&2
  exit 127
else
  echo "warning: xcodegen not found; using the existing Enchiridion.xcodeproj" >&2
fi
xcodebuild \
  -quiet \
  -project Enchiridion.xcodeproj \
  -scheme "Enchiridion macOS" \
  -configuration Debug \
  -derivedDataPath "$DERIVED_DATA" \
  -destination "platform=macOS" \
  CODE_SIGNING_ALLOWED=NO \
  build

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    open_app
    sleep 1
    pgrep -x "$APP_NAME" >/dev/null
    ;;
esac
