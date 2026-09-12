#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <iPhone UDID> <Watch UDID>" >&2
  exit 2
fi
APPLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${APSIDES_BUILD_DIR:-$APPLE_ROOT/DerivedData/Devices}"
xcodegen generate --spec "$APPLE_ROOT/project.yml"
xcodebuild -project "$APPLE_ROOT/Apsides.xcodeproj" -scheme ApsidesIOS \
  -destination 'generic/platform=iOS' -derivedDataPath "$BUILD_DIR" \
  CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates build
python3 "$APPLE_ROOT/script/verify_device_build.py" \
  "$BUILD_DIR/Build/Products/Debug-iphoneos/Enchiridion.app" --iphone "$1" --watch "$2"
