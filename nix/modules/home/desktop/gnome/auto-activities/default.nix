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
  # This extension shows the search box when there's no
  # active window on the workspace / monitor and hides it when there
  # is.
  config = mkIf cfg.enable {
    dconf.settings = {
      "org/gnome/shell" = {
        enabled-extensions = [ "auto-activities@CleoMenezesJr.github.io" ];
      };

      "org/gnome/shell/extensions/auto-activities" = {
        detect-minimized = true;
        hide-on-new-window = true;
        show-apps = false;
        isolate-monitors = true;
        skip-last-workspace = false;
        skip-taskbar = true;
      };
    };

    home.packages = with pkgs.gnomeExtensions; [ auto-activities ];
  };
}
