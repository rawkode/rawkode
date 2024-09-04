{ pkgs, ... }:
{
  # Default on NixOS 24.11
  systemd.enableUnifiedCgroupHierarchy = true;

  virtualisation = {
    containers = {
      enable = true;
    };

    # I keep trying podman, but
    # there are too many problems.
    docker.enable = true;
  };

  environment.systemPackages = with pkgs; [
    dive
    docker-compose
  ];
}
