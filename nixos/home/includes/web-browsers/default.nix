{ config, pkgs, ... }:

{
  home.file.".config/fontconfig/conf.d/01-emoji.conf".source = ./google-chrome/01-emoji.conf;

  home.packages = (with pkgs; [
    firefox
    google-chrome
  ]);
}
