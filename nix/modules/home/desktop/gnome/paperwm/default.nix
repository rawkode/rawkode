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
  config = mkIf cfg.paperwm {
    dconf.settings = {
      "org/gnome/mutter" = {
        attach-modal-dialogs = mkForce false;
        edge-tiling = mkForce false;
        # False until PaperWM supports it
        workspaces-only-on-primary = mkForce false;
      };

      "org/gnome/shell" = {
        disable-user-extensions = false;
        enabled-extensions = [ "paperwm@paperwm.github.com" ];
      };

      "org/gnome/shell/extensions/paperwm" = {
        default-focus-mode = 1;
        horizontal-margin = 16;
        open-window-position = 0;
        open-window-position-option-left = false;
        open-window-position-option-right = true;
        restore-workspaces-only-on-primary = "true";
        selection-border-size = 16;
        show-focus-mode-icon = false;
        show-open-position-icon = false;
        show-window-position-bar = false;
        show-workspace-indicator = false;
        vertical-margin = 16;
        vertical-margin-bottom = 16;
        window-gap = 32;
      };

      "org/gnome/shell/extensions/paperwm/keybindings" = {
        close-window = [ "<Super>q" ];

        move-down = [ "<Shift><Super>Down" ];
        move-left = [ "<Shift><Super>Left" ];
        move-right = [ "<Shift><Super>Right" ];
        move-up = [ "<Shift><Super>Up" ];

        move-down-workspace = [ "<Shift><Super>Page_Down" ];
        move-up-workspace = [ "<Shift><Super>Page_Up" ];

        move-monitor-above = [ "<Shift><Alt>Up" ];
        move-monitor-below = [ "<Shift><Alt>Down" ];
        move-monitor-left = [ "<Shift><Alt>Left" ];
        move-monitor-right = [ "<Shift><Alt>Right" ];

        toggle-scratch = [ "<Shift><Alt>BackSpace" ];
        toggle-scratch-layer = [ "<Alt>BackSpace" ];

        # Disable these keybindings
        center-horizontally = [ "" ];
        cycle-height-backwards = [ "" ];
        cycle-width-backwards = [ "" ];
        live-alt-tab = [ "" ];
        live-alt-tab-backward = [ "" ];
        live-alt-tab-scratch = [ "" ];
        live-alt-tab-scratch-backward = [ "" ];
        move-previous-workspace = [ "" ];
        move-previous-workspace-backward = [ "" ];
        move-space-monitor-above = [ "" ];
        move-space-monitor-below = [ "" ];
        move-space-monitor-left = [ "" ];
        move-space-monitor-right = [ "" ];
        new-window = [ "" ];
        previous-workspace = [ "" ];
        previous-workspace-backward = [ "" ];
        swap-monitor-above = [ "" ];
        swap-monitor-below = [ "" ];
        swap-monitor-left = [ "" ];
        swap-monitor-right = [ "" ];
        switch-focus-mode = [ "" ];
        switch-monitor-above = [ "" ];
        switch-monitor-below = [ "" ];
        switch-monitor-left = [ "" ];
        switch-monitor-right = [ "" ];
        switch-open-window-position = [ "" ];
        toggle-scratch-window = [ "" ];
        toggle-top-and-position-bar = [ "" ];
      };
    };

    home.packages = with pkgs.gnomeExtensions; [ paperwm ];
  };
}
