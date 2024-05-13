#!/usr/bin/env sh
sudo cp ./configuration.nix /etc/nixos/

sudo nix-channel --add https://nixos.org/channels/nixos-unstable nixos
sudo nix-channel --update
sudo nixos-rebuild switch --upgrade
