{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
in
mkCapability {
  name = "theming";
  home = [ inputs.self.homeModules.stylix ];
  nixos = [ inputs.self.nixosModules.stylix ];
}
