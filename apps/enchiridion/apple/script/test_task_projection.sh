#!/usr/bin/env bash
set -euo pipefail
APPLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ench-task-projection.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
swiftc -module-cache-path "$TEST_DIR/ModuleCache" "$APPLE_ROOT/Sources/App/TaskModels.swift" "$APPLE_ROOT/Sources/App/TaskListProjection.swift" \
  "$APPLE_ROOT/Tools/TaskListProjectionTests.swift" -o "$TEST_DIR/task-projection-tests"
"$TEST_DIR/task-projection-tests"
