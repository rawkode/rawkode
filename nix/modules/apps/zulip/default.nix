{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "zulip";

  linux.home = {
    services.flatpak.packages = [
      "org.zulip.Zulip"
    ];
  };
}
