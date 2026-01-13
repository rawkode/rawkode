{
  flake.nixosModules.android =
    { config, ... }:
    {
      programs.adb.enable = true;

      # 39705 for adb
      # 39706 for rquickshare
      networking.firewall = {
        enable = true;

        trustedInterfaces = [
          "lo"
          config.services.tailscale.interfaceName
        ];

        allowedTCPPortRanges = [
          {
            from = 39705;
            to = 39706;
          }
        ];
        allowedUDPPortRanges = [
          {
            from = 39705;
            to = 39706;
          }
        ];
      };
    };
}
