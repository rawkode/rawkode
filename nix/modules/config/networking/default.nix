{
  flake.nixosModules.networking =
    { lib, ... }:
    {
      networking = {
        networkmanager.enable = lib.mkForce false;
        dhcpcd.enable = lib.mkForce false;

        useNetworkd = true;

        wireless = {
          # Force false, as we let iwd handle
          # WiFi.
          enable = lib.mkForce false;

          iwd = {
            enable = true;
            settings = {
              Network = {
                NameResolvingService = "systemd";
                EnableIPv6 = true;
              };
            };
          };
        };
      };

      networking.resolvconf.enable = lib.mkForce false;
      services.resolved = {
        enable = true;
        extraConfig = ''
          DNSStubListenerExtra=[::1]:53
        '';
        fallbackDns = [
          # Quad9
          "9.9.9.9"
          "149.112.112.112"
          "2620:fe::fe"
          "2620:fe::9"
        ];
      };
    };
}
