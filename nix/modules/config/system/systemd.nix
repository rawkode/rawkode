{
  flake.nixosModules.systemd = {
    systemd.settings.Manager.DefaultTimeoutStopSec = "10s";
  };
}
