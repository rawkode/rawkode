{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "zoom";

  linux.home =
    { lib, pkgs, ... }:
    {
      home.packages = lib.optionals (lib.meta.availableOn pkgs.stdenv.hostPlatform pkgs.zoom-us) [
        pkgs.zoom-us
      ];
    };

  darwin.system =
    { config, lib, ... }:
    {
      options.rawkOS.apps.zoom.enable = lib.mkEnableOption "Zoom Homebrew cask" // {
        default = true;
      };

      config = lib.mkIf config.rawkOS.apps.zoom.enable {
        homebrew = {
          enable = lib.mkDefault true;
          casks = [ "zoom" ];
        };
      };
    };
}
