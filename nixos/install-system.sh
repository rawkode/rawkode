#!/usr/bin/env sh
sudo nix-channel --add https://nixos.org/channels/nixos-unstable nixos
sudo nix-channel --add https://github.com/NixOS/nixos-hardware/archive/master.tar.gz nixos-hardware

sudo cp ./configuration.nix /etc/nixos/

sudo nix-channel --update

nix-prefetch-url --name displaylink-580.zip https://www.synaptics.com/sites/default/files/exe_files/2024-05/DisplayLink%20USB%20Graphics%20Software%20for%20Ubuntu6.0-EXE.zip

sudo nixos-rebuild switch --upgrade
