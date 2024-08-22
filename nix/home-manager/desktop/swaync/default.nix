{ config, pkgs, ... }:

let
  swaync-client = "${pkgs.swaynotificationcenter}/bin/swaync-client";
in
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

  programs.niri.settings.binds = with config.lib.niri.actions; {
    "Shift+Escape".action = spawn "${swaync-client}" "--close-latest";
    "Shift+Alt+Escape".action = spawn "${swaync-client}" "--close-all";
    "Super+N".action = spawn "${swaync-client}" "--toggle-panel";
    "Super+D".action = spawn "${swaync-client}" "--toggle-dnd";
  };

  wayland.windowManager.hyprland.settings = {
    bindn = [ ", escape, exec, ${swaync-client} --close-latest" ];
    bind = [
      "shift, escape, exec, ${swaync-client} --close-all"
      "$mainMod, d, exec, ${swaync-client} --toggle-dnd"
      "$mainMod, n, exec, ${swaync-client} --toggle-panel"
    ];
  };
}
