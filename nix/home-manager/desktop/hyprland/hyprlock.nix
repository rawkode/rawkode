{ lib, pkgs, ... }:
{
  programs = {
    hyprlock = {
      enable = true;
      settings = {
        general = {
          grace = 300;
          disable_loading_bar = true;
          hide_cursor = true;
          no_fade_in = false;
        };

        background = [
          {
            path = "screenshot";
            blur_passes = 2;
            blur_size = 4;
          }
        ];

        input-field = [
          {
            size = "720, 108";
            outer_color = "rgba(147, 153, 178, 1.0)";
            font_color = "rgba(127, 132, 156, 1.0)";
            placeholder_text = " ... ";
          }
        ];

        label = [
          {
            text = "🏴󠁧󠁢󠁳󠁣󠁴󠁿";
            color = "rgba(249, 226, 175, 1.0)";
            font_family = "Monaspace Krypton";
            font_size = 192;
            text_align = "center";
            halign = "center";
            valign = "center";
            position = "0, 300";
          }
          {
            text = "$TIME";
            color = "rgba(205, 214, 244, 1.0)";
            font_family = "Monaspace Krypton";
            font_size = 96;
            text_align = "center";
            halign = "center";
            valign = "center";
            position = "0, -250";
          }
        ];
      };
    };
  };

  services = {
    hypridle = {
      enable = true;
      settings = {
        general = {
          lock_cmd = "${lib.getExe pkgs.hyprlock}";
          before_sleep_cmd = "${lib.getExe pkgs.hyprlock}";
        };
        listener = [
          {
            timeout = 300;
            on-timeout = "${lib.getExe pkgs.hyprlock}";
          }
          {
            timeout = 305;
            on-timeout = "${pkgs.hyprland}/bin/hyprctl dispatch dpms off";
            on-resume = "${pkgs.hyprland}/bin/hyprctl dispatch dpms on";
          }
        ];
      };
    };
  };

  wayland.windowManager.hyprland = {
    settings = {
      bind = [ "$mainMod, L, exec, ${lib.getExe pkgs.hyprlock} --immediate" ];
    };
  };
}
