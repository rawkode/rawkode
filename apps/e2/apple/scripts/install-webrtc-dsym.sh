#!/bin/bash
set -euo pipefail

# Run inside the app archive build, before Xcode Cloud prepares its distribution export.
if [[ "${ACTION:-}" != "install" ]]; then
  exit 0
fi

case "${PLATFORM_NAME:-}" in
  iphoneos) slice="ios-arm64" ;;
  macosx) slice="macos-x86_64_arm64" ;;
  *) echo "error: Unsupported WebRTC archive platform: ${PLATFORM_NAME:-missing}" >&2; exit 1 ;;
esac

version="153.0.0"
expected_sha256="147c6d00a747bd58dc865f44afd8866bc18d9000c3b7fb51b0c5884cb7f68214"
url="https://github.com/stasel/WebRTC/releases/download/${version}/WebRTC-M153-dSYM.zip"
: "${DWARF_DSYM_FOLDER_PATH:?Missing archive dSYM output directory}"
: "${TARGET_BUILD_DIR:?Missing app build directory}"
: "${FRAMEWORKS_FOLDER_PATH:?Missing embedded framework directory}"
: "${DERIVED_FILE_DIR:?Missing build cache directory}"
binary="${TARGET_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH}/WebRTC.framework/WebRTC"
[[ -f "$binary" ]] || { echo "error: Embedded WebRTC binary is missing before symbol packaging" >&2; exit 1; }

mkdir -p "$DERIVED_FILE_DIR"
work="$(mktemp -d "${TMPDIR:-/tmp}/ench-webrtc-symbols.XXXXXX")"
trap 'rm -rf "$work"' EXIT
archive="${WEBRTC_DSYM_ARCHIVE:-${DERIVED_FILE_DIR}/WebRTC-M153-dSYM.zip}"
if [[ ! -f "$archive" ]]; then
  if [[ -n "${WEBRTC_DSYM_ARCHIVE:-}" ]]; then
    echo "error: Explicit WebRTC symbol archive does not exist" >&2
    exit 1
  fi
  curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --connect-timeout 20 --max-time 300 --retry 2 --silent --show-error \
    --output "$work/download.zip" "$url"
  downloaded_sha256="$(shasum -a 256 "$work/download.zip" | awk '{print $1}')"
  [[ "$downloaded_sha256" == "$expected_sha256" ]] || { echo "error: WebRTC dSYM download checksum mismatch" >&2; exit 1; }
  mv "$work/download.zip" "$archive"
fi
actual_sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"
[[ "$actual_sha256" == "$expected_sha256" ]] || { echo "error: WebRTC dSYM archive checksum mismatch" >&2; exit 1; }

# Extract only the pinned platform directory, never arbitrary archive entries into build output.
unzip -q "$archive" "WebRTC-${slice}.dSYM/*" -d "$work"
symbols="$work/WebRTC-${slice}.dSYM"
dwarf="$symbols/Contents/Resources/DWARF/WebRTC"
[[ -f "$dwarf" ]] || { echo "error: WebRTC dSYM DWARF file is missing" >&2; exit 1; }
xcrun dwarfdump --uuid "$binary" | awk '{print $2, $3}' | sort > "$work/binary-uuids"
xcrun dwarfdump --uuid "$dwarf" | awk '{print $2, $3}' | sort > "$work/symbol-uuids"
[[ -s "$work/binary-uuids" ]] || { echo "error: Embedded WebRTC has no build UUID" >&2; exit 1; }
# macOS archives can thin a universal binary; every embedded architecture must match its original dSYM.
while IFS= read -r uuid; do
  grep -Fxq "$uuid" "$work/symbol-uuids" || { echo "error: WebRTC dSYM UUID does not match embedded binary: $uuid" >&2; exit 1; }
done < "$work/binary-uuids"
if [[ "$slice" == "ios-arm64" ]]; then
  cmp -s "$work/binary-uuids" "$work/symbol-uuids" || { echo "error: Unexpected iOS WebRTC dSYM architectures" >&2; exit 1; }
fi

mkdir -p "$DWARF_DSYM_FOLDER_PATH"
destination="$DWARF_DSYM_FOLDER_PATH/WebRTC.framework.dSYM"
# This output is owned by this build phase; never modify the embedded SDK binary or its signature.
rm -rf "$destination"
ditto "$symbols" "$destination"
echo "Included original WebRTC ${version} debug symbols in $DWARF_DSYM_FOLDER_PATH:"
cat "$work/binary-uuids"
