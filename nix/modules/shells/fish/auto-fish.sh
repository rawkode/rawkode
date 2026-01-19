#!/usr/bin/env bash
# Check if we're in an interactive shell, not already in fish, not in nix-shell, and NOFISH isn't set
if echo $- | grep -q 'i' && [[ "$(ps -o comm= $PPID)" != "fish" ]] && [[ -z $IN_NIX_SHELL ]] && [[ -z $NOFISH ]]; then
	# Try to find fish in common NixOS locations
	if [[ -x /run/current-system/sw/bin/fish ]]; then
		exec /run/current-system/sw/bin/fish -i
	elif command -v fish &>/dev/null; then
		exec fish -i
	fi
fi
