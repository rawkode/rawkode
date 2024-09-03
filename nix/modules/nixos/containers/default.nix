{ pkgs, ... }:
{
  # Default on NixOS 24.11
  # systemd.enableUnifiedCgroupHierarchy = true;

  virtualisation = {
    containers = {
      enable = true;
    };

    podman = {
      enable = true;
      dockerCompat = true;
      defaultNetwork.settings.dns_enabled = true;
    };
  };

  environment.systemPackages = with pkgs; [
    dive
    docker-compose
    podman-tui
  ];
}
