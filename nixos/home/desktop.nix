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
  imports = [ inputs.anyrun.homeManagerModules.default ];

  fonts.fontconfig.enable = true;

  # xdg.configFile."ironbar/style.css" = import ./ironbar.nix { inherit inputs; };

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

    "org/gnome/shell/extensions/pop-shell" = {
      active-hint = true;
      active-hint-border-radius = mkUint32 4;
      fullscreen-launcher = true;
      mouse-cursor-follows-active-window = false;
      show-title = true;
      smart-gaps = true;
      tile-by-default = true;
    };
  };

  programs.anyrun = {
    enable = true;

    config = {
      plugins = with inputs.anyrun.packages.${pkgs.system}; [
        applications
        # randr
        rink
        shell
        symbols
      ];
      x = {
        fraction = 0.5;
      };
      y = {
        fraction = 0.3;
      };
      width = {
        fraction = 0.3;
      };
      hideIcons = false;
      ignoreExclusiveZones = false;
      layer = "overlay";
      hidePluginInfo = false;
      closeOnClick = false;
      showResultsImmediately = false;
      maxEntries = null;
    };
  };

  home.packages = (
    with pkgs;
    [
      bibata-cursors
      discord
      gnome.cheese
      gnome.gnome-tweaks
      gnomeExtensions.appindicator
      gnomeExtensions.blur-my-shell
      gnomeExtensions.paperwm
      gnomeExtensions.pop-shell
      gnomeExtensions.sound-output-device-chooser
      slack
      zoom-us
    ]
  );

  programs.wezterm = {
    enable = true;
    enableZshIntegration = true;
    extraConfig = builtins.readFile ./wezterm/wezterm.lua;
  };

  xdg.enable = true;

  programs.zellij.enable = true;
  programs.zellij.catppuccin.enable = true;

  programs.walker = {
    enable = true;
    package = pkgs.walker;
    runAsService = true;
    # style = builtins.readFile ./style.css;
    config = {
      activation_mode.use_alt = true;
      force_keyboard_focus = true;
      align = {
        anchors.top = true;
        horizontal = "center";
        vertical = "start";
        width = 500;
      };
      placeholder = "Search...";
      notify_on_fail = true;
      show_initial_entries = true;
      orientation = "vertical";
      terminal = "footclient";
      scrollbar_policy = "automatic";
      ssh_host_file = "";
      modules = [
        { name = "applications"; }
        {
          prefix = "?";
          name = "websearch";
        }
        {
          prefix = "/";
          name = "hyprland";
        }
        {
          prefix = ".";
          name = "clipboard";
        }
      ];
      external = lib.lists.singleton ({
        prefix = "!";
        name = "power";
        src = "walker-power";
      });
      icons = {
        size = 28;
        image_height = 200;
      };
      list = {
        margin_top = 10;
        height = 500;
        always_show = true;
      };
      search = { };
      clipboard = {
        image_height = 300;
        max_entries = 10;
      };
      hyprland = {
        context_aware_history = false;
      };
    };
  };

  gtk = {
    enable = true;

    catppuccin = {
      enable = true;
      flavour = catppuccin_variant;
      accent = catppuccin_accent;
      size = "standard";

      gnomeShellTheme = true;
      cursor.enable = true;
      icon.enable = true;

      tweaks = [ "normal" ];
    };
  };

  wayland.windowManager.hyprland.enable = true;
  wayland.windowManager.hyprland.settings = {
    "$mod" = "SUPER";

    "$fm" = "nautilus";
    "$browser" = "vivaldi";
    "$terminal" = "wezterm";

    env = [
      "QT_WAYLAND_DISABLE_WINDOWDECORATION,1"
      # "WLR_DRM_NO_ATOMIC,1"
    ];

    exec = [ "sleep 1; pkill ironbar; ironbar" ];
    "exec-once" = [ "${pkgs.polkit_gnome}/libexec/polkit-gnome-authentication-agent-1" ];

    bind = [
      "SUPER,SPACE,exec,walker"
      "SUPER,Return,exec,$terminal"

      # Volume keys
      ",XF86AudioLowerVolume,exec,pamixer -d 10"
      "SHIFT,XF86AudioLowerVolume,exec,pamixer --allow-boost -d 10"
      ",XF86AudioRaiseVolume,exec,pamixer -i 10"
      "SHIFT,XF86AudioRaiseVolume,exec,pamixer --allow-boost -i 10"
      ",XF86AudioMute,exec,pamixer -t"

      # Brightness keys
      ",XF86MonBrightnessUp,exec,brightnessctl s +10%"
      ",XF86MonBrightnessDown,exec,brightnessctl s 10%-"

      "SUPER,Q,killactive,"
      "SUPERSHIFT,Q,exec,hyprctl kill"

      "SUPER,F,fullscreen"
      "SUPERALT,F,fakefullscreen"
      "SUPERSHIFT,F,togglefloating,"

      "SUPER,1,exec,hyprsome workspace 1"
      "SUPER,2,exec,hyprsome workspace 2"
      "SUPER,3,exec,hyprsome workspace 3"
      "SUPER,4,exec,hyprsome workspace 4"
      "SUPER,5,exec,hyprsome workspace 5"
      "SUPER,6,exec,hyprsome workspace 6"
      "SUPER,7,exec,hyprsome workspace 7"
      "SUPER,8,exec,hyprsome workspace 8"
      "SUPER,9,exec,hyprsome workspace 9"

      "SUPERSHIFT,1,exec,hyprsome move 1"
      "SUPERSHIFT,2,exec,hyprsome move 2"
      "SUPERSHIFT,3,exec,hyprsome move 3"
      "SUPERSHIFT,4,exec,hyprsome move 4"
      "SUPERSHIFT,5,exec,hyprsome move 5"
      "SUPERSHIFT,6,exec,hyprsome move 6"
      "SUPERSHIFT,7,exec,hyprsome move 7"
      "SUPERSHIFT,8,exec,hyprsome move 8"
      "SUPERSHIFT,9,exec,hyprsome move 9"
    ];

    general = {
      gaps_in = 16;
      gaps_out = 16;
      border_size = 2;
      "col.active_border" = "rgba(88888888)";
      "col.inactive_border" = "rgba(00000088)";

      allow_tearing = true;
      resize_on_border = true;
    };

    decoration = {
      rounding = 16;
      blur = {
        enabled = true;
        brightness = 1.0;
        contrast = 1.0;
        noise = 1.0e-2;

        vibrancy = 0.2;
        vibrancy_darkness = 0.5;

        passes = 4;
        size = 7;

        popups = true;
        popups_ignorealpha = 0.2;
      };

      drop_shadow = true;
      shadow_ignore_window = true;
      shadow_offset = "0 2";
      shadow_range = 20;
      shadow_render_power = 3;
      "col.shadow" = "rgba(00000055)";
    };

    animations = {
      enabled = true;
      animation = [
        "border, 1, 2, default"
        "fade, 1, 4, default"
        "windows, 1, 3, default, popin 80%"
        "workspaces, 1, 2, default, slide"
      ];
    };

    group = {
      groupbar = {
        font_size = 16;
        gradients = false;
      };
    };

    input = {
      kb_layout = "us";

      # focus change on cursor move
      follow_mouse = 1;
      accel_profile = "flat";
      touchpad.scroll_factor = 0.1;
    };

    dwindle = {
      # keep floating dimentions while tiling
      pseudotile = true;
      preserve_split = true;
    };

    misc = {
      # disable auto polling for config file changes
      disable_autoreload = true;

      force_default_wallpaper = 0;

      # disable dragging animation
      animate_mouse_windowdragging = false;

      # enable variable refresh rate (effective depending on hardware)
      vrr = 1;

      # we do, in fact, want direct scanout
      no_direct_scanout = false;
    };

    # touchpad gestures
    gestures = {
      workspace_swipe = true;
      workspace_swipe_forever = true;
    };

    xwayland.force_zero_scaling = true;

    debug.disable_logs = false;

    plugin = {
      csgo-vulkan-fix = {
        res_w = 1280;
        res_h = 800;
        class = "cs2";
      };

      hyprbars = {
        bar_height = 20;
        bar_precedence_over_border = true;

        # order is right-to-left
        hyprbars-button = [
          # close
          "rgb(ff0000), 15, , hyprctl dispatch killactive"
          # maximize
          "rgb(ffff00), 15, , hyprctl dispatch fullscreen 1"
        ];
      };

      hyprexpo = {
        columns = 3;
        gap_size = 4;
        bg_col = "rgb(000000)";

        enable_gesture = true;
        gesture_distance = 300;
        gesture_positive = false;
      };
    };
  };
}
