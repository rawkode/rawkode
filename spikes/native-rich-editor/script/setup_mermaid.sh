#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS_DIR="$PROJECT_ROOT/.tools"
VERSION="11.17.2"
# SHA-512 integrity from https://registry.npmjs.org/mermaid/11.17.2
INTEGRITY="V6K3C8EBdEsPFZXSKMJe6ppQOENxuHARr9GvHX4hh47lAbhMRD9qf4oEK7LoaRQxULMa80/qt5gHO73aCleBBg=="
if [[ -f "$TOOLS_DIR/mermaid.min.js" && -f "$TOOLS_DIR/MERMAID-LICENSE.txt" && -f "$TOOLS_DIR/mermaid-$VERSION.ready" ]]; then
  exit 0
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/native-note-mermaid.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
ARCHIVE="$WORK_DIR/mermaid.tgz"
curl --fail --location --silent --show-error --retry 2 \
  "https://registry.npmjs.org/mermaid/-/mermaid-$VERSION.tgz" --output "$ARCHIVE"
ACTUAL_INTEGRITY="$(openssl dgst -sha512 -binary "$ARCHIVE" | openssl base64 -A)"
if [[ "$ACTUAL_INTEGRITY" != "$INTEGRITY" ]]; then
  echo "Mermaid download integrity mismatch; refusing to install." >&2
  exit 1
fi
tar -xzf "$ARCHIVE" -C "$WORK_DIR" package/dist/mermaid.min.js package/LICENSE
mkdir -p "$TOOLS_DIR"
install -m 644 "$WORK_DIR/package/dist/mermaid.min.js" "$TOOLS_DIR/mermaid.min.js"
install -m 644 "$WORK_DIR/package/LICENSE" "$TOOLS_DIR/MERMAID-LICENSE.txt"
touch "$TOOLS_DIR/mermaid-$VERSION.ready"
echo "Mermaid $VERSION ready in .tools (integrity verified)."
