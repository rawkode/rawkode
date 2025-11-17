#!/usr/bin/env bash
# Automatically launch Fish shell from bash if interactive and not already in fish
# Check if we're in an interactive shell, not already in fish, and NOFISH isn't set
if echo $- | grep -q 'i' && [[ "$(ps -o comm= $PPID)" != "fish" ]] && [[ -z $NOFISH ]]; then
	if command -v fish &>/dev/null; then
		exec fish -i
	fi
fi
. "$HOME/.cargo/env"
