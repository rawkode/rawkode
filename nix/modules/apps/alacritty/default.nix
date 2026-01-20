{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "alacritty";

  common.home = {
    programs.alacritty = {
      enable = true;
      settings = {
        general = {
          live_config_reload = true;
        };
        window = {
          dynamic_title = true;
          class = {
            general = "Alacritty";
            instance = "Alacritty";
          };
          padding = {
            x = 16;
            y = 16;
          };
        };
        terminal = {
          shell = {
            program = "fish";
            args = [
              "-l"
              "-c"
              "zellij"
            ];
          };
        };
      };
    };
  };
}
