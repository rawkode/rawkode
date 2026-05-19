{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };

  ghosttyCache = {
    extra-substituters = [ "https://ghostty.cachix.org/" ];
    extra-trusted-public-keys = [
      "ghostty.cachix.org-1:QB389yTa6gTyneehvqG58y0WnHjQOqgnA+wBnpWWxns="
    ];
  };
in
mkApp {
  name = "ghostty";

  common.home =
    {
      config,
      inputs,
      lib,
      pkgs,
      isDarwin,
      ...
    }:
    let
      stylixColors = lib.attrByPath [
        "stylix"
        "colors"
        "withHashtag"
      ] null config;

      ghosttySettings = {
        auto-update = "off";

        theme = "light:Rose Pine Dawn,dark:Catppuccin Mocha";

        font-family = "Monaspace Neon";
        font-size = 16;
        font-thicken = 1;
        font-feature = [
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

        adjust-cell-height = "15%";

        shell-integration = "detect";

        background-blur-radius = 32;
        background-opacity = 1;

        mouse-hide-while-typing = true;

        clipboard-read = "allow";
        clipboard-write = "allow";
        copy-on-select = "clipboard";
        clipboard-trim-trailing-spaces = true;
        clipboard-paste-protection = true;

        confirm-close-surface = false;

        focus-follows-mouse = true;

        cursor-style = "block";
        cursor-style-blink = true;

        window-decoration = true;
        window-colorspace = "display-p3";
        window-padding-x = 16;
        window-padding-y = 16;
        window-padding-balance = true;
        window-save-state = "always";
        window-step-resize = true;

        macos-titlebar-style = "transparent";
        macos-option-as-alt = "left";

        quick-terminal-position = "top";
        quick-terminal-animation-duration = 0.2;

        keybind = [
          "global:cmd+semicolon=toggle_quick_terminal"
        ];
      }
      // lib.optionalAttrs (stylixColors != null) {
        split-divider-color = lib.mkDefault stylixColors.base0D;
        unfocused-split-fill = lib.mkDefault stylixColors.base0D;
      }
      // lib.optionalAttrs (!isDarwin) {
        gtk-single-instance = true;
        gtk-titlebar = true;
      };

      ghosttyConfigText = lib.generators.toKeyValue {
        mkKeyValue = lib.generators.mkKeyValueDefault { } " = ";
        listsAsDuplicateKeys = true;
      } ghosttySettings;
    in
    {
      nix.settings = ghosttyCache;

      programs.ghostty = {
        enable = true;
        package =
          if isDarwin then null else inputs.ghostty.packages.${pkgs.stdenv.hostPlatform.system}.default;
        enableBashIntegration = false;
        enableFishIntegration = false;

        clearDefaultKeybinds = false;

        settings = ghosttySettings;
      };

      # Ghostty looks for its config under Application Support on macOS.
      home.file = lib.mkIf isDarwin {
        "Library/Application Support/com.mitchellh.ghostty/config" = {
          text = ghosttyConfigText;
        };
      };
    };

  linux.system =
    {
      inputs,
      pkgs,
      ...
    }:
    {
      nix.settings = ghosttyCache;

      environment.systemPackages = [
        inputs.ghostty.packages.${pkgs.stdenv.hostPlatform.system}.default
      ];
    };

  darwin.system =
    { lib, ... }:
    {
      nix.settings = ghosttyCache;

      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "ghostty" ];
      };
    };
}
