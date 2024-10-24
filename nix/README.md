---
shell: bash
---

# rawkOS: Rawkode's Operating System

## Installation & Maintenance

### NixOS

#### Fresh Install

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

#### Update

Applys the NixOS and home-manager configuration.

```sh {"name":"rebuild"}
sudo nixos-rebuild switch --fast --flake .#$(hostname)
```

### Others

```sh {"name":"home"}
nix run home-manager -- switch --flake .#rawkode
```

## Post Installation

### DisplayLink

```shell {name=displaylink-prefetch}
nix-prefetch-url --name displaylink-600.zip https://www.synaptics.com/sites/default/files/exe_files/2024-05/DisplayLink%20USB%20Graphics%20Software%20for%20Ubuntu6.0-EXE.zip
```

### TPM2 SSH Key

```shell {name=ssh-key}
export PIN=Enter your pin to protect the key
export TPM2_PKCS11_TCTI="tabrmd:"

mkdir -p ${HOME}/.tpm2_pkcs11
tpm2_ptool init
tpm2_ptool addtoken --pid=1 --label=$(whoami) --sopin=${PIN} --userpin=${PIN}
tpm2_ptool addkey --label=$(whoami) --userpin=${PIN} --algorithm=ecc256
ssh-tpm-keygen
```
