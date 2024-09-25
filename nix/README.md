---
shell: bash
---

# Rawkode's Operating System (rawkOS)

### Deploy

Applys the NixOS and home-manager configuration.

```shell '{"name": "rebuild"}
sudo nixos-rebuild switch --fast --flake .#$(hostname)
```

## Home-Manager

```shell '{"name": "home-manager switch"}'
nix run home-manager -- switch --flake .#rawkode
```
