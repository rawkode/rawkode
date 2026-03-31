{ inputs, lib, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix { inherit lib; };
in
mkCapability {
  name = "personal";

  darwin = with inputs.self; [
    darwinModules.netbird
  ];
}
