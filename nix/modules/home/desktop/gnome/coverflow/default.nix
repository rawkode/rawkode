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
      "org/gnome/shell" = {
        enabled-extensions = [ "CoverflowAltTab@palatis.blogspot.com" ];
      };

      "org/gnome/shell/extensions/coverflowalttab" = {
        animation-time = 5.0e-2;
        blur-radius = 0.0;
        desaturate-factor = 0.0;
        dim-factor = 0.0;
        easing-function = "random";
        hide-panel = false;
        highlight-mouse-over = false;
        icon-has-shadow = true;
        icon-style = "Classic";
        invert-swipes = true;
        position = "Bottom";
        preview-to-monitor-ratio = 0.5;
        raise-mouse-over = false;
        randomize-animation-times = false;
        switcher-looping-method = "Flip Stack";
        switcher-style = "Coverflow";
        switch-per-monitor = true;
      };
    };

    home.packages = with pkgs.gnomeExtensions; [ coverflow-alt-tab ];
  };
}
