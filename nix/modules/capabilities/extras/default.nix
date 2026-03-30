{ inputs, lib, ... }:
let
  mkCapability = import ../../../lib/mkCapability.nix { inherit lib; };
in
mkCapability {
  name = "extras";

  home = with inputs.self.appBundles; [
    cursor.home
    descript.home
    mimestream.home
    parallels.home
    setapp.home
  ];

  darwin = with inputs.self.appBundles; [
    cursor.darwin
    descript.darwin
    mimestream.darwin
    parallels.darwin
    setapp.darwin
  ];
}
