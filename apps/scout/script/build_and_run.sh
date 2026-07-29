#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="Scout"
BUNDLE_ID="dev.rawkode.scout"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_PATH="$ROOT_DIR/Scout.xcodeproj"
DERIVED_DATA="$ROOT_DIR/.build/DerivedData"
APP_BUNDLE="$DERIVED_DATA/Build/Products/Debug/$APP_NAME.app"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/$APP_NAME"

if [[ -d /Applications/Xcode.app/Contents/Developer ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

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
elif [[ ! -d "$PROJECT_PATH" ]]; then
  echo "xcodegen is required because Scout.xcodeproj is missing" >&2
  exit 127
else
  echo "warning: xcodegen not found; using the existing Scout.xcodeproj" >&2
fi

SIGNING_ARGS=(-allowProvisioningUpdates)
if [[ "${SCOUT_UNSIGNED:-0}" == "1" ]]; then
  echo "warning: unsigned mode cannot verify App Sandbox or bookmarks" >&2
  SIGNING_ARGS=(CODE_SIGNING_ALLOWED=NO CODE_SIGN_ENTITLEMENTS=)
fi

xcodebuild \
  -quiet \
  -project "$PROJECT_PATH" \
  -scheme Scout \
  -configuration Debug \
  -derivedDataPath "$DERIVED_DATA" \
  -destination "platform=macOS" \
  "${SIGNING_ARGS[@]}" \
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
    xcodebuild \
      -quiet \
      -project "$PROJECT_PATH" \
      -scheme Scout \
      -configuration Debug \
      -derivedDataPath "$DERIVED_DATA" \
      -destination "platform=macOS" \
      "${SIGNING_ARGS[@]}" \
      test
    if [[ "${SCOUT_UNSIGNED:-0}" != "1" ]]; then
      codesign --verify --deep --strict "$APP_BUNDLE"
      codesign -d --entitlements - "$APP_BUNDLE" | grep -q "com.apple.security.app-sandbox"
      codesign -d --entitlements - "$APP_BUNDLE" | grep -q "com.apple.security.files.user-selected.read-write"
      codesign -d --entitlements - "$APP_BUNDLE" | grep -q "com.apple.security.files.bookmarks.app-scope"
    fi
    ;;
esac
