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
        enabled-extensions = [ "auto-activities@CleoMenezesJr.github.io" ];
      };

      "org/gnome/shell/extensions/auto-activities" = {
        detect-minimized = true;
        hide-on-new-window = true;
        show-apps = false;
        skip-last-workspace = false;
        skip-taskbar = true;
      };
    };

    home.packages = with pkgs.gnomeExtensions; [ auto-activities ];
  };
}
