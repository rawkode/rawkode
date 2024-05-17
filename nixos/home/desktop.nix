{ lib, pkgs, ... }:

with lib.hm.gvariant;
let
  catppuccin_variant = "mocha";
  catppuccin_accent = "lavender";
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

  };

  home.packages = (with pkgs; [
    bibata-cursors
    discord
    gnome.gnome-tweaks
    gnomeExtensions.appindicator
    gnomeExtensions.blur-my-shell
    gnomeExtensions.paperwm
    gnomeExtensions.sound-output-device-chooser
    slack
    zoom-us
  ]);

  programs.wezterm = {
    enable = true;
    enableZshIntegration = true;
    extraConfig = builtins.readFile ./wezterm/wezterm.lua;
  };


  xdg.enable = true;

  gtk = {
    enable = true;

    catppuccin = {
      enable = true;
      flavour = catppuccin_variant;
      accent = catppuccin_accent;
      size = "standard";

      gnomeShellTheme = true;

      tweaks = [ "rimless" ];
    };
  };
}
