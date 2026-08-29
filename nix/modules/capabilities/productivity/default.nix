{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
in
mkCapability {
  name = "productivity";

  home = with inputs.self.appBundles; [
    slack.home
    zoom.home
  ];

  darwin = with inputs.self; [
    appBundles.craft.darwin
    appBundles.fantastical.darwin
    appBundles.slack.darwin
    appBundles.zoom.darwin
  ];
}
