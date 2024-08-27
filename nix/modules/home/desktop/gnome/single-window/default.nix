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
  config = mkIf (!cfg.paperwm) {
    dconf.settings = {
      "org/gnome/mutter" = {
        attach-modal-dialogs = true;
        center-new-windows = true;
        edge-tiling = true;
        workspaces-only-on-primary = true;
      };

      "org/gnome/shell" = {
        disable-user-extensions = false;
        enabled-extensions = [
          "CoverflowAltTab@palatis.blogspot.com"
          "useless-gaps@pimsnel.com"
        ];
      };

      "org/gnome/desktop/wm/keybindings" = {
        close = [ "<super>q" ];

        switch-input-source = [ ];
        unmaximize = [ ];
        maximize = [ ];

        toggle-maximized = [ "<super>Return" ];
        cycle-windows = [ "<super>period" ];
        cycle-windows-backwards = [ "<super>comma" ];

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
      };

      "org/gnome/shell/extensions/coverflowalttab" = {
        animation-time = 5.0e-2;
        hide-panel = false;
        highlight-mouse-over = false;
        icon-has-shadow = true;
        position = "Bottom";
        preview-to-monitor-ratio = 0.5;
        raise-mouse-over = false;
        randomize-animation-times = false;
        switcher-looping-method = "Flip Stack";
        switcher-style = "Coverflow";
        switch-per-monitor = true;
      };

      "org/gnome/shell/extensions/useless-gaps" = {
        gap-size = 16;
        no-gap-when-maximized = false;
      };
    };

    home.packages = with pkgs.gnomeExtensions; [
      coverflow-alt-tab
      useless-gaps
    ];
  };
}
