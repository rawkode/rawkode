{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "wayland";

  linux.system = _: {
    environment.sessionVariables = {
      NIXOS_OZONE_WL = "1";
      QT_QPA_PLATFORM = "wayland";
    };
  };

  linux.home =
    { pkgs, ... }:
    {
      home.sessionVariables = {
        ELECTRON_OZONE_PLATFORM_HINT = "auto";
      };

      home.packages = with pkgs; [
        wl-clipboard
      ];
    };
}
