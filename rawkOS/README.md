---
shell: bash
---

# rawkOS: Rawkode's Linux Automation

## Format & Lint

```shell { "name": "format-lint" }
bunx biome format --write
bunx biome lint --write
```

## Firmware Updates

```shell { "name": "firmware-update" }
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
