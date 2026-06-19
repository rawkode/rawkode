{ inputs, ... }:
let
  # Shared stylix configuration used by both NixOS and Home Manager
  mkStylixConfig =
    { lib, pkgs }:
    let
      wallpaper = pkgs.fetchurl {
        url = "https://raw.githubusercontent.com/ng-hai/hyper-rose-pine-next/refs/heads/main/wallpaper/dark/wallpaper-block-wave/themer-wallpaper-block-wave-dark-5120x2880.png";
        sha256 = "sha256-Q5ZtrIDtPZKOYohNt9NjPF6suV3rcw1HK8mx7+Ll4Ts=";
      };
    in
    {
      stylix = {
        enable = true;
        autoEnable = true;

        polarity = "dark";
        image = wallpaper;
        base16Scheme = "${pkgs.base16-schemes}/share/themes/ayu-mirage.yaml";

        cursor = {
          package = pkgs.phinger-cursors;
          name = "phinger-cursors-dark";
          size = 32;
        };

        opacity.terminal = 0.9;
        opacity.popups = 0.9;

        targets.fish.enable = false;
        targets.qt.platform = lib.mkForce "qtct";

        fonts = {
          sizes = {
            applications = 11;
            terminal = 15;
            desktop = 12;
            popups = 11;
          };

          monospace = {
            package = pkgs.nerd-fonts.monaspace;
            name = "MonaspiceNe Nerd Font";
          };

          serif = {
            package = pkgs.lora;
            name = "Lora";
          };

          sansSerif = {
            package = pkgs.inter;
            name = "Inter";
          };

          emoji = {
            package = pkgs.noto-fonts-color-emoji;
            name = "Noto Color Emoji";
          };
        };
      };
    };

in
{
  # NixOS module that imports both stylix and our config
  flake.nixosModules.stylix =
    {
      config,
      lib,
      pkgs,
      ...
    }:
    {
      imports = [
        inputs.stylix.nixosModules.stylix
      ];

      options.rawkOS.stylix.enable = lib.mkEnableOption "shared Stylix theme configuration" // {
        default = true;
      };

      config = lib.mkIf config.rawkOS.stylix.enable (mkStylixConfig {
        inherit lib pkgs;
      });
    };

  # Home Manager module for Darwin/standalone use
  # On NixOS, the stylix module is already provided by nixosModules.stylix
  # which propagates to home-manager automatically
  flake.homeModules.stylix =
    {
      config,
      lib,
      pkgs,
      osClass ? null,
      ...
    }:
    {
      # Only import the stylix home module if NOT on NixOS
      # (NixOS provides it via nixosModules.stylix)
      imports = lib.optionals (osClass != "nixos") [
        inputs.stylix.homeModules.stylix
      ];

      options.rawkOS.stylix.enable = lib.mkEnableOption "shared Stylix theme configuration" // {
        default = true;
      };

    }
    // lib.optionalAttrs (osClass != "nixos") {
      # Apply our shared config for standalone Home Manager and Darwin.
      config = lib.mkIf config.rawkOS.stylix.enable (mkStylixConfig {
        inherit lib pkgs;
      });
    };
}
