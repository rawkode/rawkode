#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="Enchiridion"
BUNDLE_ID="dev.rawkode.enchiridion"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_PATH="$ROOT_DIR/Enchiridion.xcodeproj"
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
elif [[ ! -d "$ROOT_DIR/Enchiridion.xcodeproj" ]]; then
  echo "xcodegen is required because Enchiridion.xcodeproj is missing" >&2
  exit 127
else
  echo "warning: xcodegen not found; using the existing Enchiridion.xcodeproj" >&2
fi

SIGNING_ARGS=(-allowProvisioningUpdates)
if [[ "${ENCHIRIDION_LOCAL_ONLY:-0}" == "1" ]]; then
  SIGNING_ARGS=(CODE_SIGNING_ALLOWED=NO CODE_SIGN_ENTITLEMENTS=)
fi

if ! xcodebuild \
  -quiet \
  -project "$PROJECT_PATH" \
  -scheme "Enchiridion macOS" \
  -configuration Debug \
  -derivedDataPath "$DERIVED_DATA" \
  -destination "platform=macOS" \
  "${SIGNING_ARGS[@]}" \
  build
then
  if [[ "${ENCHIRIDION_LOCAL_ONLY:-0}" != "1" ]]; then
    echo "Signed build failed. Fix the P4X-639 Ltd certificate/profile to enable iCloud sync." >&2
    echo "For an explicit unsigned local-only build, run: ENCHIRIDION_LOCAL_ONLY=1 $0 $MODE" >&2
  fi
  exit 1
fi

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
