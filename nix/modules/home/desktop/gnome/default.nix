{
  lib,
  osConfig ? { },
  pkgs,
  ...
}:
with lib;
let
  cfg = osConfig.rawkOS.desktop.gnome;
  file-chooser = {
    date-format = "regular";
    location-mode = "path-bar";
    show-hidden = false;
    show-size-column = true;
    show-type-column = true;
    sidebar-width = 256;
    sort-column = "name";
    sort-directories-first = true;
    sort-order = "ascending";
    type-format = "category";
    view-type = "list";
  };
in
{
  config = mkIf cfg.enable {
    dconf.settings = {
      "org/gnome/desktop/datetime" = {
        automatic-timezone = true;
      };

      "org/gnome/desktop/interface" = {
        clock-show-date = false;
        enable-animations = true;
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

        move-to-monitor-left = [ "<Shift><Super>Page_Up" ];
        move-to-monitor-right = [ "<Shift><Super>Page_Down" ];

        move-to-workspace-1 = [ "<super><shift>1" ];
        move-to-workspace-2 = [ "<super><shift>2" ];
        move-to-workspace-3 = [ "<super><shift>3" ];
        move-to-workspace-4 = [ "<super><shift>4" ];
        move-to-workspace-5 = [ "<super><shift>5" ];
      };

      "org/gnome/desktop/wm/preferences" = {
        button-layout = ":close";
        focus-mode = "click";
      };

      "org/gnome/file-roller/listing" = {
        list-mode = "as-folder";
        show-path = false;
        sort-method = "name";
        sort-type = "ascending";
      };

      "org/gnome/file-roller/ui" = {
        sidebar-width = 256;
      };

      "org/gnome/mutter" = {
        dynamic-workspaces = false;
        experimental-features = [ "scale-monitor-framebuffer" ];
        num-workspaces = 4;
      };

      "org/gnome/mutter/keybindings" = {
        cancel-input-capture = [ ];
        toggle-tiled-left = [ ];
        toggle-tiled-right = [ ];
      };

      "org/gnome/settings-daemon/plugins/power" = {
        power-button-action = "interactive";
        sleep-inactive-ac-type = "nothing";
      };

      "org/gnome/shell" = {
        disable-user-extensions = false;
        enabled-extensions = [
          "appindicatorsupport@rgcjonas.gmail.com"
          "auto-move-windows@gnome-shell-extensions.gcampax.github.com"
          "emoji-copy@felipeftn"
          "gsconnect@andyholmes.github.io"
          #          "just-perfection-desktop@just-perfection"
          "nightthemeswitcher@romainvigier.fr"
          "rclone-manager@germanztz.com"
          "sound-output-device-chooser@kgshank.net"
          "space-bar@luchrioh"
          "tailscale@joaophi.github.com"
          "user-theme@gnome-shell-extensions.gcampax.github.com"
          "vertical-workspaces@G-dH.github.com"
        ];

        favorite-apps = [ ];

        welcome-dialog-last-shown-version = "42.0";
      };

      "org/gnome/shell/app-switcher" = {
        current-workspace-only = true;
      };

      "org/gnome/shell/extensions/auto-move-windows" = {
        application-list = [
          "vivaldi-stable.desktop:1"
          "org.wezfurlong.wezterm.desktop:2"
          "code.desktop:2"
          "vesktop.desktop:3"
          "slack.desktop:3"
          "spotify.desktop:4"
        ];
      };

      "org/gnome/shell/extensions/emoji-copy" = {
        emoji-keybind = [ "<Super>e" ];
      };

      "org/gnome/shell/extensions/just-perfection" = {
        panel = true;
        theme = true;
        panel-size = 48;

        activities-button = false;

        notification-banner-position = 5;
        osd-position = 6;

        window-demands-attention-focus = true;
        window-maximized-on-create = true;
      };

      "org/gnome/shell/extensions/nightthemeswitcher/commands" = {
        enabled = true;
      };

      "org/gnome/shell/extensions/space-bar/appearance" = {
        active-workspace-border-radius = 4;
        active-workspace-border-width = 0;
        active-workspace-font-weight = "600";
        active-workspace-padding-h = 4;
        active-workspace-padding-v = 4;
        empty-workspace-border-radius = 4;
        empty-workspace-border-width = 0;
        empty-workspace-font-weight = "600";
        empty-workspace-padding-h = 4;
        empty-workspace-padding-v = 4;
        inactive-workspace-border-radius = 4;
        inactive-workspace-border-width = 0;
        inactive-workspace-font-weight = "600";
        inactive-workspace-padding-h = 4;
        inactive-workspace-padding-v = 4;
        workspace-margin = 8;
        workspaces-bar-padding = 8;
      };

      "org/gnome/shell/extensions/space-bar/shortcuts" = {
        enable-activate-workspace-shortcuts = true;
        enable-move-to-workspace-shortcuts = true;
      };

      "org/gnome/shell/extensions/space-bar/behavior" = {
        always-show-numbers = false;
        indicator-style = "workspaces-bar";
        scroll-wheel = "disabled";
        show-empty-workspaces = true;
        smart-workspace-names = false;
      };

      "org/gnome/shell/extensions/vertical-workspaces" = {
        app-grid-incomplete-pages = false;
        center-app-grid = false;
        dash-isolate-workspaces = true;
        dash-position = 4;
        overview-mode = 0;
        panel-position = 0;
        recent-files-search-provider-module = true;
        running-dot-style = 0;
        show-search-entry = false;
        startup-state = 0;
        ws-switcher-wraparound = true;
        ws-thumbnails-full = true;
        ws-thumbnails-position = 0;
      };

      "org/gnome/shell/keybindings" = {
        focus-active-notification = [ ];
        shift-overview-down = [ ];
        shift-overview-up = [ ];
        switch-to-application-1 = [ ];
        switch-to-application-2 = [ ];
        switch-to-application-3 = [ ];
        switch-to-application-4 = [ ];
        switch-to-application-5 = [ ];
        toggle-overview = [ "<Control>Down" ];
      };

      "org/gtk/gtk4/settings/file-chooser" = file-chooser;
      "org/gtk/settings/file-chooser" = file-chooser;
    };

    gtk = {
      iconTheme = {
        package = pkgs.catppuccin-papirus-folders.override {
          flavor = "mocha";
          accent = "mauve";
        };
        name = "Papirus-Dark";
      };
    };

    home.packages = (
      with pkgs;
      [ gnome-extension-manager ]
      ++ (with pkgs.gnomeExtensions; [
        appindicator
        emoji-copy
        gsconnect
        just-perfection
        night-theme-switcher
        rclone-manager
        sound-output-device-chooser
        space-bar
        tailscale-qs
        top-bar-organizer
        vertical-workspaces
      ])
    );
  };
}
