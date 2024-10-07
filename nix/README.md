---
shell: bash
---

# Rawkode's Operating System (rawkOS)

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

### TPM2 SSH Key

```shell {name=ssh-key}
export PIN=Enter your pin to protect the key
export TPM2_PKCS11_TCTI="tabrmd:"

mkdir -p ${HOME}/.tpm2_pkcs11
tpm2_ptool init
tpm2_ptool addtoken --pid=1 --label=$(whoami) --sopin=${PIN} --userpin=${PIN}
tpm2_ptool addkey --label=$(whoami) --userpin=${PIN} --algorithm=ecc256
ssh-tpm-keygen
cat <<EOF >>${HOME}/.config/git/allowed_signers
david@rawkode.dev namespaces="git" $(cat ${HOME}/.ssh/id_ecdsa.pub)
EOF
```
