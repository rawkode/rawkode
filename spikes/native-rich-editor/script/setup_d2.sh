#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS_DIR="$PROJECT_ROOT/.tools"
VERSION="0.9.0"
case "$(uname -m)" in
  arm64)
    ARCH="arm64"
    SHA256="eaf6c0c143e56dd9fa97bfb6df25ea9c1ebce40245f056a0768cf1a6c15d3064"
    ;;
  x86_64)
    ARCH="amd64"
    SHA256="cad39576a480d6bb02ea142fef1726647914b0d2da51ccc9b30b660a2b1babf0"
    ;;
  *) echo "Unsupported macOS architecture" >&2; exit 1 ;;
esac

if [[ -x "$TOOLS_DIR/d2" && -f "$TOOLS_DIR/D2-LICENSE.txt" && -f "$TOOLS_DIR/D2-THIRD_PARTY_NOTICES.txt" ]]; then
  if [[ "$("$TOOLS_DIR/d2" --version)" == "v$VERSION" ]]; then
    exit 0
  fi
fi

# Digests pinned from the official immutable v0.9.0 release asset metadata:
# https://api.github.com/repos/d2lang/d2/releases/tags/v0.9.0
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/native-note-d2.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
ARCHIVE="$WORK_DIR/d2.tar.gz"
curl --fail --location --silent --show-error --retry 2 \
  "https://github.com/d2lang/d2/releases/download/v$VERSION/d2-v$VERSION-macos-$ARCH.tar.gz" \
  --output "$ARCHIVE"
ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$SHA256" ]]; then
  echo "D2 download checksum mismatch; refusing to install." >&2
  exit 1
fi
tar -xzf "$ARCHIVE" -C "$WORK_DIR"
mkdir -p "$TOOLS_DIR"
install -m 755 "$WORK_DIR/d2-v$VERSION/bin/d2" "$TOOLS_DIR/d2"
install -m 644 "$WORK_DIR/d2-v$VERSION/LICENSE.txt" "$TOOLS_DIR/D2-LICENSE.txt"
install -m 644 "$WORK_DIR/d2-v$VERSION/THIRD_PARTY_NOTICES.txt" "$TOOLS_DIR/D2-THIRD_PARTY_NOTICES.txt"
echo "D2 v$VERSION ready in .tools (checksum verified)."
