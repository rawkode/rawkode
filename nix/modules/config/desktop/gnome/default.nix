{
  flake.nixosModules.gnome = _: {
    services.desktopManager.gnome.enable = true;
  };

  flake.homeModules.gnome =
    {
      inputs,
      lib,
      pkgs,
      ...
    }:
    let
      file-chooser = {
        date-format = "regular";
        location-mode = "path-bar";
        show-hidden = false;
        show-size-column = true;
        show-type-column = true;
        sidebar-width = 512;
        sort-column = "name";
        sort-directories-first = true;
        sort-order = "ascending";
        type-format = "category";
        view-type = "list";
      };
    in
    {
      imports = with inputs.self.homeModules; [
        gnome-blur-my-shell
        gnome-burn-my-windows
        gnome-caffeine
        gnome-clipboard-indicator
        gnome-compiz
        gnome-desktop-cube
        gnome-emoji-copy
        gnome-fullscreen-notifications
        gnome-just-perfection
        gnome-rawkode-tiling
        gnome-status-area-spacing
        gnome-transparent-window-moving
      ];

      gtk = {
        enable = true;

        gtk3.extraConfig = {
          gtk-decoration-layout = "menu:";
          gtk-xft-antialias = 1;
          gtk-xft-hinting = 1;
          gtk-xft-hintstyle = "hintfull";
          gtk-xft-rgba = "rgb";
          gtk-recent-files-enabled = false;
        };
      };

      dconf.settings = {
        "org/gnome/desktop/datetime" = {
          automatic-timezone = true;
        };

        "org/gnome/desktop/interface" = {
          accent-color = "teal";
          clock-show-date = false;
          enable-animations = true;
          enable-hot-corners = lib.gvariant.mkBoolean false;
          font-hinting = lib.gvariant.mkString "slight";
          font-antialiasing = lib.gvariant.mkString "rgba";
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

        "org/gnome/desktop/wm/preferences" = {
          button-layout = ":close";
          focus-mode = "sloppy";
        };

        "org/gnome/file-roller/listing" = {
          list-mode = "as-folder";
          show-path = false;
          sort-method = "name";
          sort-type = "ascending";
        };

        "org/gnome/file-roller/ui" = {
          sidebar-width = 512;
        };

        "org/gnome/mutter" = {
          dynamic-workspaces = false;
          experimental-features = [ "scale-monitor-framebuffer" ];
          num-workspaces = 4;
          overlay-key = [ ];
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
            "gsconnect@andyholmes.github.io"
            "nightthemeswitcher@romainvigier.fr"
            "space-bar@luchrioh"
            "tailscale@joaophi.github.com"
          ];

          favorite-apps = [ ];

          welcome-dialog-last-shown-version = "42.0";
        };

        "org/gnome/shell/app-switcher" = {
          current-workspace-only = true;
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

      home.packages = with pkgs.gnomeExtensions; [
        appindicator
        gsconnect
        night-theme-switcher
        space-bar
        systemd-manager
        tailscale-qs
      ];
    };
}
