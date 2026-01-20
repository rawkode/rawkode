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

        targets.qt.platform = lib.mkForce "qtct";

        fonts = {
          sizes = {
            applications = 11;
            terminal = 14;
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

  # Module form of the config (for imports)
  stylixConfigModule = { lib, pkgs, ... }: mkStylixConfig { inherit lib pkgs; };
in
{
  # NixOS module that imports both stylix and our config
  flake.nixosModules.stylix = {
    imports = [
      inputs.stylix.nixosModules.stylix
      stylixConfigModule
    ];
  };

  # Home Manager module for Darwin/standalone use
  # On NixOS, the stylix module is already provided by nixosModules.stylix
  # which propagates to home-manager automatically
  flake.homeModules.stylix =
    {
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

      # Apply our shared config (this is additive and works on all platforms)
      config = mkStylixConfig { inherit lib pkgs; };
    };
}
