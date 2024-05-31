#!/usr/bin/env bash

sudo cp configuration.nix flake.* /etc/nixos/

sudo nixos-rebuild switch --upgrade --flake /etc/nixos
