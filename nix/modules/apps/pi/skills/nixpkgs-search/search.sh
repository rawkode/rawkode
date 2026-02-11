#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Search nixpkgs packages using `nix search`.

Usage:
  search.sh [--json] [--flake <ref>] <query...>

Options:
  --json          Output results as JSON.
  --flake <ref>  Flake reference to search (default: nixpkgs).
  -h, --help      Show this help message.

Examples:
  search.sh ripgrep
  search.sh --json "postgres client"
  search.sh --flake github:NixOS/nixpkgs/nixos-unstable firefox
EOF
}

json=false
flake_ref="nixpkgs"

args=()
while (($# > 0)); do
	case "$1" in
	--json)
		json=true
		shift
		;;
	--flake)
		if (($# < 2)); then
			echo "error: --flake requires a value" >&2
			usage >&2
			exit 2
		fi
		flake_ref="$2"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	--)
		shift
		args+=("$@")
		break
		;;
	-*)
		echo "error: unknown option: $1" >&2
		usage >&2
		exit 2
		;;
	*)
		args+=("$1")
		shift
		;;
	esac
done

if ((${#args[@]} == 0)); then
	echo "error: missing query" >&2
	usage >&2
	exit 2
fi

if ! command -v nix >/dev/null 2>&1; then
	echo "error: nix command not found on PATH" >&2
	echo "hint: install Nix and retry" >&2
	exit 127
fi

query="${args[*]}"
cmd=(nix search "$flake_ref" "$query")
if [[ $json == true ]]; then
	cmd+=(--json)
fi

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
cleanup() {
	rm -f "$stdout_file" "$stderr_file"
}
trap cleanup EXIT

set +e
"${cmd[@]}" >"$stdout_file" 2>"$stderr_file"
status=$?
set -e

stdout_output="$(<"$stdout_file")"
stderr_output="$(<"$stderr_file")"
combined_output="${stdout_output}"$'\n'"${stderr_output}"

if ((status != 0)); then
	if [[ -n $stdout_output ]]; then
		printf '%s\n' "$stdout_output" >&2
	fi
	if [[ -n $stderr_output ]]; then
		printf '%s\n' "$stderr_output" >&2
	fi
	echo >&2

	if [[ $combined_output == *"experimental feature"* ]] || [[ $combined_output == *"nix-command"* ]]; then
		echo "hint: retry with explicit features enabled:" >&2
		echo "  nix --extra-experimental-features 'nix-command flakes' search $flake_ref '$query'" >&2
	elif [[ $combined_output == *"no results for the given search term"* ]]; then
		echo "hint: no matches found; try broader or different query terms." >&2
	fi

	exit "$status"
fi

if [[ -n $stderr_output ]]; then
	printf '%s\n' "$stderr_output" >&2
fi
if [[ -n $stdout_output ]]; then
	printf '%s\n' "$stdout_output"
fi
