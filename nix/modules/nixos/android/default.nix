{ config, ... }:
{
  programs.adb.enable = true;

  networking.firewall = {
    enable = true;
    allowedTCPPorts = [ 39705 ];
    allowedUDPPortRanges = [
      {
        from = 39705;
        to = 39705;
      }
    ];
  };

  networking.firewall.interfaces.${config.services.tailscale.interfaceName}.allowedTCPPorts = [
    39705
  ];
}
