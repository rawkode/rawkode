{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
in
mkCapability {
  name = "vpn";

  nixos = [
    inputs.self.nixosModules.tailscale
  ];

  darwin = [
    inputs.self.darwinModules.tailscale
  ];
}
