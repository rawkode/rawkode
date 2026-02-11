#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_HOST="${RAWKO_RUNTIME_HOST:-127.0.0.1}"
RUNTIME_PORT="${RAWKO_RUNTIME_PORT:-8788}"
WEB_HOST="${WEB_HOST:-127.0.0.1}"
WEB_PORT="${WEB_PORT:-4321}"
RUNTIME_URL="${PUBLIC_RUNTIME_URL:-http://${RUNTIME_HOST}:${RUNTIME_PORT}}"

RUNTIME_PID=""
WEB_PID=""

cleanup() {
  if [[ -n "${RUNTIME_PID}" ]] && kill -0 "${RUNTIME_PID}" 2>/dev/null; then
    kill "${RUNTIME_PID}" 2>/dev/null || true
  fi

  if [[ -n "${WEB_PID}" ]] && kill -0 "${WEB_PID}" 2>/dev/null; then
    kill "${WEB_PID}" 2>/dev/null || true
  fi

  wait "${RUNTIME_PID}" 2>/dev/null || true
  wait "${WEB_PID}" 2>/dev/null || true
}

trap cleanup EXIT
trap 'cleanup; exit 0' INT TERM

(
  cd "${ROOT_DIR}"
  exec deno run -A --config runtime/deno.json runtime/src/main.ts \
    --host "${RUNTIME_HOST}" \
    --port "${RUNTIME_PORT}" \
    --no-stdin \
    --no-prewarm
) &
RUNTIME_PID="$!"

(
  cd "${ROOT_DIR}/web"
  export PUBLIC_RUNTIME_URL="${RUNTIME_URL}"
  exec deno task dev -- --host "${WEB_HOST}" --port "${WEB_PORT}"
) &
WEB_PID="$!"

echo "runtime: ${RUNTIME_URL}"
echo "web:     http://${WEB_HOST}:${WEB_PORT}"

set +e
exit_code=0
while true; do
  if ! kill -0 "${RUNTIME_PID}" 2>/dev/null; then
    wait "${RUNTIME_PID}"
    exit_code="$?"
    echo "runtime process exited (${exit_code})"
    break
  fi

  if ! kill -0 "${WEB_PID}" 2>/dev/null; then
    wait "${WEB_PID}"
    exit_code="$?"
    echo "web process exited (${exit_code})"
    break
  fi

  sleep 1
done
set -e

exit "${exit_code}"
