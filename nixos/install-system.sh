#!/usr/bin/env bash
printf "Please select a configuration:\n"
select configuration in hardware/*/; do test -n "${configuration}" && break; echo ">>> Invalid Selection"; done

configurationName=$(basename "${configuration}")

sudo -E -s nixos-rebuild switch --fast --flake .#${configurationName}
