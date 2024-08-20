{ hostname, pkgs, ... }:
{
  imports = [
    ./fuzzel.nix
    ./hyprlock.nix
    ./swaync.nix
    ./waybar/default.nix
  ];

  home.sessionVariables = {
    NIXOS_OZONE_WL = 1;
    MOZ_ENABLE_WAYLAND = 1;
    XDG_CURRENT_DESKTOP = "Hyprland";
    XDG_SESSION_DESKTOP = "Hyprland";
    XDG_SESSION_TYPE = "wayland";
    GDK_BACKEND = "wayland,x11";
    QT_QPA_PLATFORM = "wayland;xcb";
  };

  home = {
    packages = with pkgs; [
      grimblast
      hyprpaper
    ];
  };

  xdg.configFile."electron-flags.conf".text = ''
    --enable-features=UseOzonePlatform
    --ozone-platform=wayland
  '';

  wayland.windowManager.hyprland = {
    enable = true;
    package = pkgs.hyprland;

    catppuccin.enable = true;
    sourceFirst = true;

    # plugins = with pkgs.hyprlandPlugins; [  ];

    settings = {
      monitor = [
        "eDP-1,preferred,auto,1"
        "DP-1,preferred,auto-right,1.5"
        "DP-2,preferred,auto-right,1.5"
        "DVI-I-1,preferredm,auto-up,1"
      ];

      xwayland = {
        force_zero_scaling = true;
      };

      # exec-once = lib.concatStringsSep "&" [ "hyprpaper" ];

      input = {
        natural_scroll = true;
        sensitivity = 0;
        numlock_by_default = true;

        # click focus
        follow_mouse = 2;

        touchpad = {
          natural_scroll = "yes";
          disable_while_typing = true;
          drag_lock = true;
        };
      };

      general = {
        "$mainMod" = "SUPER";
        "col.active_border" = "$accent";

        layout = "dwindle";
        gaps_in = 16;
        gaps_out = 16;
        border_size = 2;
      };

      dwindle = {
        no_gaps_when_only = false;
        force_split = 0;
        split_width_multiplier = 1.0;
        use_active_for_splits = true;
        pseudotile = "yes";
        preserve_split = "yes";
      };

      misc = {
        disable_hyprland_logo = false;
      };

      cursor = {
        inactive_timeout = 3;
        hide_on_touch = true;
      };

      decoration = {
        rounding = 8;
      };

      group = {
        "col.border_active" = "$accent";

        groupbar = {
          height = 8;
          render_titles = false;
          "col.active" = "$accent";
          "col.inactive" = "rgba(8839ef55)";
        };
      };

      bind = [
        "bind = $mainMod, G, togglegroup,"
        "$mainMod, F, fullscreen, 0"
        "$mainMod, Return, exec, wezterm"
        "$mainMod, V, togglefloating,"
        "$mainMod, Q, killactive,"

        "$mainMod SHIFT, Q, exec, swaynag -t warning -m 'You pressed the exit shortcut. Do you really want to exit Hyprland? This will end your Wayland session.' -b 'Yes, exit' 'hyprctl dispatch exit'"

        "$mainMod, Print, exec, grimblast --notify --cursor --freeze save area ~/Pictures/$(date +'%Y-%m-%d-At-%Ih%Mm%Ss').png"

        # Move focus with mainMod + arrow keys
        "$mainMod, left, movefocus, l"
        "$mainMod, right, movefocus, r"
        "$mainMod, up, movefocus, u"
        "$mainMod, down, movefocus, d"

        "$mainMod, Page_Up, changegroupactive, b"
        "$mainMod, Page_Down, changegroupactive, f"
        "$mainMod shift, Page_Up, movegroupwindow, b"
        "$mainMod shift, Page_Down, movegroupwindow, f"

        # Switch workspaces with mainMod + [0-9]
        "$mainMod, 1, workspace, 1"
        "$mainMod, 2, workspace, 2"
        "$mainMod, 3, workspace, 3"
        "$mainMod, 4, workspace, 4"
        "$mainMod, 5, workspace, 5"
        "$mainMod, 6, workspace, 6"
        "$mainMod, 7, workspace, 7"
        "$mainMod, 8, workspace, 8"
        "$mainMod, 9, workspace, 9"

        # Move active window to a workspace with mainMod + SHIFT + [0-9]
        "$mainMod SHIFT, 1, movetoworkspace, 1"
        "$mainMod SHIFT, 2, movetoworkspace, 2"
        "$mainMod SHIFT, 3, movetoworkspace, 3"
        "$mainMod SHIFT, 4, movetoworkspace, 4"
        "$mainMod SHIFT, 5, movetoworkspace, 5"
        "$mainMod SHIFT, 6, movetoworkspace, 6"
        "$mainMod SHIFT, 7, movetoworkspace, 7"
        "$mainMod SHIFT, 8, movetoworkspace, 8"
        "$mainMod SHIFT, 9, movetoworkspace, 9"
        "$mainMod SHIFT, 0, movetoworkspace, 10"

        # Scratchpad
        "$mainMod, Minus, togglespecialworkspace"
        "$mainMod SHIFT, Minus, movetoworkspace, special"
      ];
    };
  };

    extraConfig = ''
      workspace = 1, monitor:DP-1, persistent:true, default:true
      workspace = 2, monitor:DP-1, persistent:true
      workspace = 3, monitor:DP-1, persistent:true
      workspace = 4, monitor:DP-1, persistent:true
      workspace = 5, monitor:DP-1, persistent:true
      workspace = 6, monitor:DP-2, persistent:true, default:true
      workspace = 7, monitor:DP-2, persistent:true
      workspace = 8, monitor:DP-2, persistent:true
      workspace = 9, monitor:DP-2, persistent:true
    '';
  };
}
