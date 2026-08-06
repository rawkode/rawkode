#!/bin/sh
set -eu

package_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/enchiridion-protocol-consumer.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT

swiftc -emit-library -emit-module -module-name EnchiridionProtocol \
  -emit-module-path "$temporary_directory/EnchiridionProtocol.swiftmodule" \
  "$package_root/generated/swift/EnchiridionProtocol.swift" \
  -o "$temporary_directory/libEnchiridionProtocol.dylib"
swiftc -parse-as-library -I "$temporary_directory" -L "$temporary_directory" -lEnchiridionProtocol \
  "$package_root/tests/ProtocolConsumer.swift" \
  -o "$temporary_directory/ProtocolConsumer"
DYLD_LIBRARY_PATH="$temporary_directory" "$temporary_directory/ProtocolConsumer"
