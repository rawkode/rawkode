#!/usr/bin/env bash
set -euo pipefail
APPLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_DIR="${APSIDES_CHECK_DIR:-$APPLE_ROOT/DerivedData/Checks}"
python3 -m unittest discover -s "$APPLE_ROOT/script" -p 'test_*.py'
xcodegen generate --spec "$APPLE_ROOT/project.yml"
swift test --package-path "$APPLE_ROOT" --scratch-path "$CHECK_DIR/Core"
xcodebuild -project "$APPLE_ROOT/Apsides.xcodeproj" -scheme ApsidesMac \
  -derivedDataPath "$CHECK_DIR/Mac" CODE_SIGNING_ALLOWED=NO build
xcodebuild -project "$APPLE_ROOT/Apsides.xcodeproj" -scheme ApsidesIOS \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath "$CHECK_DIR/iOS" \
  CODE_SIGNING_ALLOWED=NO build
if [[ -n "${APSIDES_TEST_SIMULATOR:-}" ]]; then
  xcodebuild -project "$APPLE_ROOT/Apsides.xcodeproj" -scheme ApsidesIOS \
    -destination "platform=iOS Simulator,id=$APSIDES_TEST_SIMULATOR" \
    -derivedDataPath "$CHECK_DIR/iOS" CODE_SIGNING_ALLOWED=NO test
fi
