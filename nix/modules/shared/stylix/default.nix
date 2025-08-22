{ lib, pkgs, ... }:
let
  wallpapers = {
    rose-pine = pkgs.fetchurl {
      url = "https://raw.githubusercontent.com/ng-hai/hyper-rose-pine-next/refs/heads/main/wallpaper/dark/wallpaper-block-wave/themer-wallpaper-block-wave-dark-5120x2880.png";
      sha256 = "sha256-Q5ZtrIDtPZKOYohNt9NjPF6suV3rcw1HK8mx7+Ll4Ts=";
    };
  };
in
{
  stylix = {
    base16Scheme = "${pkgs.base16-schemes}/share/themes/rose-pine-moon.yaml";
    enable = true;
    polarity = "dark";

    image = lib.mkDefault wallpapers.rose-pine;

    opacity.terminal = 0.9;
    opacity.popups = 0.9;

    targets.qt.platform = lib.mkForce "qtct";

    cursor = {
      package = pkgs.rose-pine-cursor;
      name = "BreezeX-RosePine-Linux";
      size = 16;
    };

    fonts = {
      sizes = {
        applications = 11;
        terminal = 14;
        desktop = 12;
        popups = 11;
      };

      monospace = {
        package = pkgs.nerd-fonts.zed-mono;
        name = "Monaspace Argon";
      };

      serif = {
        package = pkgs.nerd-fonts.zed-mono;
        name = "Roboto Serif";
      };

      sansSerif = {
        package = pkgs.nerd-fonts.zed-mono;
        name = "Roboto Sans";
      };

      emoji = {
        package = pkgs.noto-fonts-emoji;
        name = "Noto Color Emoji";
      };

    };
  };
}
