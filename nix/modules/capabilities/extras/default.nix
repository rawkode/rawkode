{ inputs, lib, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix { inherit lib; };
in
mkCapability {
  name = "extras";

  home = with inputs.self.appBundles; [
    descript.home
    mimestream.home
  ];
}
