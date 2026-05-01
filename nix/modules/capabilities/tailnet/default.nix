{ inputs, lib, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix { inherit lib; };
in
mkCapability {
  name = "tailnet";

  nixos = [
    inputs.self.nixosModules.tailscale
  ];

  darwin = [
    inputs.self.darwinModules.tailscale
  ];
}
