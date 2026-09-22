#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-run}"
BUILD_DIR="${APSIDES_BUILD_DIR:-$ROOT_DIR/DerivedData}"
mkdir -p "$BUILD_DIR"
BUILD_DIR="$(cd "$BUILD_DIR" && pwd -P)"
APP_BUNDLE="$BUILD_DIR/Build/Products/Debug/Enchiridion.app"
if [[ "$MODE" != run && "$MODE" != --verify && "$MODE" != --debug && "$MODE" != --logs && "$MODE" != --telemetry ]]; then
  echo "Usage: $0 [run|--verify|--debug|--logs|--telemetry]" >&2
  exit 2
fi
while IFS= read -r app_pid; do
  app_command="$(ps -p "$app_pid" -o comm= 2>/dev/null || true)"
  if [[ "$app_command" == "$APP_BUNDLE/Contents/MacOS/Enchiridion" ]]; then
    kill "$app_pid" 2>/dev/null || true
  fi
done < <(pgrep -x Enchiridion || true)
xcodegen generate --spec "$ROOT_DIR/project.yml"
xcodebuild -project "$ROOT_DIR/Apsides.xcodeproj" -scheme ApsidesMac -derivedDataPath "$BUILD_DIR" CODE_SIGNING_ALLOWED=NO build
codesign --force --deep --sign - "$APP_BUNDLE"
if [[ "$MODE" == --debug ]]; then
  lldb -- "$APP_BUNDLE/Contents/MacOS/Enchiridion"
else
  open -n "$APP_BUNDLE"
  case "$MODE" in
    --verify)
      sleep 1
      found_app=no
      while IFS= read -r app_pid; do
        app_command="$(ps -p "$app_pid" -o comm= 2>/dev/null || true)"
        if [[ "$app_command" == "$APP_BUNDLE/Contents/MacOS/Enchiridion" ]]; then found_app=yes; fi
      done < <(pgrep -x Enchiridion || true)
      [[ "$found_app" == yes ]]
      ;;
    --logs) /usr/bin/log stream --info --style compact --predicate 'process == "Enchiridion"' ;;
    --telemetry) /usr/bin/log stream --info --style compact --predicate 'subsystem == "rawkode.academy.enchiridion.mac"' ;;
  esac
fi
