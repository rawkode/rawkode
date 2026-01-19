{ inputs, ... }:
let
  mkApp = import ../../../../../lib/mkApp.nix { inherit (inputs.nixpkgs) lib; };
in
mkApp {
  name = "wezterm";

  home =
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

  darwin =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "wezterm" ];
      };
    };
}
