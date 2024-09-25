---
shell: bash
---

# Rawkode's Operating System (rawkOS)

## NixOS

Applys the NixOS and home-manager configuration.

```shell '{"name": "rebuild"}
sudo nixos-rebuild switch --fast --flake .#$(hostname)
```

## Others

```shell '{"name": "home-manager switch"}'
nix run home-manager -- switch --flake .#rawkode
```
