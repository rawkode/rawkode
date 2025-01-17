{ lib, pkgs, ... }:
with lib;
{
  home.packages = with pkgs.gnomeExtensions; [ just-perfection ];

  dconf.settings = {
    "org/gnome/shell" = {
      enabled-extensions = [ "just-perfection-desktop@just-perfection" ];
    };

    "org/gnome/shell/extensions/just-perfection" = {
      accessibility-menu = false;
      activities-button = true;
      animation = 1;
      clock-menu = true;
      dash = false;
      dash-app-running = false;
      dash-separator = false;
      double-super-to-appgrid = true;
      keyboard-layout = false;
      max-displayed-search-results = 0;
      notification-banner-position = 2;
      osd-position = 0;
      overlay-key = true;
      panel = true;
      panel-in-overview = true;
      panel-size = 0;
      show-apps-button = false;
      theme = true;
      top-panel-position = 0;
      window-demands-attention-focus = true;
      window-maximized-on-create = false;
      workspace = true;
      workspace-peek = true;
      workspace-popup = false;
      workspace-wrap-around = true;
      workspaces-in-app-grid = false;
    };
  };
}
