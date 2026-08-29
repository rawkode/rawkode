{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
in
mkCapability {
  name = "personal";

  home = with inputs.self.appBundles; [
    mole.home
  ];

  darwin = with inputs.self.appBundles; [
    steam.darwin
  ];
}
