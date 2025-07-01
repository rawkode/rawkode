{ config, lib, pkgs, ... }:
{
  home.file."${config.home.homeDirectory}/.config/wallpapers/rawkode-academy.png".source = ./rawkode-academy.png;

  home.file.".config/niri/wallpaper.png".source = config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/.config/wallpapers/rawkode-academy.png";
}
