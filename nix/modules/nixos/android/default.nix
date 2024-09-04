{ config, ... }:
{
  programs.adb.enable = true;

  # 39705 for adb
  # 39706 for rquickshare
  #    -- see modules/home/rquickshare/default.nix

  networking.firewall = {
    enable = true;
    allowedTCPPorts = [ 39705 39706 ];
    allowedUDPPortRanges = [
      {
        from = 39705;
        to = 39706;
      }
    ];
  };

  networking.firewall.interfaces.${config.services.tailscale.interfaceName}.allowedTCPPorts = [
    39705 39706
  ];
}
