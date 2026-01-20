{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "swaync";

  linux.home =
    { pkgs, ... }:
    {
      systemd.user.services.swaync = {
        Unit = {
          Description = "SwayNotificationCenter";
          Documentation = "https://github.com/ErikReider/SwayNotificationCenter";
          ConditionEnvironment = "WAYLAND_DISPLAY";
          PartOf = [ "graphical-session.target" ];
          After = [ "graphical-session-pre.target" ];
          Requisite = [ "graphical-session.target" ];
        };

        Service = {
          Type = "simple";
          ExecStart = "${pkgs.swaynotificationcenter}/bin/swaync";
          Restart = "on-failure";
          RestartSec = "1s";
        };

        Install = {
          WantedBy = [ "graphical-session.target" ];
        };
      };

      xdg.configFile."swaync/config.json".source = ./config.json;
    };
}
