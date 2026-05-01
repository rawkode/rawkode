{ inputs, lib, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix { inherit lib; };
in
mkCapability {
  name = "productivity";

  home = with inputs.self.appBundles; [
    handy.home
    slack.home
    tana.home
    zoom.home
  ];

  darwin = with inputs.self; [
    appBundles.handy.darwin
    appBundles.slack.darwin
    appBundles.tana.darwin
    appBundles.zoom.darwin
  ];
}
