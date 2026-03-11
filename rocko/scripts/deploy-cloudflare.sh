#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE_DIR="${ROOT_DIR}/.cloudflare-stage"
BUN_BIN="${BUN_BIN:-$HOME/.bun/bin/bun}"
STUDIO_DIR="${STAGE_DIR}/.mastra/output/studio"

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env var: ${name}" >&2
    exit 1
  fi
}

prepare_studio_assets() {
  local public_origin="${ROCKO_PUBLIC_URL%/}"
  local protocol="${public_origin%%://*}"
  local authority="${public_origin#*://}"
  local host="${authority%%:*}"
  local port=""

  if [[ "$authority" == *:* ]]; then
    port="${authority##*:}"
  fi

  mkdir -p "$STUDIO_DIR"
  cp -R node_modules/mastra/dist/studio/. "$STUDIO_DIR/"

  STUDIO_DIR="$STUDIO_DIR" \
  MASTRA_SERVER_HOST="$host" \
  MASTRA_SERVER_PORT="$port" \
  MASTRA_SERVER_PROTOCOL="$protocol" \
  "$BUN_BIN" -e '
    import { readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";

    const studioDir = process.env.STUDIO_DIR;
    if (!studioDir) {
      throw new Error("STUDIO_DIR is required");
    }

    const replacements = new Map([
      ["%%MASTRA_TELEMETRY_DISABLED%%", ""],
      ["%%MASTRA_SERVER_HOST%%", process.env.MASTRA_SERVER_HOST ?? ""],
      ["%%MASTRA_SERVER_PORT%%", process.env.MASTRA_SERVER_PORT ?? ""],
      ["%%MASTRA_API_PREFIX%%", "/api"],
      ["%%MASTRA_HIDE_CLOUD_CTA%%", "true"],
      ["%%MASTRA_STUDIO_BASE_PATH%%", ""],
      ["%%MASTRA_SERVER_PROTOCOL%%", process.env.MASTRA_SERVER_PROTOCOL ?? "https"],
      ["%%MASTRA_CLOUD_API_ENDPOINT%%", ""],
      ["%%MASTRA_EXPERIMENTAL_FEATURES%%", "false"],
      ["%%MASTRA_AUTO_DETECT_URL%%", "true"],
      ["%%MASTRA_REQUEST_CONTEXT_PRESETS%%", ""],
    ]);

    const indexPath = join(studioDir, "index.html");
    let html = readFileSync(indexPath, "utf8");
    for (const [placeholder, value] of replacements) {
      html = html.split(placeholder).join(value);
    }
    writeFileSync(indexPath, html);
  '

  rm -rf "${STAGE_DIR}/studio"
  cp -R "$STUDIO_DIR" "${STAGE_DIR}/studio"

  if [[ -f "${STAGE_DIR}/.mastra/output/execa-stub.mjs" ]]; then
    cp "${STAGE_DIR}/.mastra/output/execa-stub.mjs" "${STAGE_DIR}/execa-stub.mjs"
  fi
}

put_secret_if_present() {
  local name="$1"
  local value="${!name:-}"

  if [[ -z "$value" ]]; then
    return 0
  fi

  printf '%s' "$value" | "$BUN_BIN" x wrangler secret put "$name" >/dev/null
}

put_secret_value_if_present() {
  local name="$1"
  local value="${2:-}"

  if [[ -z "$value" ]]; then
    return 0
  fi

  printf '%s' "$value" | "$BUN_BIN" x wrangler secret put "$name" >/dev/null
}

if [[ ! -x "$BUN_BIN" ]]; then
  echo "Bun not found at ${BUN_BIN}" >&2
  exit 1
fi

require_env "CLOUDFLARE_WORKER_NAME"
require_env "CLOUDFLARE_ACCOUNT_ID"
require_env "CLOUDFLARE_API_TOKEN"
require_env "CLOUDFLARE_D1_DATABASE_ID"
require_env "CLOUDFLARE_D1_DATABASE_NAME"
require_env "CLOUDFLARE_ZONE_NAME"
require_env "ROCKO_PUBLIC_URL"

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/src"

cp "$ROOT_DIR/tsconfig.json" "$STAGE_DIR/tsconfig.json"
cp -R "$ROOT_DIR/src/mastra" "$STAGE_DIR/src/"
cp "$ROOT_DIR/src/mastra/index.cloudflare.ts" "$STAGE_DIR/src/mastra/index.ts"
rm -f "$STAGE_DIR/src/mastra/index.cloudflare.ts"
rm -f "$STAGE_DIR/src/mastra/public/"mastra.db*

cat > "$STAGE_DIR/mastra.config.ts" <<'EOF'
export default {
  dir: './src',
};
EOF

cat > "$STAGE_DIR/package.json" <<'EOF'
{
  "name": "rocko-cloudflare-stage",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "mastra build"
  },
  "devDependencies": {
    "@types/node": "^25.4.0",
    "mastra": "^1.3.8",
    "typescript": "^5.9.3",
    "wrangler": "^4.72.0"
  },
  "dependencies": {
    "@mastra/cloudflare-d1": "^1.0.2",
    "@mastra/core": "^1.11.0",
    "@mastra/deployer-cloudflare": "^1.1.8",
    "@mastra/evals": "^1.1.2",
    "@mastra/loggers": "^1.0.2",
    "@mastra/memory": "^1.6.2",
    "@mastra/observability": "^1.4.0",
    "zod": "^4"
  }
}
EOF

echo "Preparing Cloudflare staging workspace at ${STAGE_DIR}"

(
  cd "$STAGE_DIR"

  "$BUN_BIN" install
  "$BUN_BIN" x mastra build --studio
  prepare_studio_assets

  put_secret_if_present "CLOUDFLARE_API_TOKEN"
  put_secret_if_present "OPENAI_API_KEY"
  google_api_key="${GOOGLE_GENERATIVE_AI_API_KEY:-${GOOGLE_API_KEY:-}}"
  put_secret_value_if_present "GOOGLE_API_KEY" "$google_api_key"
  put_secret_value_if_present "GOOGLE_GENERATIVE_AI_API_KEY" "$google_api_key"
  put_secret_if_present "ROCKO_AUTH_TOKEN"

  "$BUN_BIN" x wrangler deploy
)

echo
echo "Cloudflare deployment complete."
echo "Stage workspace: ${STAGE_DIR}"
echo "Deployed worker: ${CLOUDFLARE_WORKER_NAME}"
