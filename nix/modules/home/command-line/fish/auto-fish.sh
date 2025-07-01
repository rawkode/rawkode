#!/usr/bin/env bash
if echo $- | grep -q 'i' && [[ "$(ps -o comm= $PPID)" != "fish" ]] && [[ -x /usr/bin/fish ]] && [[ -z $IN_NIX_SHELL ]] && [[ -z $NOFISH ]]; then
  exec /usr/bin/fish -i
fi
