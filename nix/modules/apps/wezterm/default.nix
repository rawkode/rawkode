{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "wezterm";

  common.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        wezterm
      ];

      xdg.configFile."wezterm" = {
        source = ./config;
        recursive = true;
      };
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "wezterm" ];
      };
    };
}
