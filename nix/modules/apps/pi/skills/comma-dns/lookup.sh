#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Run DNS lookups through comma using doggo.

Usage:
  lookup.sh <name-or-query ...>
  lookup.sh -- <raw doggo args ...>

Examples:
  lookup.sh rawkode.academy
  lookup.sh -- @1.1.1.1 rawkode.academy A
  , doggo rawkode.academy
EOF
}

if (($# == 0)); then
	echo "error: missing lookup query" >&2
	usage >&2
	exit 2
fi

case "${1:-}" in
-h | --help)
	usage
	exit 0
	;;
--)
	shift
	;;
esac

if (($# == 0)); then
	echo "error: missing doggo arguments after --" >&2
	usage >&2
	exit 2
fi

if ! command -v , >/dev/null 2>&1; then
	echo "error: comma command ',' not found on PATH" >&2
	echo "hint: install or expose comma, then retry" >&2
	exit 127
fi

set +e
comma_cmd=","
"$comma_cmd" doggo "$@"
status=$?
set -e

if ((status != 0)); then
	echo >&2
	echo "hint: verify comma can run doggo (try: , doggo rawkode.academy)" >&2
	exit "$status"
fi
