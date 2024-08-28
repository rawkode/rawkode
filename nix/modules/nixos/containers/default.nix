{ pkgs, ... }:
{
  virtualisation = {
    containers = {
      enable = true;
      containersConf.settings = {
        cgroup_manager = "systemd";
        events_logger = "journald";
      };
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
