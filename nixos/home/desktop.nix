{
  inputs,
  lib,
  pkgs,
  ...
}:

with lib.hm.gvariant;
let
  catppuccin_variant = "mocha";
  catppuccin_accent = "lavender";
in
{
  fonts.fontconfig.enable = true;

  programs.ironbar = {
    enable = true;
    config = import ./ironbar.nix;
  };

  dconf.settings = {
    "org/gnome/desktop/interface" = {
      font-antialiasing = "rgba";
      font-hinting = "slight";
      font-name = "QuickSand 12";
      monospace-font-name = "Monaspace Neon 12";
      document-font-name = "Monaspace Neon 12";
      text-scaling-factor = mkDouble 1.25;
    };

    "org/gnome/desktop/peripherals/mouse" = {
      natural-scroll = true;
    };

    "org/gnome/desktop/peripherals/touchpad" = {
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

    "org/gnome/desktop/wm/preferences" = {
      focus-mode = "sloppy";
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
        "sound-output-device-chooser@kgshank.net"
        "user-theme@gnome-shell-extensions.gcampax.github.com"
        "gsconnect@andyholmes.github.io"
        "blur-my-shell@aunetx"
        "appindicatorsupport@rgcjonas.gmail.com"
        "paperwm@paperwm.github.com"
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

    "org/gnome/shell/extensions/paperwm" = {
      default-focus-mode = 1; # center

      horizontal-margin = 64;
      vertical-margin = 64;
      top-margin = 32;
      bottom-margin = 32;
      window-gap = 64;
      selection-border-size = 4;

      show-window-position-bar = false;
      show-workspace-indicator = false;

      cycle-height-steps = [
        0.5
        1.0
      ];
      cycle-width-steps = [
        0.25
        0.5
        0.75
        1.0
      ];
    };
  };

  home.packages = (
    with pkgs;
    [
      bibata-cursors
      bruno
      discord
      gnome.gnome-tweaks
      gnomeExtensions.appindicator
      gnomeExtensions.blur-my-shell
      gnomeExtensions.paperwm
      gnomeExtensions.pop-shell
      gnomeExtensions.sound-output-device-chooser
      (wrapOBS { plugins = [ obs-studio-plugins.obs-source-record ]; })
      slack
      wf-recorder
      wl-clipboard
      zoom-us
    ]
  );

  programs.wezterm = {
    enable = true;
    enableZshIntegration = true;
    extraConfig = builtins.readFile ./wezterm/wezterm.lua;
  };

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
  programs.zellij.catppuccin.enable = true;

  gtk = {
    enable = true;

    catppuccin = {
      enable = true;
      flavor = catppuccin_variant;
      accent = catppuccin_accent;
      size = "standard";

      gnomeShellTheme = true;
      cursor.enable = true;
      icon.enable = true;

      tweaks = [ "normal" ];
    };
  };
}
