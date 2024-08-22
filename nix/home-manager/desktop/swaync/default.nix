{ pkgs, ... }:
{
  home.packages = [ pkgs.swaynotificationcenter ];

  xdg.configFile."swaync/style.css".source = ./style.css;

  systemd.user.services.swaync = {
    Unit.Description = "Notifications center for sway";
    Unit.PartOf = [ "graphical-session.target" ];
    Install.WantedBy = [ "graphical-session.target" ];
    Service = {
      ExecStart = "${pkgs.swaynotificationcenter}/bin/swaync";
      Restart = "always";
      RestartSec = "3";
    };
  };

  wayland.windowManager.hyprland.settings =
    let
      swaync-client = "${pkgs.swaynotificationcenter}/bin/swaync-client";
    in
    {
      bindn = [ ", escape, exec, ${swaync-client} --close-latest" ];
      bind = [
        "shift, escape, exec, ${swaync-client} --close-all"
        "$mainMod, d, exec, ${swaync-client} --toggle-dnd"
        "$mainMod, n, exec, ${swaync-client} --toggle-panel"
      ];
    };
}
