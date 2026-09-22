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
      exec deno task wrangler preview --name "$name" --json
    fi
    exec deno task wrangler preview --json
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
