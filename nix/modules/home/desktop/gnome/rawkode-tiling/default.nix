{ lib, pkgs, ... }:
with lib;
{
  dconf.settings = {
    "org/gnome/mutter" = {
      attach-modal-dialogs = true;
      center-new-windows = true;
      edge-tiling = true;
      workspaces-only-on-primary = true;
    };

    "org/gnome/shell" = {
      enabled-extensions = [ "advanced-alt-tab@G-dH.github.com" ];
    };

    "org/gnome/desktop/wm/keybindings" = {
      close = [ "<super>q" ];

      switch-input-source = [ ];
      unmaximize = [ ];
      maximize = [ ];

      toggle-maximized = [ "<super>Return" ];

      move-to-monitor-left = [ "<Shift><Super>Page_Up" ];
      move-to-monitor-right = [ "<Shift><Super>Page_Down" ];

      switch-windows = [ "<alt>Tab" ];
      switch-windows-backward = [ "<alt><shift>Tab" ];

      switch-to-workspace-1 = [ "<super>1" ];
      switch-to-workspace-2 = [ "<super>2" ];
      switch-to-workspace-3 = [ "<super>3" ];
      switch-to-workspace-4 = [ "<super>4" ];
      switch-to-workspace-5 = [ "<super>5" ];

      move-to-workspace-1 = [ "<super><shift>1" ];
      move-to-workspace-2 = [ "<super><shift>2" ];
      move-to-workspace-3 = [ "<super><shift>3" ];
      move-to-workspace-4 = [ "<super><shift>4" ];
      move-to-workspace-5 = [ "<super><shift>5" ];
    };

    "org/gnome/mutter/keybindings" = {
      toggle-tiled-left = [ "<super>Left" ];
      toggle-tiled-right = [ "<super>Right" ];
      toggle-tiled-top = [ "<super>Up" ];
      toggle-tiled-bottom = [ "<super>Down" ];
    };

    "org/gnome/shell/extensions/advanced-alt-tab-window-switcher" = {
      app-switcher-popup-fav-apps = false;
      app-switcher-popup-filter = 3;
      app-switcher-popup-include-show-apps-icon = false;
      app-switcher-popup-win-counter = false;
      enable-super = false;
      hot-edge-fullscreen = false;
      hot-edge-mode = 1;
      hot-edge-position = 0;
      show-dash = 2;
      super-double-press-action = 2;
      super-key-mode = 1;
      switcher-popup-hover-select = false;
      switcher-popup-interactive-indicators = false;
      switcher-popup-monitor = 3;
      switcher-popup-position = 3;
      switcher-popup-preview-selected = 3;
      switcher-popup-start-search = false;
      switcher-popup-timeout = 0;
      switcher-popup-up-down-action = 1;
      win-switch-include-modals = true;
      win-switch-mark-minimized = false;
    };
  };

  home.packages = with pkgs.gnomeExtensions; [ advanced-alttab-window-switcher ];

}
