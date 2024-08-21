{ pkgs, ... }:
{
  systemd.user.services.polkit-gnome-authentication-agent-1 = {
    Unit.Description = "Notifications center for sway";
    Unit.PartOf = [ "graphical-session.target" ];
    Install.WantedBy = [ "graphical-session.target" ];

    Service = {
      Type = "simple";
      ExecStart = "${pkgs.polkit_gnome}/libexec/polkit-gnome-authentication-agent-1";
      Restart = "always";
      RestartSec = "1";
      TimeoutStopSec = 10;
    };
  };
}
