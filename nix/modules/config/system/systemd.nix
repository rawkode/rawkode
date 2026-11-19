{
  flake.nixosModules.systemd = {
    systemd = {
      settings.Manager.DefaultTimeoutStopSec = "10s";
      oomd = {
        enable = true;
        enableRootSlice = true;
        enableUserSlices = true;
      };
    };

    services.journald.settings.Journal.SystemMaxUse = "1G";
  };
}
