{ inputs, lib, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix { inherit lib; };
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
