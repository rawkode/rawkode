---
shell: bash
---

# Rawkode's Operating System (rawkOS)

## NixOS

### Fresh Install

```shell '{"name": "fresh-install-partition"}'
export DEVICE=""
sudo nix --experimental-features "nix-command flakes" run github:nix-community/disko -- --mode disko ./systems/x86_64-linux/p4x-${DEVICE}-nixos/disko.nix
```

```shell '{"name": "fresh-install-install"}'
export DEVICE=""

sudo nixos-install --no-root-passwd --root /mnt --no-bootloader --flake .#${DEVICE}
sudo nixos-enter --root /mnt --command "sbctl create-keys"
sudo nixos-install --no-root-passwd --root /mnt --flake .#${DEVICE}
sudo nixos-enter --root /mnt --command "passwd rawkode"
```

### Update

Applys the NixOS and home-manager configuration.

```sh {"name":"rebuild"}
sudo nixos-rebuild switch --fast --flake .#$(hostname)
```

## Others

```sh {"name":"home"}
nix run home-manager -- switch --flake .#rawkode
```
