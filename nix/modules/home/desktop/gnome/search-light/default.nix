{
  lib,
  osConfig ? { },
  pkgs,
  ...
}:
with lib;
let
  cfg = osConfig.rawkOS.desktop.gnome;
in
{
  config = mkIf cfg.enable {
    dconf.settings = {
      "org/gnome/shell" = {
        disable-user-extensions = false;
        enabled-extensions = [ "search-light@icedman.github.com" ];
      };

      "org/gnome/shell/extensions/search-light" = {
        shortcut-search = [ "<Super>space" ];
      };
    };

    home.packages = with pkgs.gnomeExtensions; [ search-light ];
  };
}
