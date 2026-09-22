#!/usr/bin/env bash
set -euo pipefail
APPLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_DIR="${ENCHIRIDION_CHECK_DIR:-$APPLE_ROOT/DerivedData/Checks}"
python3 -m unittest discover -s "$APPLE_ROOT/script" -p 'test_*.py'
bash "$APPLE_ROOT/script/test_task_projection.sh"
xcodegen generate --spec "$APPLE_ROOT/project.yml"
swift test --package-path "$APPLE_ROOT" --scratch-path "$CHECK_DIR/Core"
xcodebuild -project "$APPLE_ROOT/Enchiridion.xcodeproj" -scheme EnchiridionMac \
  -derivedDataPath "$CHECK_DIR/Mac" CODE_SIGNING_ALLOWED=NO build
xcodebuild -project "$APPLE_ROOT/Enchiridion.xcodeproj" -scheme EnchiridionIOS \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath "$CHECK_DIR/iOS" \
  CODE_SIGNING_ALLOWED=NO build
if [[ -n "${ENCHIRIDION_TEST_SIMULATOR:-}" ]]; then
  xcodebuild -project "$APPLE_ROOT/Enchiridion.xcodeproj" -scheme EnchiridionIOS \
    -destination "platform=iOS Simulator,id=$ENCHIRIDION_TEST_SIMULATOR" \
    -derivedDataPath "$CHECK_DIR/iOS" CODE_SIGNING_ALLOWED=NO test
fi
