{ config, lib, ... }:

let
  cfg = config.networking.customDns;
in
{
  options.networking.customDns = {
    enable = lib.mkEnableOption "custom DNS configuration";
    
    extraHosts = lib.mkOption {
      type = lib.types.lines;
      default = "";
      description = "Additional entries for /etc/hosts";
    };
  };

  config = lib.mkIf cfg.enable {
    # Custom hosts entries
    networking.extraHosts = ''
      ${cfg.extraHosts}
    '';

    # systemd-resolved configuration with Cloudflare and Quad9 DNS
    services.resolved = {
      enable = true;
      dnssec = "true";
      domains = [ "~." ];
      fallbackDns = [
        "1.1.1.1"
        "2606:4700:4700::1111"
        "1.1.1.2"
        "2606:4700:4700::1112"
        "1.0.0.1"
        "2606:4700:4700::1001"
        "1.0.0.2"
        "2606:4700:4700::1002"
        "9.9.9.9"
      ];
      dnsovertls = "opportunistic";
    };

    # Disable NetworkManager's DNS handling to use systemd-resolved
    networking.networkmanager.dns = "systemd-resolved";
  };
}