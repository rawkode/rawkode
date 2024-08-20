{ lib, pkgs, ... }:
{
  imports = [
    ./fuzzel.nix
    ./hyprlock.nix
    ./swaync.nix
    ./waybar.nix
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
      nwg-displays
    ];
  };

  xdg.configFile."electron-flags.conf".text = ''
    --enable-features=UseOzonePlatform
    --ozone-platform=wayland
  '';

  xdg.portal = {
    enable = true;

    xdgOpenUsePortal = true;

    config = {
      common = {
        default = [ "hyprland" ];
      };
      hyprland = {
        default = [
          "gtk"
          "hyprland"
        ];
      };
    };

    extraPortals = with pkgs; [
      xdg-desktop-portal-gtk
      xdg-desktop-portal-hyprland
    ];

  };

  wayland.windowManager.hyprland = {
    enable = true;
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

      exec-once = lib.concatStringsSep "&" [ "hyprpaper" ];

      input = {
        natural_scroll = true;
        sensitivity = 0;
        # click focus
        follow_mouse = 2;
        numlock_by_default = true;

        touchpad = {
          natural_scroll = "yes";
          disable_while_typing = true;
          drag_lock = true;
        };
      };

      general = {
        "$mainMod" = "SUPER";

        layout = "dwindle";

        "col.active_border" = "$accent";

        gaps_in = 16;
        gaps_out = 16;

        border_size = 2;
        border_part_of_window = true;
        no_border_on_floating = false;
      };

      dwindle = {
        no_gaps_when_only = false;
        force_split = 0;
        special_scale_factor = 1.0;
        split_width_multiplier = 1.0;
        use_active_for_splits = true;
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

        blur = {
          enabled = true;
          size = 16;
          passes = 2;
          ignore_opacity = true;
          noise = 0;
          new_optimizations = true;
          xray = true;
        };
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

      windowrule = [
        "float,title:^(Firefox — Sharing Indicator)$"
        "move 50%-38 100%-32,title:^(Firefox — Sharing Indicator)$"
        "pin,title:^(Firefox — Sharing Indicator)$"
        "float,title:^(MainPicker)$"
      ];

      bind = [
        "$mainMod, F1, exec, show-keybinds"
        "bind = $mainMod, G, togglegroup,"
        "$mainMod, F, fullscreen, 0"
        "$mainMod, Return, exec, wezterm"
        "$mainMod, Q, killactive,"
        "$mainMod SHIFT, Q, exec, swaynag -t warning -m 'You pressed the exit shortcut. Do you really want to exit Hyprland? This will end your Wayland session.' -b 'Yes, exit' 'hyprctl dispatch exit'"
        "$mainMod, V, togglefloating,"

        "$mainMod, Print, exec, grimblast --notify --cursor --freeze save area ~/Pictures/$(date +'%Y-%m-%d-At-%Ih%Mm%Ss').png"

        # Move focus with mainMod + arrow keys
        "$mainMod, left, movefocus, l"
        "$mainMod, right, movefocus, r"
        "$mainMod, up, movefocus, u"
        "$mainMod, down, movefocus, d"

        "$mainMod, Page_Up, changegroupactive, b"
        "$mainMod, Page_Down, changegroupactive, f"

        # Switch workspaces with mainMod + [0-9]
        "$mainMod, 1, moveworkspacetomonitor, 1 current"
        "$mainMod, 1, workspace, 1"
        "$mainMod, 2, moveworkspacetomonitor, 2 current"
        "$mainMod, 2, workspace, 2"
        "$mainMod, 3, moveworkspacetomonitor, 3 current"
        "$mainMod, 3, workspace, 3"
        "$mainMod, 4, moveworkspacetomonitor, 4 current"
        "$mainMod, 4, workspace, 4"
        "$mainMod, 5, moveworkspacetomonitor, 5 current"
        "$mainMod, 5, workspace, 5"
        "$mainMod, 6, moveworkspacetomonitor, 6 current"
        "$mainMod, 6, workspace, 6"
        "$mainMod, 7, moveworkspacetomonitor, 7 current"
        "$mainMod, 7, workspace, 7"
        "$mainMod, 8, moveworkspacetomonitor, 8 current"
        "$mainMod, 8, workspace, 8"
        "$mainMod, 9, moveworkspacetomonitor, 9 current"
        "$mainMod, 9, workspace, 9"
        "$mainMod, 0, moveworkspacetomonitor, 10 current"
        "$mainMod, 0, workspace, 10"

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

        # Scroll through existing workspaces with mainMod + scroll
        "$mainMod, mouse_down, workspace, e+1"
        "$mainMod, mouse_up, workspace, e-1"

        # Scratchpad
        "$mainMod, Minus, togglespecialworkspace"
        "$mainMod SHIFT, Minus, movetoworkspace, special"
      ];
      bindn = [ ",Print, exec, grimblast --notify --cursor --freeze copy area" ];
      bindm = [
        "$mainMod, mouse:272, movewindow"
        "$mainMod, mouse:273, resizewindow"
      ];
    };

    extraConfig = ''
      # # Move focus with mainMod + arrow keys
      # bind = $mainMod, left, scroller:movefocus, l
      # bind = $mainMod, right, scroller:movefocus, r
      # bind = $mainMod, up, scroller:movefocus, u
      # bind = $mainMod, down, scroller:movefocus, d
      # bind = $mainMod, home, scroller:movefocus, begin
      # bind = $mainMod, end, scroller:movefocus, end

      # # Movement
      # bind = $mainMod CTRL, left, scroller:movewindow, l
      # bind = $mainMod CTRL, right, scroller:movewindow, r
      # bind = $mainMod CTRL, up, scroller:movewindow, u
      # bind = $mainMod CTRL, down, scroller:movewindow, d
      # bind = $mainMod CTRL, home, scroller:movewindow, begin
      # bind = $mainMod CTRL, end, scroller:movewindow, end

      # # Modes
      # bind = $mainMod, bracketleft, scroller:setmode, row
      # bind = $mainMod, bracketright, scroller:setmode, col

      # # Sizing keys
      # bind = $mainMod, equal, scroller:cyclesize, next
      # bind = $mainMod, minus, scroller:cyclesize, prev

      # # Admit/Expel
      # bind = $mainMod, I, scroller:admitwindow,
      # bind = $mainMod, O, scroller:expelwindow,

      # Center submap
      # will switch to a submap called center
      bind = $mainMod, C, submap, center
      # will start a submap called "center"
      submap = center
      # sets repeatable binds for resizing the active window
      # bind = , C, scroller:alignwindow, c
      bind = , C, submap, reset
      # bind = , right, scroller:alignwindow, r
      bind = , right, submap, reset
      # bind = , left, scroller:alignwindow, l
      bind = , left, submap, reset
      # bind = , up, scroller:alignwindow, u
      bind = , up, submap, reset
      # bind = , down, scroller:alignwindow, d
      bind = , down, submap, reset
      # use reset to go back to the global submap
      bind = , escape, submap, reset
      # will reset the submap, meaning end the current one and return to the global one
      submap = reset

      # Resize submap
      # will switch to a submap called resize
      bind = $mainMod SHIFT, R, submap, resize
      # will start a submap called "resize"
      submap = resize
      # sets repeatable binds for resizing the active window
      binde = , right, resizeactive, 100 0
      binde = , left, resizeactive, -100 0
      binde = , up, resizeactive, 0 -100
      binde = , down, resizeactive, 0 100
      # use reset to go back to the global submap
      bind = , escape, submap, reset
      # will reset the submap, meaning end the current one and return to the global one
      submap = reset

      # Fit size submap
      # will switch to a submap called fitsize
      bind = $mainMod, W, submap, fitsize
      # will start a submap called "fitsize"
      submap = fitsize
      # sets binds for fitting columns/windows in the screen
      # bind = , W, scroller:fitsize, visible
      bind = , W, submap, reset
      # bind = , right, scroller:fitsize, toend
      bind = , right, submap, reset
      # bind = , left, scroller:fitsize, tobeg
      bind = , left, submap, reset
      # bind = , up, scroller:fitsize, active
      bind = , up, submap, reset
      # bind = , down, scroller:fitsize, all
      bind = , down, submap, reset
      # use reset to go back to the global submap
      bind = , escape, submap, reset
      # will reset the submap, meaning end the current one and return to the global one
      submap = reset

      # overview keys
      # bind key to toggle overview (normal)
      # bind = $mainMod, tab, scroller:toggleoverview
      # overview submap
      # will switch to a submap called overview
      bind = $mainMod, tab, submap, overview
      # will start a submap called "overview"
      submap = overview
      # bind = , right, scroller:movefocus, right
      # bind = , left, scroller:movefocus, left
      # bind = , up, scroller:movefocus, up
      # bind = , down, scroller:movefocus, down
      # use reset to go back to the global submap
      # bind = , escape, scroller:toggleoverview,
      bind = , escape, submap, reset
      # bind = , return, scroller:toggleoverview,
      bind = , return, submap, reset
      # bind = $mainMod, tab, scroller:toggleoverview,
      bind = $mainMod, tab, submap, reset
      # will reset the submap, meaning end the current one and return to the global one
      submap = reset

      # Marks
      bind = $mainMod, M, submap, marksadd
      submap = marksadd
      # bind = , a, scroller:marksadd, a
      bind = , a, submap, reset
      # bind = , b, scroller:marksadd, b
      bind = , b, submap, reset
      # bind = , c, scroller:marksadd, c
      bind = , c, submap, reset
      bind = , escape, submap, reset
      submap = reset

      bind = $mainMod SHIFT, M, submap, marksdelete
      submap = marksdelete
      # bind = , a, scroller:marksdelete, a
      bind = , a, submap, reset
      # bind = , b, scroller:marksdelete, b
      bind = , b, submap, reset
      # bind = , c, scroller:marksdelete, c
      bind = , c, submap, reset
      bind = , escape, submap, reset
      submap = reset

      bind = $mainMod, apostrophe, submap, marksvisit
      submap = marksvisit
      # bind = , a, scroller:marksvisit, a
      bind = , a, submap, reset
      # bind = , b, scroller:marksvisit, b
      bind = , b, submap, reset
      # bind = , c, scroller:marksvisit, c
      bind = , c, submap, reset
      bind = , escape, submap, reset
      submap = reset

      # bind = $mainMod CTRL, M, scroller:marksreset
    '';
  };
}
