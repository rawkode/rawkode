#!/usr/bin/env bash
sudo -E -s nixos-rebuild switch --flake .#laptop --fast
