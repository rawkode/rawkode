{ lib, pkgs, ... }:

with lib.hm.gvariant;
{
  nixpkgs.overlays = [
    # GNOME 46: triple-buffering-v4-46
    (final: prev: {
      gnome = prev.gnome.overrideScope (
        gnomeFinal: gnomePrev: {
          mutter = gnomePrev.mutter.overrideAttrs (old: {
            src = pkgs.fetchFromGitLab {
              domain = "gitlab.gnome.org";
              owner = "vanvugt";
              repo = "mutter";
              rev = "triple-buffering-v4-46";
              hash = "sha256-fkPjB/5DPBX06t7yj0Rb3UEuu5b9mu3aS+jhH18+lpI=";
            };
          });
        }
      );
    })
  ];

  fonts.fontconfig.enable = true;

  dconf.settings = {
    "org/gnome/desktop/datetime" = {
      automatic-timezone = true;
    };

    "org/gnome/desktop/interface" = {
      clock-show-date = false;
    };

    "org/gnome/desktop/peripherals/keyboard" = {
      numlock-state = true;
    };

    "org/gnome/desktop/peripherals/mouse" = {
      natural-scroll = true;
    };

    "org/gnome/desktop/peripherals/touchpad" = {
      disable-while-typing = true;
      two-finger-scrolling-enabled = true;
    };

    "org/gnome/desktop/privacy" = {
      report-technical-problems = false;
    };

    "org/gnome/desktop/search-providers" = {
      disabled = [ "org.gnome.Boxes.desktop" ];
      enabled = [ "org.gnome.Weather.desktop" ];
      sort-order = [
        "org.gnome.Boxes.desktop"
        "org.gnome.Calculator.desktop"
        "org.gnome.Calendar.desktop"
        "org.gnome.clocks.desktop"
        "org.gnome.Contacts.desktop"
        "org.gnome.design.IconLibrary.desktop"
        "org.gnome.Documents.desktop"
        "org.gnome.Nautilus.desktop"
        "org.gnome.seahorse.Application.desktop"
        "org.gnome.Settings.desktop"
        "org.gnome.Software.desktop"
        "org.gnome.Weather.desktop"
      ];
    };

    "org/gnome/desktop/wm/keybindings" = {
      close = [ "<super>q" ];

      switch-input-source = [ ];
      unmaximize = [ ];
      maximize = [ ];
      toggle-maximized = [ "<super>Return" ];

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

    "org/gnome/desktop/wm/preferences" = {
      focus-mode = "click";
      num-workspaces = 4;
    };

    "org/gnome/mutter" = {
      dynamic-workspaces = false;
      edge-tiling = false;
      workspaces-only-on-primary = true;
      experimental-features = [ "scale-monitor-framebuffer" ];
    };

    "org/gnome/mutter/keybindings" = {
      toggle-tiled-left = [ ];
      toggle-tiled-right = [ ];
    };

    "org/gnome/shell" = {
      disable-user-extensions = false;
      enabled-extensions = [
        "appindicatorsupport@rgcjonas.gmail.com"
        "auto-move-windows@gnome-shell-extensions.gcampax.github.com"
        "blur-my-shell@aunetx"
        "compiz-windows-effect@hermes83.github.com"
        "CoverflowAltTab@palatis.blogspot.com"
        "emoji-copy@felipeftn"
        "gsconnect@andyholmes.github.io"
        "just-perfection-desktop@just-perfection"
        "rclone-manager@germanztz.com"
        "sound-output-device-chooser@kgshank.net"
        "tailscale@joaophi.github.com"
        "useless-gaps@pimsnel.com"
        "user-theme@gnome-shell-extensions.gcampax.github.com"
      ];

      favorite-apps = [
        "code.desktop"
        "com.onepassword.OnePassword.desktop"
        "org.gnome.Terminal.desktop"
        "org.gnome.Nautilus.desktop"
        "gnome-control-center.desktop"
      ];

      welcome-dialog-last-shown-version = "42.0";
    };

    "org/gnome/shell/app-switcher" = {
      current-workspace-only = true;
    };

    "org/gnome/shell/keybindings" = {
      switch-to-application-1 = [ ];
      switch-to-application-2 = [ ];
      switch-to-application-3 = [ ];
      switch-to-application-4 = [ ];
      switch-to-application-5 = [ ];
    };

    "org/gnome/shell/extensions/auto-move-windows" = {
      application-list = [
        "vivaldi-stable.desktop:1"
        "org.wezfurlong.wezterm.desktop:2"
        "code.desktop:2"
        "vesktop.desktop:3"
        "slack.desktop:3"
      ];
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

    "org/gnome/shell/extensions/just-perfection" = {
      notification-banner-position = 5;
      osd-position = 6;
      panel = true;
      theme = true;
      window-demands-attention-focus = true;
      window-maximized-on-create = true;
    };

    "org/gnome/shell/extensions/useless-gaps" = {
      gap-size = 32;
    };
  };

  home.packages = (
    with pkgs;
    [
      gnome-extension-manager
      gnomeExtensions.appindicator
      gnomeExtensions.blur-my-shell
      gnomeExtensions.compiz-windows-effect
      gnomeExtensions.coverflow-alt-tab
      gnomeExtensions.emoji-copy
      gnomeExtensions.gsconnect
      gnomeExtensions.just-perfection
      gnomeExtensions.night-theme-switcher
      gnomeExtensions.rclone-manager
      gnomeExtensions.sound-output-device-chooser
      gnomeExtensions.tailscale-qs
      gnomeExtensions.useless-gaps
      rclone
      xwaylandvideobridge
    ]
  );

  home.pointerCursor = {
    gtk.enable = true;
    x11.enable = true;
    size = 32;
  };
}
