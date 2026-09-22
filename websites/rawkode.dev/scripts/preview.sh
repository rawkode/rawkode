#!/bin/sh
# Create, update, or delete this pull request's Cloudflare Worker Preview.
# Run by the cuenv tasks previews.deploy and previews.delete (env.cue).
#
#   sh scripts/preview.sh deploy   # prints wrangler's JSON, including preview_urls
#   sh scripts/preview.sh delete
#
# On pull_request runs GITHUB_REF_NAME is "<number>/merge", which names the
# Preview "pr-<number>". Elsewhere wrangler defaults to the current git branch.
set -eu

name=""
case "${GITHUB_REF_NAME:-}" in
  */merge) name="pr-${GITHUB_REF_NAME%%/*}" ;;
esac

case "${1:-}" in
  deploy)
    if [ -n "$name" ]; then
      out=$(deno task wrangler preview --name "$name" --json)
    else
      out=$(deno task wrangler preview --json)
    fi
    printf '%s\n' "$out"
    # A Preview with no URL is unreachable; fail instead of reporting success.
    if ! printf '%s' "$out" | tr -d ' \n' | grep -q '"urls":\["https://'; then
      echo "error: the Preview deployed but Cloudflare returned no URL." >&2
      echo "Enable Preview URLs for the rawkode-dev Worker: deploy with" >&2
      echo "\"preview_urls\": true in wrangler.jsonc, or turn on Domains > Worker URL > Preview in the dashboard." >&2
      exit 1
    fi
    ;;
  delete)
    if [ -n "$name" ]; then
      exec deno task wrangler preview delete --name "$name" --skip-confirmation
    fi
    exec deno task wrangler preview delete --skip-confirmation
    ;;
  *)
    echo "usage: sh scripts/preview.sh deploy|delete" >&2
    exit 64
    ;;
esac
