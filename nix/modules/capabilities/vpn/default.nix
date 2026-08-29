{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
in
mkCapability {
  name = "vpn";

  nixos = [
    inputs.self.nixosModules.netbird
  ];

  darwin = [
    inputs.self.darwinModules.netbird
  ];
}
