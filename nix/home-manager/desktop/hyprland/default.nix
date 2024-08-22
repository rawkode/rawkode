{ pkgs, ... }:

let
  playerctl = "${pkgs.playerctl}/bin/playerctl";
  brightnessctl = "${pkgs.brightnessctl}/bin/brightnessctl";
  pactl = "${pkgs.pulseaudio}/bin/pactl";
in
{
  imports = [
    ./darkman.nix
    ./fuzzel.nix
    ./hyprlock.nix
    ./hyprpaper.nix
    ./swaync/default.nix
    ./waybar/default.nix
  ];

  home = {
    packages = with pkgs; [ grimblast ];
  };

  home.sessionVariables = {
    GDK_BACKEND = "wayland,x11";
    MOZ_ENABLE_WAYLAND = 1;
    NIXOS_OZONE_WL = 1;
    QT_QPA_PLATFORM = "wayland;xcb";
    XDG_CURRENT_DESKTOP = "Hyprland";
    XDG_SESSION_DESKTOP = "Hyprland";
    XDG_SESSION_TYPE = "wayland";
  };

  wayland.windowManager.hyprland = {
    enable = true;

    systemd = {
      enable = true;
      variables = [ "--all" ];
    };

    settings = {
      monitor = [
        "eDP-1,preferred,auto,1.333333"
        "DP-1,preferred,auto-right,1.5"
        "DP-2,preferred,auto-right,1.5"
        "DVI-I-1,preferred,auto-up,1"
      ];

      xwayland = {
        force_zero_scaling = true;
      };

      input = {
        natural_scroll = true;
        sensitivity = 0;
        numlock_by_default = true;

        follow_mouse = 1;

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
        use_active_for_splits = false;
        pseudotile = "yes";
        preserve_split = "yes";
      };

      misc = {
        disable_hyprland_logo = true;
      };

      cursor = {
        inactive_timeout = 3;
        hide_on_touch = true;
      };

      decoration = {
        rounding = 16;
        drop_shadow = true;
        dim_inactive = false;
      };

      group = {
        "col.border_active" = "$accent";

        groupbar = {
          height = 12;
          render_titles = false;
          "col.active" = "$sky";
          "col.inactive" = "rgba(89dceb55)";
        };
      };

      bind = [
        "bind = $mainMod, G, togglegroup,"

        "$mainMod, F, fullscreen, 0"
        "$mainMod, Return, exec, wezterm"

        "$mainMod, T, pseudo"
        "$mainMod, V, togglefloating,"

        "$mainMod, Q, killactive,"
        "$mainMod, W, closewindow,"

        "$mainMod, Print, exec, grimblast --notify --cursor --freeze save area ~/Pictures/$(date +'%Y-%m-%d-At-%Ih%Mm%Ss').png"

        # Move focus with mainMod + arrow keys
        "$mainMod, Page_Down, workspace, m+1"
        "$mainMod, Page_Up, workspace, m-1"

        "$mainMod, left, movefocus, l"
        "$mainMod shift, left, movewindow, l"
        "$mainMod, right, movefocus, r"
        "$mainMod shift, right, movewindow, r"
        "$mainMod, up, movefocus, u"
        "$mainMod shift, up, movewindow, u"
        "$mainMod, down, movefocus, d"
        "$mainMod shift, down, movewindow, d"

        "$mainMod, comma, changegroupactive, b"
        "$mainMod, period, changegroupactive, f"
        "$mainMod shift, comma, movegroupwindow, b"
        "$mainMod shift, period, movegroupwindow, f"

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

        # Scratchpad
        "$mainMod, Minus, togglespecialworkspace"
        "$mainMod SHIFT, Minus, movetoworkspace, special"
      ];
    };

    extraConfig = ''
      workspace = 1, persistent:true, default:true
      workspace = 2, monitor:DP-1, persistent:true
      workspace = 3, monitor:DP-1, persistent:true
      workspace = 4, monitor:DP-1, persistent:true
      workspace = 5, monitor:DP-1, persistent:true
      workspace = 6, monitor:DP-2, persistent:true, default:true
      workspace = 7, monitor:DP-2, persistent:true
      workspace = 8, monitor:DP-2, persistent:true
      workspace = 9, monitor:DP-2, persistent:true

      bindle = ,XF86MonBrightnessUp,   exec, ${brightnessctl} set +5%
      bindle = ,XF86MonBrightnessDown, exec, ${brightnessctl} set 5%-
      bindle = ,XF86KbdBrightnessUp,   exec, ${brightnessctl} -d asus::kbd_backlight set +1
      bindle = ,XF86KbdBrightnessDown, exec, ${brightnessctl} -d asus::kbd_backlight set  1-

      bindle = ,XF86AudioRaiseVolume,  exec, ${pactl} set-sink-volume @DEFAULT_SINK@ +5%
      bindle = ,XF86AudioLowerVolume,  exec, ${pactl} set-sink-volume @DEFAULT_SINK@ -5%
      bindl  = ,XF86AudioMute,         exec, ${pactl} set-mute @DEFAULT_SINK@ toggle

      bindl = ,XF86AudioPlay,    exec, ${playerctl} play-pause
      bindl = ,XF86AudioStop,    exec, ${playerctl} pause
      bindl = ,XF86AudioPause,   exec, ${playerctl} pause
      bindl = ,XF86AudioPrev,    exec, ${playerctl} previous
      bindl = ,XF86AudioNext,    exec, ${playerctl} next
    '';
  };
}
