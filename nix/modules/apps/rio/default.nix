_:
let
  mkApp = import ../../../lib/mkApp.nix;
in
mkApp {
  name = "rio";

  common.home =
    {
      isDarwin,
      lib,
      pkgs,
      stylixHome ? false,
      ...
    }:
    lib.optionalAttrs stylixHome {
      stylix.targets.rio.enable = false;
    }
    // {
      programs.rio = {
        enable = true;
        package = if isDarwin then null else pkgs.rio;
        settings = {
          adaptive-theme = {
            light = "rose-pine-dawn";
            dark = "catppuccin-mocha";
          };
          fonts = {
            family = "Monaspace Neon";
            size = 22;
            features = [
              "calt"
              "liga"
              "ss01"
              "ss02"
              "ss03"
              "ss04"
              "ss05"
              "ss06"
              "ss07"
              "ss08"
            ];
          };
          line-height = 1.15;
          margin = [ 8 ];
          panel.padding = [ 8 ];
          navigation.hide-if-single = true;
          env-vars = [ "SHLVL=0" ];
          cursor = {
            shape = "block";
            blinking = true;
          };
          window = {
            opacity = 0.9;
            decorations = if isDarwin then "Transparent" else "Enabled";
          };
          option-as-alt = "left";
          hide-mouse-cursor-when-typing = true;
          copy-on-select = true;
          confirm-before-quit = false;
        };
        themes = {
          catppuccin-mocha.colors = {
            background = "#1e1e2e";
            foreground = "#cdd6f4";
            cursor = "#f5e0dc";
            selection-background = "#f5e0dc";
            selection-foreground = "#1e1e2e";
            black = "#45475a";
            red = "#f38ba8";
            green = "#a6e3a1";
            yellow = "#f9e2af";
            blue = "#89b4fa";
            magenta = "#f5c2e7";
            cyan = "#94e2d5";
            white = "#bac2de";
            light-black = "#585b70";
            light-red = "#f7aec2";
            light-green = "#c2ecbf";
            light-yellow = "#fcd682";
            light-blue = "#aeccfc";
            light-magenta = "#f398da";
            light-cyan = "#b1eae1";
            light-white = "#a6adc8";
          };
          rose-pine-dawn.colors = {
            background = "#faf4ed";
            foreground = "#575279";
            cursor = "#575279";
            selection-background = "#dfdad9";
            selection-foreground = "#575279";
            black = "#f2e9e1";
            red = "#b4637a";
            green = "#286983";
            yellow = "#ea9d34";
            blue = "#56949f";
            magenta = "#907aa9";
            cyan = "#d7827e";
            white = "#575279";
            light-black = "#9893a5";
            light-red = "#b4637a";
            light-green = "#286983";
            light-yellow = "#ea9d34";
            light-blue = "#56949f";
            light-magenta = "#907aa9";
            light-cyan = "#d7827e";
            light-white = "#575279";
          };
        };
      };
    };

  darwin.system =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "rio" ];
      };
    };
}
