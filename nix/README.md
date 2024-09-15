---
shell: bash
---

# Rawkode's Operating System (rawkOS)

## Tasks

### Deploy

Applys the NixOS and home-manager configuration.

```shell '{"name": "rebuild"}
sudo nixos-rebuild switch --fast --flake .#$(hostname)
```
