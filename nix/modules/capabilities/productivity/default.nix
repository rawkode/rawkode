{ inputs, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix;
in
mkCapability {
  name = "productivity";

  home = with inputs.self.appBundles; [
    rclone.home
    slack.home
    zoom.home
  ];

  darwin = with inputs.self; [
    appBundles.fantastical.darwin
    appBundles.slack.darwin
    appBundles.zoom.darwin
  ];
}
