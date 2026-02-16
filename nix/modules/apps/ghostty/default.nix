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

        font-family = "Monaspace Neon";
        font-size = 16;

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
