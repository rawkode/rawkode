{ ... }:
{
  networking = {
    networkmanager = {
      enable = true;
      dns = "systemd-resolved";
    };

    nameservers = [
      "1.1.1.1"
      "1.0.0.1"
    ];
  };
}
