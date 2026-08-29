{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
in
mkCapability {
  name = "extras";

  home = with inputs.self.appBundles; [
    descript.home
    mimestream.home
  ];
}
