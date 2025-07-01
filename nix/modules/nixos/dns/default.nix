{ ... }:
{
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

  networking.networkmanager.dns = "systemd-resolved";
}
