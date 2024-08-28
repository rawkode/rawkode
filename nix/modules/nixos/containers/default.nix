{ pkgs, ... }:
{
  virtualisation = {
    containers.enable = true;

    lxc.enable = true;
    lxd.enable = true;

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
