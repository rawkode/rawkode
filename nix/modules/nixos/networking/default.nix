{ ... }:
{
  services.resolved = {
    enable = true;
    # dnsovertls = "opportunistic";
  };

  networking = {
    networkmanager = {
      enable = true;
      dns = "systemd-resolved";
    };

    nameservers = [
      "9.9.9.9"
      "149.112.112.112"
    ];
  };
}
