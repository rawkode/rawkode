{
  flake.nixosModules.location =
    { lib, ... }:
    {
      location.provider = "geoclue2";

      time.timeZone = lib.mkForce null;

      # nixpkgs' GeoClue module omits the mandatory GeoClue 2.8 IP source
      # settings. Reuse the Wi-Fi provider for IP-only location on desktops.
      environment.etc."geoclue/conf.d/90-ip-source.conf".text = ''
        [ip]
        enable=true
        method=ichnaea
      '';

      services = {
        avahi = {
          enable = true;
          nssmdns4 = true;
          openFirewall = true;
        };

        automatic-timezoned.enable = true;

        geoclue2 = {
          enable = true;
          enableWifi = true;
          enableModemGPS = true;
          enable3G = true;
          enableCDMA = true;
        };
      };
    };
}
