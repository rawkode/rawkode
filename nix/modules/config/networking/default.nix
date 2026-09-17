{
  flake.nixosModules.networking =
    { lib, ... }:
    {
      networking = {
        networkmanager.enable = lib.mkForce false;
        dhcpcd.enable = lib.mkForce false;

        useNetworkd = true;

      };

      networking.resolvconf.enable = lib.mkForce false;
      services.resolved = {
        enable = true;
        settings.Resolve.FallbackDNS = [
          # Quad9
          "9.9.9.9"
          "149.112.112.112"
          "2620:fe::fe"
          "2620:fe::9"
        ];
      };
    };
}
