{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "ghostty";

  home =
    {
      config,
      inputs,
      lib,
      pkgs,
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

        font-family = "Monaspace Neon";
        font-size = 16;

        shell-integration = "detect";

        background-blur-radius = 32;
        background-opacity = 0.64;

        mouse-hide-while-typing = true;

        clipboard-read = "allow";
        clipboard-write = "allow";
        copy-on-select = "clipboard";
        clipboard-trim-trailing-spaces = true;
        clipboard-paste-protection = true;

        confirm-close-surface = false;

        focus-follows-mouse = true;

        window-decoration = true;
        window-colorspace = "display-p3";
        window-padding-x = 16;
        window-padding-y = 16;
        window-padding-balance = true;
      }
      // lib.optionalAttrs (stylixColors != null) {
        split-divider-color = lib.mkDefault stylixColors.base0D;
        unfocused-split-fill = lib.mkDefault stylixColors.base0D;
      }
      // lib.optionalAttrs pkgs.stdenv.isLinux {
        gtk-single-instance = true;
        gtk-titlebar = true;
      };

      ghosttyConfigText = lib.generators.toKeyValue {
        mkKeyValue = lib.generators.mkKeyValueDefault { } " = ";
        listsAsDuplicateKeys = true;
      } ghosttySettings;
    in
    {
      programs.ghostty = {
        enable = true;
        package =
          if pkgs.stdenv.isLinux then
            inputs.ghostty.packages.${pkgs.stdenv.hostPlatform.system}.default
          else
            null;
        enableBashIntegration = false;
        enableFishIntegration = false;

        clearDefaultKeybinds = false;

        # All options are documented at
        # https://ghostty.org/docs/config/reference
        settings = ghosttySettings;
      };

      # Ghostty looks for its config under Application Support on macOS.
      home.file = lib.mkIf pkgs.stdenv.isDarwin {
        "Library/Application Support/com.mitchellh.ghostty/config" = {
          text = ghosttyConfigText;
        };
      };
    };

  nixos =
    {
      inputs,
      pkgs,
      lib,
      ...
    }:
    lib.mkIf (!pkgs.stdenv.isDarwin) {
      environment.systemPackages = [
        inputs.ghostty.packages.${pkgs.stdenv.hostPlatform.system}.default
      ];
    };

  darwin =
    { lib, ... }:
    {
      homebrew = {
        enable = lib.mkDefault true;
        casks = [ "ghostty" ];
      };
    };
}
