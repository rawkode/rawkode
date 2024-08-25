{
  location = {
    provider = "manual";
    latitude = 55.8617;
    longitude = 4.2583;
  };

  services = {
    avahi = {
      enable = true;
      nssmdns4 = true;
    };

    geoclue2 = {
      enable = true;

      # With these all disabled, should use GeoIP
      # Everything else appears to be broken since
      # Mozilla shutdown location services and
      # I can't get beacondb to work because:
      #
      # Aug 21 11:08:17 p4x-desktop-nixos .geoclue-wrappe[10047]: Failed to query location: No WiFi networks found
      # Aug 21 11:08:26 p4x-desktop-nixos .geoclue-wrappe[10047]: Failed to query location: Query location SOUP error: Not Found
      #
      enable3G = false;
      enableCDMA = false;
      enableModemGPS = false;
      enableNmea = false;
      enableWifi = false;

      geoProviderUrl = "https://beacondb.net/v1/geolocate";

      appConfig.darkman = {
        desktopID = "nl.whynothugo.darkman";
        isAllowed = true;
        isSystem = false;
      };
    };

    localtimed.enable = true;
  };
}
