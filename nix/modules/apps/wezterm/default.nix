{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };

  weztermCache = {
    extra-substituters = [ "https://wezterm.cachix.org" ];
    extra-trusted-public-keys = [
      "wezterm.cachix.org-1:kAbLYJwT0CRG4CC6AI3qgC/YPpkUWDfH5CPICZ9GQK0="
    ];
  };
in
mkApp {
  name = "wezterm";

  common.home = _: {
    nix.settings = weztermCache;

    xdg.configFile."wezterm" = {
      source = ./config;
      recursive = true;
    };
  };

  linux.home =
    { pkgs, ... }:
    {
      home.packages = with pkgs; [
        wezterm
      ];
    };

  linux.system = _: {
    nix.settings = weztermCache;
  };

  darwin.system =
    { lib, ... }:
    {
      nix.settings = weztermCache;

      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "wezterm" ];
      };
    };
}
