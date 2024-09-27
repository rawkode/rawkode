---
shell: bash
---

# Rawkode's Operating System (rawkOS)

## NixOS

Applys the NixOS and home-manager configuration.

```sh {"name":"rebuild"}
sudo nixos-rebuild switch --fast --flake .#$(hostname)
```

## Others

```sh {"name":"home-manager switch"}
nix run home-manager -- switch --flake .#rawkode
```
