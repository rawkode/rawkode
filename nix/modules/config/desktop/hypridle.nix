{
  flake.homeModules.hypridle =
    { pkgs, lib, ... }:
    {
      services.hypridle = {
        enable = true;
        settings = {
          general = {
            ignore_dbus_inhibit = false;
            lock_cmd = "pidof hyprlock || ${pkgs.hyprlock}/bin/hyprlock";
            before_sleep_cmd = "loginctl lock-session";
            after_sleep_cmd = ''niri msg action power-on-monitors'';
          };

          listener = [
            # Dim screen
            {
              timeout = 300; # 5 min
              on-timeout = "${pkgs.brightnessctl}/bin/brightnessctl -s set 10";
              on-resume = "${pkgs.brightnessctl}/bin/brightnessctl -r";
            }
            {
              timeout = 600; # 10 min
              on-timeout = "loginctl lock-session";
            }
            # Monitor power save
            {
              timeout = 1800; # 30 min
              on-timeout = "niri msg action power-off-monitors";
              on-resume = "niri msg action power-on-monitors";
            }
          ];
        };
      };

      # Make hypridle work with Niri
      systemd.user.services.hypridle = {
        Unit = {
          ConditionEnvironment = lib.mkForce [
            "WAYLAND_DISPLAY"
          ];
          # Start with Niri
          After = [ "graphical-session.target" ];
          PartOf = [ "graphical-session.target" ];
        };
        Install = {
          WantedBy = [ "graphical-session.target" ];
        };
      };
    };
}
