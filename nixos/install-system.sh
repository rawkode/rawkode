#!/usr/bin/env bash
sudo -E -s nixos-rebuild switch --impure --upgrade --flake .
