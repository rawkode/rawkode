{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
in
mkCapability {
  name = "personal";

  darwin = with inputs.self.appBundles; [
    mole.darwin
    steam.darwin
  ];
}
