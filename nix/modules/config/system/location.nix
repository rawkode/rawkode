{
  flake.nixosModules.location =
    { lib, ... }:
    {
      location.provider = "geoclue2";

      time.timeZone = lib.mkForce null;

      services = {
        avahi = {
          enable = true;
          nssmdns4 = true;
        };

        automatic-timezoned.enable = true;
        localtimed.enable = true;

        geoclue2 = {
          enable = true;
          enableDemoAgent = lib.mkForce true;
          enableWifi = true;
          enableModemGPS = true;
          enable3G = true;
          enableCDMA = true;

          appConfig.darkman = {
            desktopID = "nl.whynothugo.darkman";
            isAllowed = true;
            isSystem = false;
          };

          appConfig.automatic-timezoned = {
            isAllowed = true;
            isSystem = true;
            users = [ ];
          };
        };
      };
    };
}
