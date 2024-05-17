#!/usr/bin/env sh
sudo nix-channel --add https://nixos.org/channels/nixos-unstable nixos
sudo nix-channel --add https://github.com/NixOS/nixos-hardware/archive/master.tar.gz nixos-hardware

sudo cp ./configuration.nix /etc/nixos/

sudo nix-channel --update
sudo nixos-rebuild switch --upgrade
