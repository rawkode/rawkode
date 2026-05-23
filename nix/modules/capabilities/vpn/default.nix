{ inputs, lib, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix { inherit lib; };
in
mkCapability {
  name = "vpn";

  nixos = [
    inputs.self.nixosModules.netbird
    inputs.self.nixosModules.tailscale
  ];

  darwin = [
    inputs.self.darwinModules.netbird
    inputs.self.darwinModules.tailscale
  ];
}
