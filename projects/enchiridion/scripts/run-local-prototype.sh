#!/usr/bin/env bash

# Starts the working macOS prototype against the real local Vault Worker.
# This is intentionally local-only: the token is accepted solely by the
# loopback development auth path and is never a production credential.

set -euo pipefail

if [[ "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: ./scripts/run-local-prototype.sh

Starts a persistent local Vault Worker, builds the macOS app, and launches it
with its sync client pointed at that Worker. Quit the app to stop the Worker.

Optional environment variables:
  ENCHIRIDION_LOCAL_VAULT_PORT       defaults to 8787
  ENCHIRIDION_LOCAL_VAULT_TOKEN      defaults to a local prototype token
  ENCHIRIDION_LOCAL_VAULT_STATE_DIR  defaults to /private/tmp/enchiridion-vault-prototype-state
  ENCHIRIDION_LOCAL_STORE_PATH       defaults to /private/tmp/enchiridion-local-prototype.sqlite
  ENCHIRIDION_LOCAL_DERIVED_DATA     defaults to /private/tmp/enchiridion-local-prototype-derived-data
EOF
  exit 0
fi

if [[ $# -ne 0 ]]; then
  echo "unknown argument: $1 (try --help)" >&2
  exit 64
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
vault_port="${ENCHIRIDION_LOCAL_VAULT_PORT:-8787}"
vault_token="${ENCHIRIDION_LOCAL_VAULT_TOKEN:-enchiridion-local-prototype-token}"
vault_state_dir="${ENCHIRIDION_LOCAL_VAULT_STATE_DIR:-/private/tmp/enchiridion-vault-prototype-state}"
local_store_path="${ENCHIRIDION_LOCAL_STORE_PATH:-/private/tmp/enchiridion-local-prototype.sqlite}"
derived_data="${ENCHIRIDION_LOCAL_DERIVED_DATA:-/private/tmp/enchiridion-local-prototype-derived-data}"
vault_log="${ENCHIRIDION_LOCAL_VAULT_LOG_FILE:-/private/tmp/enchiridion-vault-prototype.log}"

export ENCHIRIDION_LOCAL_VAULT_URL="http://127.0.0.1:${vault_port}"
export ENCHIRIDION_LOCAL_VAULT_TOKEN="$vault_token"
export ENCHIRIDION_LOCAL_STORE_PATH="$local_store_path"

mkdir -p "$vault_state_dir"

(
  cd "$repo_root/workers/vault"
  exec bun run dev -- --local --port "$vault_port" --persist-to "$vault_state_dir" \
    --var "LOCAL_DEV_ACCESS_TOKEN:${vault_token}"
) >"$vault_log" 2>&1 &
vault_pid=$!

cleanup() {
  if kill -0 "$vault_pid" 2>/dev/null; then
    kill "$vault_pid" 2>/dev/null || true
    wait "$vault_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

ready_status=""
for _ in {1..100}; do
  ready_status="$(
    curl --connect-timeout 1 --max-time 1 --silent --output /dev/null --write-out '%{http_code}' \
      -H "X-Enchiridion-Local-Token: ${vault_token}" \
      "${ENCHIRIDION_LOCAL_VAULT_URL}/sync" || true
  )"
  if [[ "$ready_status" == "426" ]]; then
    break
  fi
  if ! kill -0 "$vault_pid" 2>/dev/null; then
    cat "$vault_log" >&2
    exit 1
  fi
  sleep 0.1
done

if [[ "$ready_status" != "426" ]]; then
  echo "local Vault did not become ready; see $vault_log" >&2
  exit 1
fi

echo "Local Vault ready at ${ENCHIRIDION_LOCAL_VAULT_URL} (state: ${vault_state_dir})"
echo "Vault log: ${vault_log}"

xcodebuild \
  -project "$repo_root/apps/swift/Enchiridion2.xcodeproj" \
  -scheme 'Enchiridion2 macOS' \
  -configuration Debug \
  -destination 'platform=macOS' \
  -derivedDataPath "$derived_data" \
  build CODE_SIGNING_ALLOWED=NO

app="$derived_data/Build/Products/Debug/Enchiridion2Mac.app"
if [[ ! -x "$app/Contents/MacOS/Enchiridion2Mac" ]]; then
  echo "macOS app was not produced at $app" >&2
  exit 1
fi

echo "Launching Enchiridion with local Vault sync enabled. Quit the app to stop the local Worker."
open --fresh --new --wait-apps \
  --env "ENCHIRIDION_LOCAL_VAULT_URL=${ENCHIRIDION_LOCAL_VAULT_URL}" \
  --env "ENCHIRIDION_LOCAL_VAULT_TOKEN=${ENCHIRIDION_LOCAL_VAULT_TOKEN}" \
  --env "ENCHIRIDION_LOCAL_STORE_PATH=${ENCHIRIDION_LOCAL_STORE_PATH}" \
  "$app"
