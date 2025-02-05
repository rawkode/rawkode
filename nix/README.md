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
nh os switch .
```

### Flatpaks

```shell {name=install-flatpaks}
flatpak remote-add --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo

flatpak install --system --or-update --assumeyes flathub org.zulip.Zulip
flatpak install --system --or-update --assumeyes flathub com.slack.Slack
flatpak install --system --or-update --assumeyes flathub com.discordapp.Discord
flatpak install --system --or-update --assumeyes flathub com.feaneron.Boatswain
flatpak install --system --or-update --assumeyes flathub com.rafaelmardojai.SharePreview
flatpak install --system --or-update --assumeyes flathub com.spotify.Client
flatpak install --system --or-update --assumeyes flathub com.usebottles.bottles
flatpak install --system --or-update --assumeyes flathub es.danirod.Cartero
flatpak install --system --or-update --assumeyes flathub io.github.pieterdd.RcloneShuttle
flatpak install --system --or-update --assumeyes flathub net.mkiol.Jupii
flatpak install --system --or-update --assumeyes flathub org.nickvision.tubeconverter
flatpak install --system --or-update --assumeyes flathub org.gnome.Showtime
```

### Others

```sh {"name":"home"}
nh home switch .
```

## Post Installation

### DisplayLink

```shell {name=displaylink-prefetch}
nix-prefetch-url --name displaylink-600.zip https://www.synaptics.com/sites/default/files/exe_files/2024-05/DisplayLink%20USB%20Graphics%20Software%20for%20Ubuntu6.0-EXE.zip
```

### TPM2 SecureBoot

```shell {name=tpm-secure-boot}
sudo sbctl enroll-keys
sudo systemd-cryptenroll --tpm2-device=auto /dev/nvme0n1p2 --tpm2-pcrs=3,7,11 --tpm2-with-pin=true
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
