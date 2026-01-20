{ lib, ... }:
let
  mkApp = import ../../../lib/mkApp.nix { inherit lib; };
in
mkApp {
  name = "swww";

  linux.home =
    { pkgs, config, ... }:
    let
      wallpaper = config.stylix.image;
    in
    {
      systemd.user.services = {
        swww = {
          Unit = {
            Description = "Efficient animated wallpaper daemon for wayland";
            ConditionEnvironment = "WAYLAND_DISPLAY";
            PartOf = [ "graphical-session.target" ];
            After = [ "graphical-session-pre.target" ];
            Requisite = [ "graphical-session.target" ];
          };
          Install.WantedBy = [ "graphical-session.target" ];
          Service = {
            Type = "simple";
            ExecStart = "${pkgs.swww}/bin/swww-daemon";
            ExecStop = "${pkgs.swww}/bin/swww kill";
            Restart = "on-failure";
          };
        };

        swww-wallpaper = {
          Unit = {
            Description = "Set wallpaper via swww";
            ConditionEnvironment = "WAYLAND_DISPLAY";
            PartOf = [ "graphical-session.target" ];
            After = [ "swww.service" ];
            Wants = [ "swww.service" ];
            Requisite = [ "graphical-session.target" ];
          };
          Install.WantedBy = [ "graphical-session.target" ];
          Service = {
            Type = "oneshot";
            ExecStart = "${pkgs.swww}/bin/swww img ${wallpaper}";
            RemainAfterExit = true;
          };
        };
      };
    };
}
