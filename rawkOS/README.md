---
shell: bash
---

# rawkOS: Rawkode's Linux Automation

## Format & Lint

```shell
bunx biome format --write
bunx biome lint --write
```

## Install Bun

```shell

```

## Install Nix (Optional)

```shell { "name": "install-nix" }
curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix | \
        sh -s -- install
echo "Defaults  secure_path = /nix/var/nix/profiles/default/bin:/nix/var/nix/profiles/default/sbin:\$(sudo printenv PATH)" | sudo tee /etc/sudoers.d/nix-sudo-env
```

## Firmware Updates

```shell '{"name": "firmware-update"}'
sudo fwupdmgr refresh --force && \
sudo fwupdmgr get-updates && \
sudo fwupdmgr update
```

### Secure Boot

```shell { "name": "secure-boot-part-one" }
sudo dracut -fv --regenerate-all
systemctl reboot
```

```shell { "name": "secure-boot-part-two" }
sudo clevis luks bind -d /dev/nvme0n1p3 tpm2 '{"pcr_ids":"1,4,5,7,9"}'
```
