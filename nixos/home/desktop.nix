{ lib, pkgs, ... }:

with lib.hm.gvariant;
let
  catppuccin_variant = "frappe";
  catppuccin_accent = "mauve";
in
{
  fonts.fontconfig.enable = true;

  dconf.settings = {
    "org/gnome/desktop/interface" = {
      font-antialiasing = "rgba";
      font-hinting = "slight";
      font-name = "QuickSand 12";
      monospace-font-name = "Monaspace Neon 12";
      document-font-name = "Monaspace Neon 12";
    };

    "org/gnome/desktop/peripherals/mouse" = {
      natural-scroll = true;
    };

    "org/gnome/desktop/peripherals/touchpad" = {
      two-finger-scrolling-enabled = true;
      disable-while-typing = true;
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

    # Disable Windows key
    # "org.gnome.mutter overlay-key" = "";

    "org/gnome/desktop/wm/preferences" = {
      focus-mode = "sloppy";
    };

    "org/gnome/desktop/wm/keybindings" = {
      toggle-maximized = [ "<Super>Return" ];
      close = [ "<super>q" ];

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
      dynamic-workspaces = true;
      edge-tiling = false;
      workspaces-only-on-primary = true;
      experimental-features = [ "scale-monitor-framebuffer" ];
    };

    "org/gnome/shell" = {
      disable-user-extensions = false;
      enabled-extensions = [
        "appindicatorsupport@rgcjonas.gmail.com"
        "blur-my-shell@aunetx"
        "gsconnect@andyholmes.github.io"
        "gnome-one-window-wonderland@jqno.nl"
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

    "org/gnome/shell/app-switcher" = {
      current-workspace-only = true;
    };

    "org/gnome/shell/extensions/one-window-wonderland" = {
      force-list = "Vivaldi";
      gap-size = 32;
    };
  };

  home.packages = (
    with pkgs;
    [
      bruno
      discord
      gnome.gnome-tweaks
      gnomeExtensions.appindicator
      gnomeExtensions.blur-my-shell
      gnomeExtensions.one-window-wonderland
      gnomeExtensions.sound-output-device-chooser
      (wrapOBS { plugins = [ obs-studio-plugins.obs-source-record ]; })
      slack
      wf-recorder
      wl-clipboard
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
