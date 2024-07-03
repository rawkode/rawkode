{ lib, pkgs, ... }:

with lib.hm.gvariant;
let
  catppuccin_variant = "frappe";
  catppuccin_accent = "lavender";
in
{
  fonts.fontconfig.enable = true;

  dconf.settings = {
    "org/gnome/desktop/interface" = {
      clock-show-date = false;
      font-antialiasing = "rgba";
      font-hinting = "slight";
      font-name = "QuickSand 12";
      monospace-font-name = "Monaspace Neon 12";
      document-font-name = "Monaspace Neon 12";
    };
    "org/gnome/desktop/peripherals/keyboard" = {
      numlock-state = true;
    };

    "org/gnome/desktop/peripherals/mouse" = {
      natural-scroll = true;
    };

    "org/gnome/desktop/datetime" = {
      automatic-timezone = true;
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
        "org.gnome.Contacts.desktop"
        "org.gnome.Documents.desktop"
        "org.gnome.Nautilus.desktop"
        "org.gnome.Calendar.desktop"
        "org.gnome.Calculator.desktop"
        "org.gnome.Software.desktop"
        "org.gnome.Settings.desktop"
        "org.gnome.clocks.desktop"
        "org.gnome.design.IconLibrary.desktop"
        "org.gnome.seahorse.Application.desktop"
        "org.gnome.Weather.desktop"
        "org.gnome.Boxes.desktop"
      ];
    };

    "org/gnome/shell/extensions/forge" = {
      auto-split-enabled = false;
      stacked-tiling-mode-enabled = true;
      window-gap-size = lib.hm.gvariant.mkUint32 8;
      showtab-decoration-enabled = true;
    };

    "org/gnome/shell/extensions/forge/keybindings" = {
      window-toggle-float = [ "<Super>f" ];
      con-tabbed-layout-toggle = [ "<Super>t" ];
      con-stacked-layout-toggle = [ "<Super><Shift>s" ];

      window-focus-down = [ "<Super>Down" ];
      window-focus-left = [ "<Super>Left" ];
      window-focus-right = [ "<Super>Right" ];
      window-focus-up = [ "<Super>Up" ];
      window-move-down = [ "<Shift><Super>Down" ];
      window-move-left = [ "<Shift><Super>Left" ];
      window-move-right = [ "<Shift><Super>Right" ];
      window-move-up = [ "<Shift><Super>Up" ];
    };

    "org/gnome/desktop/wm/preferences" = {
      focus-mode = "sloppy";
      num-workspaces = 3;
    };

    "org/gnome/desktop/wm/keybindings" = {
      close = [ "<super>q" ];

      switch-input-source = [ ];
      unmaximize = [ ];
      maximize = [ ];

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

    "org/gnome/shell/keybindings" = {
      switch-to-application-1 = [ ];
      switch-to-application-2 = [ ];
      switch-to-application-3 = [ ];
      switch-to-application-4 = [ ];
      switch-to-application-5 = [ ];
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
        "advanced-alt-tab@G-dH.github.com"
        "appindicatorsupport@rgcjonas.gmail.com"
        "blur-my-shell@aunetx"
        "forge@jmmaranan.com"
        "gsconnect@andyholmes.github.io"
        "just-perfection-desktop@just-perfection"
        "sound-output-device-chooser@kgshank.net"
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

    "org/gnome/shell/extensions/just-perfection" = {
      notification-banner-position = 5;
      osd-position = 6;
      panel = true;
      theme = true;
      window-demands-attention-focus = true;
      window-maximized-on-create = true;
    };

    "org/gnome/shell/app-switcher" = {
      current-workspace-only = true;
    };

    "org/gnome/shell/extensions/advanced-alt-tab-window-switcher" = {
      app-switcher-popup-fav-apps = false;
      app-switcher-popup-filter = 3;
      app-switcher-popup-include-show-apps-icon = false;
      switcher-popup-interactive-indicators = true;
      switcher-popup-monitor = 3;
      switcher-popup-position = 3;
      switcher-popup-start-search = false;
      switcher-popup-status = true;
      switcher-popup-sync-filter = true;
      switcher-popup-timeout = 250;
      switcher-popup-tooltip-title = 1;
      switcher-ws-thumbnails = 0;
      win-switch-skip-minimized = true;
      win-switcher-popup-filter = 3;
      win-switcher-popup-order = 4;
      win-switcher-popup-search-all = false;
    };
  };

  home.packages = (
    with pkgs;
    [
      bruno
      clickup
      discord
      gnome.gnome-tweaks
      gnomeExtensions.appindicator
      gnomeExtensions.advanced-alttab-window-switcher
      gnomeExtensions.blur-my-shell
      gnomeExtensions.fly-pie
      gnomeExtensions.forge
      gnomeExtensions.just-perfection
      gnomeExtensions.one-window-wonderland
      gnomeExtensions.pano
      gnomeExtensions.sound-output-device-chooser
      gnomeExtensions.useless-gaps
      (wrapOBS { plugins = [ obs-studio-plugins.obs-source-record ]; })
      slack
      wf-recorder
      wl-clipboard
      wmctrl
      zoom-us
    ]
  );

  xdg.enable = true;

  xdg.portal = {
    enable = true;
    extraPortals = with pkgs; [
      xdg-desktop-portal-gtk
      xdg-desktop-portal-wlr
    ];
    xdgOpenUsePortal = true;
  };

  programs.zellij.enable = true;

  home.pointerCursor = {
    gtk.enable = true;
    x11.enable = true;
    name = "catppuccin-frappe-lavender-cursors";
    size = 32;
    package = pkgs.catppuccin-cursors.frappeLavender;
  };

  gtk = {
    enable = true;

    cursorTheme.size = 32;

    catppuccin = {
      enable = true;
      flavor = catppuccin_variant;
      accent = catppuccin_accent;
      size = "standard";

      gnomeShellTheme = true;
      cursor.enable = true;
      icon.enable = true;
    };
  };
}
